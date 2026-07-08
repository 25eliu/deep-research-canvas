// Query-composition strategy seam. graphStrategy = the graph-grounded behavior:
// a DETERMINISTIC availability list (graphSearch + graphRelated, parsed verbatim from
// the API JSON) handed to ONE compose LLM call that picks from it and words the queries,
// enforced by a deterministic cites-a-listed-metric guard. searchStrategy skips the
// graph and composes queries directly from the sub-question. research.ts calls
// ctx.strategy at its two query-composition sites; nothing else differs between providers.
import type { ResearchCtx } from "./research";
import type { GraphCallRecord } from "../shared/types";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zQueries } from "../shared/schemas";
import { graphSearch, graphRelated, type GraphNode, type GraphItem } from "./graph";
import { diversifyQueries } from "./queries";
import {
  COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM,
  SEARCH_LEAF_COMPOSE_SYSTEM, SEARCH_BROAD_COMPOSE_SYSTEM,
} from "./prompts";

const OPENAI = "openai" as const;
export const LEAF_QUERY_CAP = 3; // 1-3 independent searches per sub-question

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface QueryPlan {
  queries: string[];
  // Resolved entity rows plus (when the metric-typed search hit) one kind:"metric" row
  // listing the standalone series — both render under the trace's "graph resolved".
  graph: { entity: string; related: string[]; kind?: "entity" | "metric" }[];
  // Planner metrics enriched with canonical names the graph's metric search confirmed
  // (graphStrategy only; searchStrategy is graph-free and leaves it unset).
  metrics?: string[];
  // Raw graph API calls (exact params + response) — trace drill-down for debugging.
  graphCalls?: GraphCallRecord[];
  // Wall-clock ms the whole graph phase took for this node (search + related + discovery).
  graphMs?: number;
}

export interface QueryStrategy {
  // nodeId (when given) lets the graph phase stream each raw graph call live onto
  // that research node's trace row ("graph_call" events).
  leafQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[], nodeId?: string): Promise<QueryPlan>;
  broadQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[], nodeId?: string): Promise<QueryPlan>;
}

interface ResolvedEntity {
  entity: string; node: string;
  related: { name: string; aliases: string[]; description?: string }[];
}

const GRAPH_RESULT_DESC_CAP = 160; // trace drill-down keeps descriptions readable, not huge

function compactResult(n: GraphNode | GraphItem): GraphCallRecord["results"][number] {
  return {
    id: n.id, name: n.name,
    ...("type" in n && n.type ? { type: n.type } : {}),
    ...("subtype" in n && n.subtype ? { subtype: n.subtype } : {}),
    ...(n.aliases?.length ? { aliases: n.aliases } : {}),
    ...(n.description ? { description: n.description.slice(0, GRAPH_RESULT_DESC_CAP) } : {}),
  };
}

// graphSearch/graphRelated, with the EXACT request params and (compacted) response
// recorded into `rec` — the trace's per-node drill-down for graph-call debugging —
// and mirrored live via `onCall` (→ a "graph_call" event) so the streaming trace
// shows graph activity as it happens. Failures are recorded too, then rethrown.
async function recordedSearch(
  rec: GraphCallRecord[], q: string, opts: { types: "entity" | "metric"; subtype?: string; limit?: number },
  onCall?: (c: GraphCallRecord) => void,
): Promise<GraphNode[]> {
  const params = { q, types: opts.types, ...(opts.subtype ? { subtype: opts.subtype } : {}), limit: opts.limit ?? 5 };
  const t = Date.now();
  try {
    const nodes = await graphSearch(q, opts);
    const call: GraphCallRecord = { endpoint: "graph/search", params, ms: Date.now() - t, results: nodes.map(compactResult) };
    rec.push(call);
    onCall?.(call);
    return nodes;
  } catch (e: unknown) {
    const call: GraphCallRecord = { endpoint: "graph/search", params, ms: Date.now() - t, results: [], error: errorMessage(e) };
    rec.push(call);
    onCall?.(call);
    throw e;
  }
}

async function recordedRelated(
  rec: GraphCallRecord[], nodeId: string, opts: { relationType: "entity" | "metric"; q?: string; limit?: number },
  onCall?: (c: GraphCallRecord) => void,
): Promise<GraphItem[]> {
  const q = opts.q?.trim();
  const params = { node_id: nodeId, relation_type: opts.relationType, ...(q ? { q } : {}), limit: opts.limit ?? 6 };
  const t = Date.now();
  try {
    const items = await graphRelated(nodeId, opts);
    const call: GraphCallRecord = { endpoint: "graph/related", params, ms: Date.now() - t, results: items.map(compactResult) };
    rec.push(call);
    onCall?.(call);
    return items;
  } catch (e: unknown) {
    const call: GraphCallRecord = { endpoint: "graph/related", params, ms: Date.now() - t, results: [], error: errorMessage(e) };
    rec.push(call);
    onCall?.(call);
    throw e;
  }
}

function dedupeCi(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((s) => {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Graph budget per research node — DETERMINISTIC by construction: the decompose step
// emits a validated PAIR (one entity term + one metric term), so the graph phase is
// exactly TWO searches (entity term → entity namespace, metric term → metric namespace),
// then related fan-out on the TOP 2 results of each — always relation_type=metric.
// Entity nodes get the hint (q=metric term) + no-q full-menu retry; metric nodes get one
// bounded sibling fetch each. Worst case 2 searches + 6 related per node.
const ENTITY_NODES_PER_TERM = 2;     // top entity-search results that each get a metric menu
const METRIC_NODES_PER_TERM = 2;     // top metric-search results kept as standalone series
const METRIC_SEARCH_LIMIT = 3;       // metric-namespace search size (top 2 fan out)
const METRIC_SIBLING_LIMIT = 10;     // related siblings fetched per metric node (bounded)
const METRIC_DISCOVERY_POOL_CAP = 6; // standalone candidates handed to the composer

// Same shape as ResolvedEntity.related items — the LLM filter consumes both.
interface MetricDetail { name: string; aliases: string[]; description?: string }

// Resolve the metric term against the graph's METRIC namespace: the planner's guess
// ("revenue") becomes canonical Tako series ("Total Revenue", "Revenue Growth"), and each
// top node's related siblings (co-table series) enrich the pool. Namespace-segregated:
// the metric term is ONLY searched here, never as an entity — and vice versa.
// Failures are notes, never throws.
async function discoverMetrics(
  ctx: ResearchCtx, rec: GraphCallRecord[], term?: string, onCall?: (c: GraphCallRecord) => void,
): Promise<MetricDetail[]> {
  if (!term) return [];
  let nodes: GraphNode[] = [];
  try {
    nodes = await recordedSearch(rec, term, { types: "metric", limit: METRIC_SEARCH_LIMIT }, onCall);
  } catch (e: unknown) {
    ctx.notes.push(`metric graph search failed for "${term}" — ${errorMessage(e)}`);
    return [];
  }
  const top = nodes.slice(0, METRIC_NODES_PER_TERM);
  const siblingsPerNode = await Promise.all(
    top.map(async (n) => {
      try {
        return await recordedRelated(rec, n.id, { relationType: "metric", limit: METRIC_SIBLING_LIMIT }, onCall);
      } catch (e: unknown) {
        ctx.notes.push(`metric related fetch failed for "${n.name}" — ${errorMessage(e)}`);
        return [];
      }
    }),
  );
  // Pool: the search hits themselves lead (they matched the term), then siblings
  // round-robin so each node's top sibling enters before any node's 2nd.
  const seen = new Set<string>();
  const out: MetricDetail[] = [];
  const add = (d: { name: string; aliases?: string[]; description?: string }) => {
    const k = d.name.trim().toLowerCase();
    if (!k || seen.has(k) || out.length >= METRIC_DISCOVERY_POOL_CAP) return;
    seen.add(k);
    out.push({ name: d.name, aliases: d.aliases || [], description: d.description });
  };
  for (const n of top) add(n);
  for (let rank = 0; out.length < METRIC_DISCOVERY_POOL_CAP; rank++) {
    const row = siblingsPerNode.map((sibs) => sibs[rank]).filter((s): s is GraphItem => Boolean(s));
    if (row.length === 0) break;
    for (const d of row) add(d);
  }
  return out;
}

interface ResolvedGraph {
  resolved: ResolvedEntity[];
  discovered: MetricDetail[]; // standalone series the metric-typed search surfaced
  // Planner metrics + graph-confirmed canonical names, CI-deduped, planner terms first.
  metrics: string[];
  graphCalls: GraphCallRecord[]; // every raw graph call made resolving this node
  graphMs: number; // wall-clock of the whole graph phase for this node
}

// The deterministic pair lookup: ONE entity-namespace search for the entity term and ONE
// metric-namespace search for the metric term (never crossed), then related fan-out on the
// TOP 2 results of each — all relation_type=metric. Both top entity nodes become resolved
// rows: keyword search can rank a junk node first ("Apple" → "Apples" the fruit above
// "Apple Inc."), and giving the composer BOTH menus lets it ignore the wrong one.
async function resolveGraph(ctx: ResearchCtx, entities: string[], metrics: string[], researchNodeId?: string): Promise<ResolvedGraph> {
  const t = Date.now();
  const out: ResolvedEntity[] = [];
  const graphCalls: GraphCallRecord[] = [];
  // Mirror each graph call live onto the issuing research node's trace row.
  const onCall = researchNodeId && ctx.emit
    ? (call: GraphCallRecord) => ctx.emit!({ type: "graph_call", nodeId: researchNodeId, call })
    : undefined;
  const entityTerm = entities.map((e) => e.trim()).filter(Boolean)[0];
  const metricTerm = metrics.map((m) => m.trim()).filter(Boolean)[0];
  // Metric side runs concurrently with the entity side below.
  const discovery = discoverMetrics(ctx, graphCalls, metricTerm, onCall);
  if (entityTerm) {
    try {
      const nodes = await recordedSearch(graphCalls, entityTerm, { types: "entity" }, onCall);
      if (nodes.length === 0) ctx.notes.push(`No graph node for "${entityTerm}"`);
      await Promise.all(
        nodes.slice(0, ENTITY_NODES_PER_TERM).map(async (node) => {
          try {
            ctx.resolved.push({ query: entityTerm, node: node.name });
            // Filter the node's metrics by the SHORT metric term only (e.g. "revenue",
            // "price"). NEVER by the whole question or the entity name — Tako's /related
            // ranks against metric NAMES, so a sentence/entity-name matches nothing and
            // returns 0 even when the node has hundreds of metrics.
            let items = await recordedRelated(graphCalls, node.id, { relationType: "metric", q: metricTerm, limit: metricTerm ? 8 : 40 }, onCall);
            if (items.length === 0 && metricTerm) {
              // The term was too specific to match — fetch the full (bounded) menu and let
              // the compose LLM pick. The safety net that surfaces what Tako actually has.
              items = await recordedRelated(graphCalls, node.id, { relationType: "metric", limit: 40 }, onCall);
            }
            ctx.related.push({ node: node.name, items: items.map((i) => i.name) });
            out.push({ entity: node.name, node: node.id, related: items.map((i) => ({ name: i.name, aliases: i.aliases || [], description: i.description })) });
          } catch (e: unknown) {
            ctx.notes.push(`graph lookup failed for "${node.name}" — ${errorMessage(e)}`);
          }
        }),
      );
    } catch (e: unknown) {
      ctx.notes.push(`graph lookup failed for "${entityTerm}" — ${errorMessage(e)}`);
    }
  }
  const discovered = await discovery;
  const names = discovered.map((d) => d.name);
  if (names.length) ctx.notes.push(`graph metric search confirmed: ${names.join(", ")}`);
  const graphMs = Date.now() - t;
  ctx.timings.graph = Math.max(ctx.timings.graph, graphMs);
  return { resolved: out, discovered, metrics: dedupeCi([...metrics, ...names]), graphCalls, graphMs };
}

const includesCi = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase());

function dedupeWords(s: string): string {
  const seen = new Set<string>();
  return s
    .split(/\s+/)
    .filter((w) => { const k = w.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .join(" ");
}

// ---- moved verbatim from research.ts (fallbackQueries) ----
export function fallbackQueries(entities: string[], metrics: string[]): string[] {
  const ents = entities.map((e) => e.trim()).filter(Boolean);
  const mets = metrics.map((m) => m.trim()).filter(Boolean);
  const subjects = ents.filter((e) => !mets.some((m) => includesCi(m, e)));
  const use = subjects.length ? subjects : ents;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mets) {
    for (const e of use) {
      if (includesCi(m, e) || includesCi(e, m)) continue;
      const q = dedupeWords(`${e} ${m}`);
      const k = q.toLowerCase();
      if (q && !seen.has(k)) { seen.add(k); out.push(q); }
    }
  }
  return out.slice(0, LEAF_QUERY_CAP);
}

const METRICS_PER_ENTITY_IN_PROMPT = 10; // top related metrics (popularity order) shown per entity

// One line per metric: name [aliases] — description. This IS the deterministic
// availability list — verbatim graph output, only truncated for prompt size.
function metricLines(metrics: MetricDetail[]): string {
  return metrics
    .map((m) => `${m.name} [${m.aliases.join(", ")}]${m.description ? ` — ${m.description.slice(0, 120)}` : ""}`)
    .join("; ");
}

// Deterministic grounding guard: a composed query survives ONLY if it cites a listed
// metric/series verbatim (name or alias, CI). The LLM picks and words — it cannot
// invent availability.
function citesListedMetric(query: string, listed: MetricDetail[]): boolean {
  const lq = query.toLowerCase();
  return listed.some(
    (m) => lq.includes(m.name.toLowerCase()) || m.aliases.some((a) => a && lq.includes(a.toLowerCase())),
  );
}

// Deterministic single-entity guard: Tako /v3/search handles multi-entity questions poorly,
// so a composed query naming 2+ resolved entities is dropped. When every query is dropped,
// the fallbackQueries ladder recovers with per-entity×metric pairs by construction.
// Textually overlapping node names ("Tesla" ⊂ "Tesla, Inc." — the top-2 hits for one term
// are often variants of the same subject) count as ONE entity, not two.
function namesMultipleEntities(query: string, resolved: ResolvedEntity[]): boolean {
  const lq = query.toLowerCase();
  const named = Array.from(new Set(
    resolved.map((r) => r.entity.trim().toLowerCase()).filter((e) => e && lq.includes(e)),
  ));
  const distinct = named.filter((e) => !named.some((o) => o !== e && o.includes(e)));
  return distinct.length >= 2;
}

// The leaf's query composition: ONE grounded-compose LLM call over the deterministic
// availability list (resolved entities + their related metrics + standalone series),
// guard-checked; then the mechanical fallback ladder for the no-material/failed cases.
async function groundedQueries(
  ctx: ResearchCtx, question: string, resolved: ResolvedEntity[],
  entities: string[] = [], metrics: string[] = [], discovered: MetricDetail[] = [],
): Promise<string[]> {
  const queries: string[] = [];
  const withRelated = resolved.filter((r) => r.related.length > 0);
  for (const r of resolved) {
    if (r.related.length === 0) ctx.notes.push(`Tako has no related metrics for "${r.entity}"`);
  }
  if (withRelated.length || discovered.length) {
    const resolvedBlock = [
      ...withRelated.map((r) => `${r.entity}: ${metricLines(r.related.slice(0, METRICS_PER_ENTITY_IN_PROMPT))}`),
      ...(discovered.length ? [`Standalone series: ${metricLines(discovered)}`] : []),
    ].join("\n");
    try {
      const composed = await generateStructured({
        provider: OPENAI, system: COMPOSE_SYSTEM,
        prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}\n\nRESOLVED:\n${resolvedBlock}`,
        schema: zQueries, label: "grounded-compose",
      });
      const listed = [...withRelated.flatMap((r) => r.related), ...discovered];
      for (const raw of composed.queries) {
        const q = raw.trim();
        if (!q) continue;
        if (!citesListedMetric(q, listed)) {
          ctx.notes.push(`compose query dropped (cites no listed metric): "${q}"`);
          continue;
        }
        if (namesMultipleEntities(q, resolved)) {
          ctx.notes.push(`compose query dropped (names multiple entities): "${q}"`);
          continue;
        }
        queries.push(q);
      }
    } catch (e: unknown) {
      ctx.notes.push(`grounded compose failed — ${errorMessage(e)}`);
    }
  }
  if (queries.length) {
    return diversifyQueries(Array.from(new Set(queries)), { threshold: 0.6, max: LEAF_QUERY_CAP });
  }
  if (entities.length && metrics.length) {
    const fb = fallbackQueries(entities, metrics);
    if (fb.length) return fb;
  }
  try {
    const composed = await generateStructured({
      provider: OPENAI, system: COMPOSE_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}\n\nRESOLVED:\n(none)`,
      schema: zQueries, label: "compose",
    });
    const dq = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean);
    return diversifyQueries(dq, { threshold: 0.6, max: LEAF_QUERY_CAP });
  } catch (e: unknown) {
    ctx.notes.push(`compose fallback failed — ${errorMessage(e)}`);
    return [];
  }
}

function planGraph(resolved: ResolvedEntity[], discovered: MetricDetail[]): QueryPlan["graph"] {
  return [
    ...resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name), kind: "entity" as const })),
    ...(discovered.length ? [{ entity: "metric search", related: discovered.map((d) => d.name), kind: "metric" as const }] : []),
  ];
}

export const graphStrategy: QueryStrategy = {
  async leafQueries(ctx, question, entities, metrics, nodeId) {
    const { resolved, discovered, metrics: allMetrics, graphCalls, graphMs } = await resolveGraph(ctx, entities, metrics, nodeId);
    const graph = planGraph(resolved, discovered);
    const queries = await groundedQueries(ctx, question, resolved, entities, allMetrics, discovered);
    return { queries, graph, metrics: allMetrics, graphCalls, graphMs };
  },
  async broadQueries(ctx, question, entities, metrics, nodeId) {
    const { resolved, discovered, metrics: allMetrics, graphCalls, graphMs } = await resolveGraph(ctx, entities, metrics, nodeId);
    const graph = planGraph(resolved, discovered);
    const resolvedInfo = [
      ...resolved.map((r) => `${r.entity}: ${metricLines(r.related.slice(0, 5))}`),
      ...(discovered.length ? [`Standalone series: ${metricLines(discovered)}`] : []),
    ].join("\n");
    let queries: string[] = [];
    try {
      const composed = await generateStructured({
        provider: OPENAI, system: BROAD_COMPOSE_SYSTEM,
        prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nRESOLVED:\n${resolvedInfo || "(none)"}`,
        schema: zQueries, label: "broad-compose",
      });
      queries = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean).slice(0, 2);
    } catch (e: unknown) {
      ctx.notes.push(`broad compose failed — ${errorMessage(e)}`);
    }
    return { queries, graph, metrics: allMetrics, graphCalls, graphMs };
  },
};

// searchStrategy: no graph. The LLM composes queries straight from the sub-question,
// then we dedup + diversify + cap exactly as the grounded path does, so downstream
// (runSearches, synthesis, compose) sees the same shape. graph is always [].
export const searchStrategy: QueryStrategy = {
  async leafQueries(ctx, question) {
    try {
      const composed = await generateStructured({
        provider: OPENAI, system: SEARCH_LEAF_COMPOSE_SYSTEM,
        prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}`,
        schema: zQueries, label: "search-leaf-compose",
      });
      const dq = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean);
      return { queries: diversifyQueries(dq, { threshold: 0.6, max: LEAF_QUERY_CAP }), graph: [] };
    } catch (e: unknown) {
      ctx.notes.push(`search-leaf compose failed — ${errorMessage(e)}`);
      return { queries: [], graph: [] };
    }
  },
  async broadQueries(ctx, question) {
    try {
      const composed = await generateStructured({
        provider: OPENAI, system: SEARCH_BROAD_COMPOSE_SYSTEM,
        prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}`,
        schema: zQueries, label: "search-broad-compose",
      });
      const dq = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean);
      return { queries: dq.slice(0, 2), graph: [] };
    } catch (e: unknown) {
      ctx.notes.push(`search-broad compose failed — ${errorMessage(e)}`);
      return { queries: [], graph: [] };
    }
  },
};

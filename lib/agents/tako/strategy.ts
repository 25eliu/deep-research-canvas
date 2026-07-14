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
import { zQueries, type GraphLookup } from "../shared/schemas";
import { graphSearch, graphRelated, type GraphNode, type GraphItem } from "./graph";
import { diversifyQueries } from "./queries";
import {
  COMPOSE_SYSTEM, SEARCH_LEAF_COMPOSE_SYSTEM,
} from "./prompts";

const OPENAI = "openai" as const;
export const LEAF_QUERY_CAP = 3; // 1-3 independent searches per sub-question

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface QueryPlan {
  queries: string[];
  // Resolved entity rows (each node + its related-metric menu) — rendered under the
  // trace's "graph resolved". kind stays a union for trace/UI back-compat, but the
  // entity-first flow only ever emits kind:"entity" rows.
  graph: { entity: string; related: string[]; kind?: "entity" | "metric" }[];
  // Unset by both strategies today (was metric-discovery enrichment); the tree falls
  // back to the planner's metricFilters when absent.
  metrics?: string[];
  // Raw graph API calls (exact params + response) — trace drill-down for debugging.
  graphCalls?: GraphCallRecord[];
  // Wall-clock ms the whole graph phase took for this node (search + related fan-out).
  graphMs?: number;
}

// Leaf query composition only: the synthesis (root) node NEVER graph-resolves or
// searches on its own — its children own the per-facet data and the gap round
// fetches what's missing. That asymmetry is deliberate; do not add a broad/root
// query path back here.
export interface QueryStrategy {
  // nodeId (when given) lets the graph phase stream each raw graph call live onto
  // that research node's trace row ("graph_call" events).
  leafQueries(ctx: ResearchCtx, question: string, lookup: GraphLookup, nodeId?: string): Promise<QueryPlan>;
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
    ...("label" in n && n.label ? { label: n.label } : {}),
    ...(n.aliases?.length ? { aliases: n.aliases } : {}),
    ...(n.description ? { description: n.description.slice(0, GRAPH_RESULT_DESC_CAP) } : {}),
  };
}

// graphSearch/graphRelated, with the EXACT request params and (compacted) response
// recorded into `rec` — the trace's per-node drill-down for graph-call debugging —
// and mirrored live via `onCall` (→ a "graph_call" event) so the streaming trace
// shows graph activity as it happens. Failures are recorded too, then rethrown.
async function recordedSearch(
  rec: GraphCallRecord[], q: string, opts: { label?: string; limit?: number },
  onCall?: (c: GraphCallRecord) => void,
): Promise<GraphNode[]> {
  const params = { q, types: "entity", ...(opts.label ? { label: opts.label } : {}), limit: opts.limit ?? 5 };
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
  rec: GraphCallRecord[], nodeId: string,
  opts: { relation: string; q?: string; limit?: number; subject?: string; label?: string },
  onCall?: (c: GraphCallRecord) => void,
): Promise<GraphItem[]> {
  const q = opts.q?.trim();
  const params = { node_id: nodeId, relation: opts.relation, ...(q ? { q } : {}), ...(opts.label ? { label: opts.label } : {}), limit: opts.limit ?? 6 };
  const subject = opts.subject ? { subject: opts.subject } : {};
  const t = Date.now();
  try {
    const items = await graphRelated(nodeId, { relation: opts.relation, ...(q ? { q } : {}), ...(opts.limit ? { limit: opts.limit } : {}), ...(opts.label ? { label: opts.label } : {}) });
    const call: GraphCallRecord = { endpoint: "graph/related", params, ...subject, ms: Date.now() - t, results: items.map(compactResult) };
    rec.push(call);
    onCall?.(call);
    return items;
  } catch (e: unknown) {
    const call: GraphCallRecord = { endpoint: "graph/related", params, ...subject, ms: Date.now() - t, results: [], error: errorMessage(e) };
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
// emits a validated entity-first LOOKUP (1-3 candidate names for ONE subject + optional
// NER label + 1-3 metric substring filters). The graph phase is one entity search per
// name (label boosts the on-type node's rank; nothing is filtered out), then a related
// fan-out of node×filter pairs over the top-3 hits of every name (deduped across names),
// truncated at a hard cap. Top-3 (not 5): the label boost ranks the right node up, so a
// wider fan-out mostly adds junk-node related calls.
// The metric namespace is NEVER searched (metrics come from the "metrics" relation).
const ENTITY_SEARCH_LIMIT = 3;  // top-3 per candidate name fan out post-dedupe
const MAX_METRIC_FILTERS = 5;   // filter-variant list cap (schema-matched) — breadth beats one perfect guess
const RELATED_LIMIT = 8;        // items per node×filter fetch
const MAX_RELATED_CALLS = 24;   // hard cap on node×filter pairs per research node
const FULL_MENU_LIMIT = 40;     // bounded no-q fallback menu size
const FULL_MENU_RETRIES = 2;    // nodes per research node allowed the no-q fallback
const GRAPH_CONCURRENCY = 8;    // related calls in flight at once

// Same shape as ResolvedEntity.related items — the compose LLM consumes these.
interface MetricDetail { name: string; aliases: string[]; description?: string }

interface ResolvedGraph {
  resolved: ResolvedEntity[];
  graphCalls: GraphCallRecord[]; // every raw graph call made resolving this node
  graphMs: number; // wall-clock of the whole graph phase for this node
}

const itemKey = (i: GraphItem) => i.id || i.name.trim().toLowerCase();

// Per-turn graph memo (ctx.graphMemo): the memo stores IN-FLIGHT promises, so
// concurrent resolves of the same key (parallel gap fills, sibling leaves sharing a
// subject) ride ONE request and later resolves are instant. A rejected fetch is
// evicted so transient failures aren't cached for the rest of the turn. Cache hits
// record no graph call — the first fetch's trace entry is the audit.
function memoized<T>(memo: Map<string, Promise<T>>, key: string, fetch: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit) return hit;
  const p = fetch();
  memo.set(key, p);
  p.catch(() => memo.delete(key));
  return p;
}

// Search each candidate name (label-boosted when the planner set one), containing
// per-name failures as notes. `label` only ranks matching-label nodes higher — it never
// excludes, so there is nothing to retry: one search per name.
async function searchNames(
  ctx: ResearchCtx, rec: GraphCallRecord[], names: string[], label: string | undefined,
  onCall?: (c: GraphCallRecord) => void,
): Promise<{ name: string; nodes: GraphNode[] }[]> {
  return Promise.all(names.map(async (name) => {
    try {
      const nodes = await memoized(ctx.graphMemo.search, `${name.trim().toLowerCase()}|${label ?? ""}`, () =>
        recordedSearch(rec, name, { ...(label ? { label } : {}), limit: ENTITY_SEARCH_LIMIT }, onCall),
      );
      if (nodes.length === 0) ctx.notes.push(`No graph node for "${name}"`);
      // Enforce the fan-out cap in code too — the limit param bounds the API response,
      // but the cap must hold even if the API returns more.
      return { name, nodes: nodes.slice(0, ENTITY_SEARCH_LIMIT) };
    } catch (e: unknown) {
      ctx.notes.push(`graph lookup failed for "${name}" — ${errorMessage(e)}`);
      return { name, nodes: [] as GraphNode[] };
    }
  }));
}

// Interleave the per-name result lists round-robin by rank (rank-0 of name A, rank-0 of
// B, rank-0 of C, rank-1 of A, …) and drop duplicate node ids across names ("Google" and
// "Alphabet" both resolving Alphabet Inc. fan out once). Rank order matters: the related
// cap below truncates node-major, so every name's TOP hit gets full filter coverage
// before any name's tail hits.
function rankNodes(perName: { name: string; nodes: GraphNode[] }[]): { node: GraphNode; from: string }[] {
  const seen = new Set<string>();
  const ranked: { node: GraphNode; from: string }[] = [];
  for (let rank = 0; ; rank++) {
    const row = perName
      .map((p) => ({ node: p.nodes[rank], from: p.name }))
      .filter((r): r is { node: GraphNode; from: string } => Boolean(r.node));
    if (row.length === 0) break;
    for (const r of row) {
      if (seen.has(r.node.id)) continue;
      seen.add(r.node.id);
      ranked.push(r);
    }
  }
  return ranked;
}

// The entity-first lookup: every candidate name is searched ONLY in the entity namespace,
// then each resolved node's available metrics are fetched via related — one call per
// node×filter pair (the filter is /related's case-insensitive substring match against
// metric NAMES — a short term like "revenue"; NEVER the question or the entity name).
// All top hits of every name become resolved rows: keyword search can rank a junk node
// first ("Apple" → "Apples" the fruit above "Apple Inc."), and giving the composer every
// menu lets it ignore the wrong ones.
async function resolveGraph(ctx: ResearchCtx, lookup: GraphLookup, researchNodeId?: string): Promise<ResolvedGraph> {
  const t = Date.now();
  const graphCalls: GraphCallRecord[] = [];
  // Mirror each graph call live onto the issuing research node's trace row.
  const onCall = researchNodeId && ctx.emit
    ? (call: GraphCallRecord) => ctx.emit!({ type: "graph_call", nodeId: researchNodeId, call })
    : undefined;
  const names = dedupeCi(lookup.entities).slice(0, 3);
  const filters = dedupeCi(lookup.metricFilters).slice(0, MAX_METRIC_FILTERS);
  const label = lookup.label?.trim() || undefined;

  let ranked: { node: GraphNode; from: string }[];
  if (lookup.node) {
    // Pre-resolved (cohort-roster member): the id is already exact — skip the search.
    ranked = [{ node: { id: lookup.node.id, name: lookup.node.name, type: "entity" }, from: lookup.node.name }];
  } else {
    const perName = await searchNames(ctx, graphCalls, names, label, onCall);
    ranked = rankNodes(perName);
  }
  for (const r of ranked) ctx.resolved.push({ query: r.from, node: r.node.name });

  // Node-major node×filter pairs, truncated at the hard cap: full filter coverage of the
  // top-ranked nodes beats partial coverage of every node. No filters (defensive; the
  // schema requires 1+) → one bounded full-menu fetch per node instead.
  const pairs = ranked.flatMap((r) =>
    filters.length ? filters.map((f) => ({ node: r.node, q: f as string | undefined })) : [{ node: r.node, q: undefined }],
  );
  const capped = pairs.slice(0, MAX_RELATED_CALLS);
  if (capped.length < pairs.length) {
    ctx.notes.push(`graph related fan-out capped at ${MAX_RELATED_CALLS} of ${pairs.length} node×filter pairs`);
  }

  // Execute in bounded-concurrency batches; per-pair failures are notes, never throws.
  const menus = new Map<string, { items: GraphItem[]; attempted: boolean }>();
  const fetchPair = async (p: { node: GraphNode; q?: string }) => {
    const menu = menus.get(p.node.id) ?? { items: [], attempted: false };
    menus.set(p.node.id, menu);
    menu.attempted = true;
    try {
      const limit = p.q ? RELATED_LIMIT : FULL_MENU_LIMIT;
      const items = await memoized(ctx.graphMemo.related, `${p.node.id}|${p.q ?? ""}|${limit}`, () =>
        recordedRelated(
          graphCalls, p.node.id,
          { relation: "metrics", ...(p.q ? { q: p.q } : {}), limit, subject: p.node.name, label: "METRIC" },
          onCall,
        ));
      for (const i of items) {
        if (!menu.items.some((x) => itemKey(x) === itemKey(i))) menu.items.push(i);
      }
    } catch (e: unknown) {
      ctx.notes.push(`graph lookup failed for "${p.node.name}" — ${errorMessage(e)}`);
    }
  };
  for (let i = 0; i < capped.length; i += GRAPH_CONCURRENCY) {
    await Promise.all(capped.slice(i, i + GRAPH_CONCURRENCY).map(fetchPair));
  }

  // Full-menu safety net: a node whose EVERY filter missed gets one bounded no-q fetch
  // (the filters were too specific — surface what Tako actually has), for at most
  // FULL_MENU_RETRIES nodes so a 15-node fan-out can't double the call count.
  let retries = 0;
  for (const r of ranked) {
    if (retries >= FULL_MENU_RETRIES) break;
    const menu = menus.get(r.node.id);
    if (!menu?.attempted || menu.items.length > 0 || filters.length === 0) continue;
    retries++;
    try {
      // .slice(): the memo hands every consumer the SAME array — this node's menu must
      // stay mutation-independent of other nodes sharing the cache entry.
      menu.items = (await memoized(ctx.graphMemo.related, `${r.node.id}||${FULL_MENU_LIMIT}`, () =>
        recordedRelated(graphCalls, r.node.id, { relation: "metrics", limit: FULL_MENU_LIMIT, subject: r.node.name, label: "METRIC" }, onCall))).slice();
    } catch (e: unknown) {
      ctx.notes.push(`graph lookup failed for "${r.node.name}" — ${errorMessage(e)}`);
    }
  }

  // Resolved rows in rank order — only nodes the fan-out actually reached (empty-menu
  // rows stay, so the composer can be told "no related metrics").
  const out: ResolvedEntity[] = [];
  for (const r of ranked) {
    const menu = menus.get(r.node.id);
    if (!menu?.attempted) continue;
    ctx.related.push({ node: r.node.name, items: menu.items.map((i) => i.name) });
    out.push({
      entity: r.node.name, node: r.node.id,
      related: menu.items.map((i) => ({ name: i.name, aliases: i.aliases || [], description: i.description })),
    });
  }
  const graphMs = Date.now() - t;
  ctx.timings.graph = Math.max(ctx.timings.graph, graphMs);
  return { resolved: out, graphCalls, graphMs };
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
// availability list (resolved entities + their related metrics), guard-checked; then
// the mechanical fallback ladder for the no-material/failed cases.
async function groundedQueries(
  ctx: ResearchCtx, question: string, resolved: ResolvedEntity[], lookup: GraphLookup,
): Promise<string[]> {
  const queries: string[] = [];
  const withRelated = resolved.filter((r) => r.related.length > 0);
  for (const r of resolved) {
    if (r.related.length === 0) ctx.notes.push(`Tako has no related metrics for "${r.entity}"`);
  }
  if (withRelated.length) {
    const resolvedBlock = withRelated
      .map((r) => `${r.entity}: ${metricLines(r.related.slice(0, METRICS_PER_ENTITY_IN_PROMPT))}`)
      .join("\n");
    try {
      const composed = await generateStructured({
        provider: OPENAI, system: COMPOSE_SYSTEM,
        prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}\n\nRESOLVED:\n${resolvedBlock}`,
        schema: zQueries, label: "grounded-compose",
      });
      const listed = withRelated.flatMap((r) => r.related);
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
  // Mechanical fallback pairs the PLANNER's own terms only — resolved graph names are
  // keyword matches whose topical relevance only the compose LLM can judge.
  if (lookup.entities.length && lookup.metricFilters.length) {
    const fb = fallbackQueries(lookup.entities, lookup.metricFilters);
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

function planGraph(resolved: ResolvedEntity[]): QueryPlan["graph"] {
  return resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name), kind: "entity" as const }));
}

export const graphStrategy: QueryStrategy = {
  async leafQueries(ctx, question, lookup, nodeId) {
    const { resolved, graphCalls, graphMs } = await resolveGraph(ctx, lookup, nodeId);
    const graph = planGraph(resolved);
    const queries = await groundedQueries(ctx, question, resolved, lookup);
    return { queries, graph, graphCalls, graphMs };
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
};

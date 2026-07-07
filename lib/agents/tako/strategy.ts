// Query-composition strategy seam. graphStrategy = the graph-grounded behavior
// (graphSearch + graphRelated + metric-filter). searchStrategy (Task 2) skips the
// graph and composes queries directly from the sub-question. research.ts calls
// ctx.strategy at its two query-composition sites; nothing else differs between providers.
import type { ResearchCtx } from "./research";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zQueries, zMetricFilter } from "../shared/schemas";
import { graphSearch, graphRelated } from "./graph";
import { diversifyQueries } from "./queries";
import { COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, METRIC_FILTER_SYSTEM } from "./prompts";

const OPENAI = "openai" as const;
export const LEAF_QUERY_CAP = 3; // 1-3 independent searches per sub-question

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface QueryPlan {
  queries: string[];
  graph: { entity: string; related: string[] }[];
}

export interface QueryStrategy {
  leafQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[]): Promise<QueryPlan>;
  broadQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[]): Promise<QueryPlan>;
}

interface ResolvedEntity {
  entity: string; node: string;
  related: { name: string; aliases: string[]; description?: string }[];
}

// ---- moved verbatim from research.ts (resolveGraph) ----
async function resolveGraph(ctx: ResearchCtx, entities: string[], metrics: string[], topic: string): Promise<ResolvedEntity[]> {
  const t = Date.now();
  const out: ResolvedEntity[] = [];
  await Promise.all(
    entities.slice(0, 3).map(async (name) => {
      try {
        const nodes = await graphSearch(name, { types: "entity" });
        const node = nodes[0];
        if (!node) { ctx.notes.push(`No graph node for "${name}"`); return; }
        ctx.resolved.push({ query: name, node: node.name });
        const q = metrics[0] || topic || name;
        const items = await graphRelated(node.id, { relationType: "metric", q });
        ctx.related.push({ node: node.name, items: items.map((i) => i.name) });
        out.push({ entity: node.name, node: node.id, related: items.map((i) => ({ name: i.name, aliases: i.aliases || [], description: i.description })) });
      } catch (e: unknown) {
        ctx.notes.push(`graph lookup failed for "${name}" — ${errorMessage(e)}`);
      }
    }),
  );
  ctx.timings.graph = Math.max(ctx.timings.graph, Date.now() - t);
  return out;
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

// ---- moved verbatim from research.ts (groundedQueries) ----
async function groundedQueries(
  ctx: ResearchCtx, question: string, resolved: ResolvedEntity[],
  entities: string[] = [], metrics: string[] = [],
): Promise<string[]> {
  const queries: string[] = [];
  for (const r of resolved) {
    if (r.related.length === 0) { ctx.notes.push(`Tako has no related metrics for "${r.entity}"`); continue; }
    let keep: string[] = [];
    try {
      const res = await generateStructured({
        provider: OPENAI, system: METRIC_FILTER_SYSTEM,
        prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nENTITY: ${r.entity}\n\nRELATED_METRICS: ${JSON.stringify(r.related.map((m) => ({ name: m.name, aliases: m.aliases, description: m.description })))}`,
        schema: zMetricFilter, label: "metric-filter",
      });
      const avail = new Set(r.related.map((m) => m.name.toLowerCase()));
      keep = res.keep.filter((m) => avail.has(m.toLowerCase())).slice(0, LEAF_QUERY_CAP);
    } catch (e: unknown) {
      ctx.notes.push(`metric filter failed for "${r.entity}" — ${errorMessage(e)}`);
    }
    if (keep.length === 0) { ctx.notes.push(`No answer-relevant Tako metric for "${r.entity}"`); continue; }
    for (const m of keep) queries.push(`${r.entity} ${m}`);
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
      prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}\n\nRESOLVED:\n(none — compose from the question directly)`,
      schema: zQueries, label: "compose",
    });
    const dq = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean);
    return diversifyQueries(dq, { threshold: 0.6, max: LEAF_QUERY_CAP });
  } catch (e: unknown) {
    ctx.notes.push(`compose fallback failed — ${errorMessage(e)}`);
    return [];
  }
}

export const graphStrategy: QueryStrategy = {
  async leafQueries(ctx, question, entities, metrics) {
    const resolved = await resolveGraph(ctx, entities, metrics, question);
    const graph = resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name) }));
    const queries = await groundedQueries(ctx, question, resolved, entities, metrics);
    return { queries, graph };
  },
  async broadQueries(ctx, question, entities, metrics) {
    const resolved = await resolveGraph(ctx, entities, metrics, question);
    const graph = resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name) }));
    const resolvedInfo = resolved
      .map((r) => `${r.entity}: ${r.related.slice(0, 5).map((m) => `${m.name} [${m.aliases.join(", ")}]`).join("; ")}`)
      .join("\n");
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
    return { queries, graph };
  },
};

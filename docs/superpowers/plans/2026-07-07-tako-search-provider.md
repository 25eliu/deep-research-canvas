# tako-search Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 4th provider `tako-search` ("LLM + Tako (search-only)") that reuses the entire Tako research engine but generates leaf `takoSearch` queries directly from the sub-question via an LLM, with no graph search/related.

**Architecture:** Introduce a `QueryStrategy` seam. Extract today's graph query logic verbatim from `research.ts` into `strategy.ts` as `graphStrategy` (default, so the existing `tako` provider is unchanged), and add `searchStrategy` (LLM composes queries from the sub-question text, no graph). `research.ts` calls `ctx.strategy.leafQueries` / `ctx.strategy.broadQueries` at the two graph call sites; the strategy is threaded down from the registry (`tako` → graph, `tako-search` → search). Everything else — decomposition tree, synthesis, compose report, web sources, follow-up — is shared and untouched.

**Tech Stack:** TypeScript, Next.js 14.2, Vercel AI SDK (`generateObject` via `lib/llm.ts`), Zod schemas, Vitest.

## Global Constraints

- **Existing `tako` provider must stay behaviorally identical.** Its default strategy is `graphStrategy`, a verbatim extraction. The existing tako test suite is the equivalence guardrail and must stay green unchanged.
- **Every new function parameter defaults to `graphStrategy`** so existing callers are unaffected.
- **Tako host MUST be `staging.tako.com`** (already handled in `lib/agents/tako/graph.ts` / `lib/tako.ts`; do not change).
- **OpenAI structured outputs stay non-strict** — do not touch `lib/llm.ts` `structuredOutputs: false`.
- **Immutability:** return new objects; never mutate inputs. `ctx` accumulators (`ctx.notes`, `ctx.queries`, `ctx.resolved`, etc.) are the existing intentional mutation pattern — follow it exactly as the current code does.
- **Leaf query cap = 3** (`LEAF_QUERY_CAP`), broad/overview cap = 2. Both paths pass through `diversifyQueries` with `threshold: 0.6`.
- Provider id string is exactly `"tako-search"` (used identically in `ProviderId`, `Provider`, registry key, and the UI list).

---

## File Structure

**New files:**
- `lib/agents/tako/strategy.ts` — `QueryStrategy`/`QueryPlan` types, `graphStrategy` (extracted), `searchStrategy` (new). ~180 lines.
- `lib/agents/tako/strategy.test.ts` — unit tests for `searchStrategy`.
- `lib/agents/tako/pipeline.search.test.ts` — pipeline test proving the search provider builds a tree and issues zero graph calls.

**Modified files:**
- `lib/agents/tako/research.ts` — remove graph query functions (moved to strategy); `leaf()`/`broadFetch()` call `ctx.strategy.*`; `ResearchCtx` gains `strategy`; `newResearchCtx` gains defaulted `strategy` param.
- `lib/agents/tako/prompts.ts` — add `SEARCH_LEAF_COMPOSE_SYSTEM`, `SEARCH_BROAD_COMPOSE_SYSTEM`.
- `lib/agents/tako/pipeline.ts` — `runTakoInitial` gains defaulted `strategy` param.
- `lib/agents/tako/agent.ts` — `runTako` gains defaulted `strategy` param.
- `lib/providers/registry.ts` — add `tako-search` provider def.
- `lib/schema.ts` — `ProviderId` union += `"tako-search"`.
- `lib/sessions.ts` — `Provider` union += `"tako-search"`.
- `components/ProviderControls.tsx` — add `tako-search` to `PROVIDERS`.
- `lib/agents/tako/queries.test.ts` — update `fallbackQueries` import path (`./research` → `./strategy`).

---

## Task 1: Extract graph query logic into `strategy.ts` (behavior-preserving)

Moves the graph-dependent query composition out of `research.ts` behind the `QueryStrategy` seam, with `graphStrategy` as the default. No behavior change — verified by the existing tako suite.

**Files:**
- Create: `lib/agents/tako/strategy.ts`
- Modify: `lib/agents/tako/research.ts`
- Modify: `lib/agents/tako/queries.test.ts` (import path only)

**Interfaces:**
- Produces:
  - `export interface QueryPlan { queries: string[]; graph: { entity: string; related: string[] }[] }`
  - `export interface QueryStrategy { leafQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[]): Promise<QueryPlan>; broadQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[]): Promise<QueryPlan> }`
  - `export const graphStrategy: QueryStrategy`
  - `export function fallbackQueries(entities: string[], metrics: string[]): string[]` (relocated from `research.ts`, signature unchanged)
- Consumes: `ResearchCtx` (type-only import from `./research` — erased at compile, so no runtime import cycle).

- [ ] **Step 1: Create `strategy.ts` with the extracted graph logic**

Create `lib/agents/tako/strategy.ts`. Move these verbatim from `research.ts` into it: the `ResolvedEntity` interface, `resolveGraph`, `groundedQueries`, `fallbackQueries`, the helpers `includesCi` and `dedupeWords`, and the `LEAF_QUERY_CAP` constant. Then wrap them in `graphStrategy`. The `broadQueries` body is the graph portion of the current `broadFetch` (the `resolveGraph` + `resolvedInfo` + `BROAD_COMPOSE` block), returning `{ queries, graph }` instead of pushing to `ctx.queries` (the caller pushes).

```ts
// lib/agents/tako/strategy.ts
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
```

- [ ] **Step 2: Rewire `research.ts` to use the strategy and delete the moved code**

In `lib/agents/tako/research.ts`:

(a) Update imports. Remove `graphSearch, graphRelated` from the `./graph` import (delete the line). Remove `diversifyQueries` from the `./queries` import (delete the line). In the prompts import, remove `COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, METRIC_FILTER_SYSTEM` (keep `DECOMPOSE_SYSTEM, WEB_FILTER_SYSTEM, LEAF_SYNTH_SYSTEM, BRANCH_SYNTH_SYSTEM`). In the schemas import, remove `zQueries, zMetricFilter` (keep `zResearchPlan, zWebFilter`). Add:

```ts
import { graphStrategy, type QueryStrategy } from "./strategy";
```

(b) Delete these now-moved definitions from `research.ts`: the `LEAF_QUERY_CAP` constant (line ~32), the `includesCi` const, the `dedupeWords` function, the exported `fallbackQueries` function, the `ResolvedEntity` interface, `resolveGraph`, and `groundedQueries`. (`extractFigures`, `pickFigure`, `firstSentence`, `runSearches`, `filterWebSources`, `buildPublisherSources`, etc. all stay.)

(c) Add `strategy` to `ResearchCtx`:

```ts
export interface ResearchCtx {
  req: AgentRequest;
  ledger: FindingLedger;
  push: (ops: CanvasOp[]) => void;
  emit?: EmitFn;
  strategy: QueryStrategy;   // <-- add this line
  budget: { researchNodes: number; readonly maxNodes: number };
  // ...rest unchanged
```

(d) Add a defaulted `strategy` param to `newResearchCtx` and set it:

```ts
export function newResearchCtx(
  req: AgentRequest, ledger: FindingLedger, push: ResearchCtx["push"],
  emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): ResearchCtx {
  return {
    req, ledger, push, emit, strategy,
    budget: { researchNodes: 0, maxNodes: TOTAL_RESEARCH_CAP },
    // ...rest unchanged
  };
}
```

(e) In `leaf()`, replace the first three lines of its body:

```ts
// BEFORE:
const resolved = await resolveGraph(ctx, entities, metrics, question);
const graph = resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name) }));
const queries = await groundedQueries(ctx, question, resolved, entities, metrics);
ctx.queries.push(...queries);

// AFTER:
const { queries, graph } = await ctx.strategy.leafQueries(ctx, question, entities, metrics);
ctx.queries.push(...queries);
```

(f) In `broadFetch()`, replace the graph resolution + compose block (from `const resolved = await resolveGraph(...)` through `ctx.queries.push(...queries);` — i.e. everything before `// Broad chart cards feed the synth`) with:

```ts
const { queries, graph } = await ctx.strategy.broadQueries(ctx, question, entities, metrics);
ctx.queries.push(...queries);
```

Leave the rest of `broadFetch` (the `runSearches` call and the `return { findings, queries, calls, graph }`) unchanged.

- [ ] **Step 3: Fix the `fallbackQueries` import in its test**

In `lib/agents/tako/queries.test.ts` line 3, change the import source:

```ts
// BEFORE
import { fallbackQueries } from "./research";
// AFTER
import { fallbackQueries } from "./strategy";
```

- [ ] **Step 4: Run the full tako suite to prove no behavior change**

Run: `npx vitest run lib/agents/tako/ lib/relate.test.ts`
Expected: PASS — all existing tests green, including `pipeline.test.ts` (grounded queries still `"Nvidia Revenue"`, tree/edges/report intact) and `queries.test.ts` (`fallbackQueries` behavior unchanged). If anything fails, the extraction diverged from the original — diff the moved functions against git and fix before proceeding.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors (confirms the import cycle is type-only and every reference resolves).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/strategy.ts lib/agents/tako/research.ts lib/agents/tako/queries.test.ts
git commit -m "refactor: extract Tako query composition behind QueryStrategy seam"
```

---

## Task 2: Add `searchStrategy` + prompts (the new behavior)

Adds the graph-free strategy: the LLM composes leaf/broad queries straight from the question text.

**Files:**
- Modify: `lib/agents/tako/prompts.ts`
- Modify: `lib/agents/tako/strategy.ts`
- Create: `lib/agents/tako/strategy.test.ts`

**Interfaces:**
- Consumes: `QueryStrategy`, `QueryPlan`, `LEAF_QUERY_CAP` (from Task 1); `zQueries` (`lib/agents/shared/schemas.ts`); `ctxBlock`; `diversifyQueries`; `generateStructured`.
- Produces: `export const searchStrategy: QueryStrategy`.

- [ ] **Step 1: Write the failing test**

Create `lib/agents/tako/strategy.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  leaf: [] as string[],   // queries the mocked LLM returns for search-leaf-compose
  broad: [] as string[],  // queries for search-broad-compose
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "search-leaf-compose") return { queries: h.leaf };
    if (opts.label === "search-broad-compose") return { queries: h.broad };
    return {};
  }),
}));

import { searchStrategy } from "./strategy";
import type { ResearchCtx } from "./research";

// searchStrategy only reads ctx.req (for ctxBlock) and ctx.notes.
function stubCtx(): ResearchCtx {
  return {
    req: {
      canvasId: "c", message: "q", surface: "main",
      canvasState: { nodes: [], edges: [] }, providerId: "tako-search",
      takoAnswerEnabled: true, history: [],
    },
    notes: [],
  } as unknown as ResearchCtx;
}

beforeEach(() => { vi.clearAllMocks(); h.leaf = []; h.broad = []; });

describe("searchStrategy", () => {
  it("composes leaf queries from the sub-question with an empty graph", async () => {
    h.leaf = ["US inflation rate 2024", "core CPI trend"];
    const plan = await searchStrategy.leafQueries(stubCtx(), "how is inflation trending?", [], []);
    expect(plan.graph).toEqual([]);
    expect(plan.queries).toEqual(["US inflation rate 2024", "core CPI trend"]);
  });

  it("caps leaf queries at 3 and drops near-duplicates", async () => {
    h.leaf = ["Nvidia revenue", "Nvidia revenue growth", "Nvidia data center revenue", "Nvidia gross margin", "Nvidia operating income"];
    const plan = await searchStrategy.leafQueries(stubCtx(), "nvidia financials", [], []);
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(new Set(plan.queries).size).toBe(plan.queries.length); // no exact dups
  });

  it("caps broad queries at 2 with an empty graph", async () => {
    h.broad = ["US economy overview", "US GDP growth", "US inflation overview"];
    const plan = await searchStrategy.broadQueries(stubCtx(), "how is the US economy doing?", [], []);
    expect(plan.graph).toEqual([]);
    expect(plan.queries.length).toBeLessThanOrEqual(2);
  });

  it("returns empty queries (not throw) when the LLM call fails", async () => {
    const { generateStructured } = await import("../../llm");
    (generateStructured as any).mockRejectedValueOnce(new Error("boom"));
    const ctx = stubCtx();
    const plan = await searchStrategy.leafQueries(ctx, "anything", [], []);
    expect(plan.queries).toEqual([]);
    expect(plan.graph).toEqual([]);
    expect(ctx.notes.some((n) => n.includes("search-leaf compose failed"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agents/tako/strategy.test.ts`
Expected: FAIL — `searchStrategy` is not exported yet (`searchStrategy is not a function` / undefined).

- [ ] **Step 3: Add the two prompts**

Append to `lib/agents/tako/prompts.ts`:

```ts
export const SEARCH_LEAF_COMPOSE_SYSTEM = `You write Tako /v3/search queries that answer ONE specific sub-question, working from the question text ALONE (no knowledge graph).
- Output 1-3 queries. Each must be a DISTINCT angle on the sub-question (a different metric, facet, or entity) — never near-duplicates.
- Write each as a short search-style noun phrase a data search engine would match: entity + measure + qualifier (e.g. "US gasoline prices 2024", "Nvidia data center revenue"). NOT a full sentence, no question marks.
- If the sub-question is a single simple ask, ONE query is correct — do not pad to three.
Return { queries }.`;

export const SEARCH_BROAD_COMPOSE_SYSTEM = `You write 1-2 Tako /v3/search queries for the BROAD/overview view of the user's overall question, working from the question text ALONE (no knowledge graph).
- 1-2 queries max, each capturing a headline/overview measure for the whole question.
- Short search-style noun phrases, not sentences; no near-duplicates.
Return { queries }.`;
```

- [ ] **Step 4: Add `searchStrategy` to `strategy.ts`**

Add to the prompts import at the top of `lib/agents/tako/strategy.ts`:

```ts
import {
  COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, METRIC_FILTER_SYSTEM,
  SEARCH_LEAF_COMPOSE_SYSTEM, SEARCH_BROAD_COMPOSE_SYSTEM,
} from "./prompts";
```

Append at the end of `strategy.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run lib/agents/tako/strategy.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/prompts.ts lib/agents/tako/strategy.ts lib/agents/tako/strategy.test.ts
git commit -m "feat: add searchStrategy (graph-free query composition) + prompts"
```

---

## Task 3: Thread the strategy through the pipeline and register the `tako-search` provider

Wires `searchStrategy` from a new registry entry down through `agent` → `pipeline` → `research`, adds the id to the three provider unions and the UI, and proves end-to-end that the search provider builds a tree with zero graph calls.

**Files:**
- Modify: `lib/agents/tako/pipeline.ts`
- Modify: `lib/agents/tako/agent.ts`
- Modify: `lib/providers/registry.ts`
- Modify: `lib/schema.ts`
- Modify: `lib/sessions.ts`
- Modify: `components/ProviderControls.tsx`
- Create: `lib/agents/tako/pipeline.search.test.ts`

**Interfaces:**
- Consumes: `graphStrategy`, `searchStrategy`, `QueryStrategy` (Task 1/2); `runTakoInitial`, `runTako`.
- Produces: `runTakoInitial(req, emit?, strategy?)`, `runTako(req, emit?, strategy?)` (both defaulting to `graphStrategy`); registry key `tako-search`.

- [ ] **Step 1: Write the failing pipeline test**

Create `lib/agents/tako/pipeline.search.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  leaf: ["US inflation rate", "core CPI"] as string[],
  broad: ["US economy overview"] as string[],
  report: { verdict: "**Inflation is cooling.**", blocks: [{ kind: "prose", md: "Because CPI fell." }] } as any,
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "decompose") return { atomic: true, rationale: "direct", entities: [], metrics: [] };
    if (opts.label === "search-leaf-compose") return { queries: h.leaf };
    if (opts.label === "search-broad-compose") return { queries: h.broad };
    if (opts.label === "answer-report") return h.report;
    return {};
  }),
  streamAnswer: vi.fn(async (opts: any) => { opts.onToken("ok"); return "ok"; }),
}));

// Graph must NEVER be called by the search provider — these throw if invoked.
const graphSearch = vi.fn(async () => { throw new Error("graphSearch must not be called"); });
const graphRelated = vi.fn(async () => { throw new Error("graphRelated must not be called"); });
vi.mock("./graph", () => ({ graphSearch, graphRelated }));

vi.mock("../../tako", () => ({
  takoSearch: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "c-" + q.slice(0, 6), title: "card " + q, embedUrl: "https://e/" + q.slice(0, 6), source: "FRED" }];
    opts.onCall?.({ query: q, endpoint: "/v3/search", effort: opts.effort ?? "fast", web: !!opts.web, ms: 1, cards });
    return cards;
  }),
}));

import { runTakoInitial } from "./pipeline";
import { searchStrategy } from "./strategy";

const req = {
  canvasId: "c", message: "how is inflation trending?", surface: "main" as const,
  canvasState: { nodes: [], edges: [] }, providerId: "tako-search" as const,
  takoAnswerEnabled: true, history: [],
};

beforeEach(() => { vi.clearAllMocks(); });

describe("runTakoInitial with searchStrategy", () => {
  it("builds a synth answer from LLM-composed queries and issues ZERO graph calls", async () => {
    const events: AgentEvent[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e), searchStrategy);

    // never touched the graph
    expect(graphSearch).not.toHaveBeenCalled();
    expect(graphRelated).not.toHaveBeenCalled();

    // it did run Tako searches using the LLM-composed queries
    const queries = (result.trace.calls ?? []).map((c) => c.query);
    expect(queries).toContain("US inflation rate");

    // produced a synth node + composed report
    const added = result.nodeOps.filter((o: any) => o.op === "add_node");
    expect(added.some((o: any) => o.node.role === "synthesis")).toBe(true);
    const synthUpdate = result.nodeOps.filter((o: any) => o.op === "update_node" && o.id === "synth").pop() as any;
    expect(synthUpdate.patch.report?.verdict).toContain("Inflation is cooling");

    // the trace graph for the (atomic root) node is empty
    const rootNode = result.trace.tree?.find((n: any) => n.nodeId === "synth");
    expect(rootNode?.graph ?? []).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run lib/agents/tako/pipeline.search.test.ts`
Expected: FAIL — `runTakoInitial` does not yet accept a `strategy` argument (it ignores the 3rd arg and uses graph, so `graphSearch` gets called → throws).

- [ ] **Step 3: Add the `strategy` param to `runTakoInitial`**

In `lib/agents/tako/pipeline.ts`:

Update the imports to add the strategy default:

```ts
import { research, newResearchCtx, buildPublisherSources, toNodeSources, SYNTH_ID } from "./research";
import { graphStrategy, type QueryStrategy } from "./strategy";
```

Change the signature and the `newResearchCtx` call:

```ts
export async function runTakoInitial(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  // ...unchanged...
  const ctx = newResearchCtx(req, ledger, push, emit, strategy);
  // ...rest unchanged...
```

- [ ] **Step 4: Add the `strategy` param to `runTako`**

In `lib/agents/tako/agent.ts`:

Add the import:

```ts
import { graphStrategy, type QueryStrategy } from "./strategy";
```

Change the signature and the initial-pipeline call (follow-up is graph-free and stays as-is):

```ts
export async function runTako(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<AgentResponse> {
  // ...routing unchanged...
  const result = isFollowup ? await runTakoFollowup(req, emit) : await runTakoInitial(req, emit, strategy);
  // ...rest unchanged...
```

- [ ] **Step 5: Register the `tako-search` provider**

In `lib/providers/registry.ts`:

Add the import:

```ts
import { searchStrategy } from "../agents/tako/strategy";
```

Add the entry to `PROVIDERS` (after the `tako` entry):

```ts
  "tako-search": {
    id: "tako-search", label: "LLM + Tako (search-only)",
    capabilities: { structured_cards: true, tako_search: true, tako_graph: false, tako_answer: true, web_search: true },
    run: (r, e) => runTako(r, e, searchStrategy),
  },
```

- [ ] **Step 6: Add `tako-search` to the provider unions**

In `lib/schema.ts` line ~117:

```ts
export type ProviderId = "gpt" | "claude" | "tako" | "tako-search";
```

In `lib/sessions.ts` line ~7:

```ts
export type Provider = "gpt" | "claude" | "tako" | "tako-search";
```

- [ ] **Step 7: Add `tako-search` to the UI provider list**

In `components/ProviderControls.tsx`, add the entry to `PROVIDERS` and extend the tako styling class to cover it:

```ts
export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "tako", label: "LLM + Tako" },
  { id: "tako-search", label: "LLM + Tako (search-only)" },
  { id: "gpt", label: "GPT" },
  { id: "claude", label: "Claude" },
];
```

And on the button `className` (line ~23), change the tako class test:

```ts
className={`seg-btn${provider === p.id ? " on" : ""}${(p.id === "tako" || p.id === "tako-search") ? " tako" : ""}`}
```

- [ ] **Step 8: Run the search pipeline test to verify it passes**

Run: `npx vitest run lib/agents/tako/pipeline.search.test.ts`
Expected: PASS — zero graph calls, searches use `"US inflation rate"`, synth + report produced.

- [ ] **Step 9: Run the full suite + typecheck to confirm nothing regressed**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS across all test files (existing tako suite still green; new strategy + search-pipeline tests green); no type errors.

- [ ] **Step 10: Commit**

```bash
git add lib/agents/tako/pipeline.ts lib/agents/tako/agent.ts lib/providers/registry.ts lib/schema.ts lib/sessions.ts components/ProviderControls.tsx lib/agents/tako/pipeline.search.test.ts
git commit -m "feat: register tako-search provider (search-only) end-to-end"
```

---

## Task 4: Manual verification in the running app

Confirm the new provider works against real Tako staging and renders correctly.

**Files:** none (manual).

- [ ] **Step 1: Start the dev server**

Run: `npm run dev`
Expected: server on `http://localhost:3000`, no startup errors. Ensure `TAKO_API_KEY` (a `staging.tako.com` key) and OpenAI creds are set in `.env`.

- [ ] **Step 2: Exercise the provider**

In the browser, select **"LLM + Tako (search-only)"** in the provider segmented control and ask a decomposable question (e.g. *"How are energy and gasoline prices contributing to inflation this year?"*).

Expected:
- A research tree builds; leaf nodes fetch Tako cards and stream mini-answers; the synth block gets a composed report.
- The trace panel shows Tako `search` calls per node with **no "graph resolved" section** (graph is empty for this provider).
- Side-by-side, the **"LLM + Tako"** provider on the same question still shows the graph-resolved section — confirming the old path is unchanged.

- [ ] **Step 3: Confirm zero graph traffic**

While a `tako-search` turn runs, watch the server logs. Expected: `tako-graph` timer lines (`GET /search`, `GET /related`) appear for the `tako` provider but **not** for `tako-search`.

---

## Self-Review Notes

- **Spec coverage:** 4th provider (Task 3), `QueryStrategy` seam + `graphStrategy` extraction (Task 1), `searchStrategy` + prompts (Task 2), additive defaults preserving `tako` (Tasks 1/3), trace `graph: []` (verified in Task 3 test + Task 4 manual), all three union declarations updated (Task 3), zero-graph-calls test + regression guardrail (Tasks 1/3), follow-up shared unchanged (Task 3 note). Out-of-scope items (no refinement pass, no synthesis/compose changes) are respected — none of the tasks touch those.
- **Import-cycle note:** `strategy.ts` imports `ResearchCtx` from `research.ts` **type-only** (erased at compile); `research.ts` imports `graphStrategy` **value** from `strategy.ts`. No runtime cycle.
- **Type consistency:** `QueryStrategy`/`QueryPlan`/`graphStrategy`/`searchStrategy`/`LEAF_QUERY_CAP`/`fallbackQueries` names are used identically across Tasks 1–3. `strategy` param name and `graphStrategy` default are identical in `newResearchCtx`, `runTakoInitial`, and `runTako`.

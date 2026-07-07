# Design: `tako-search` — a search-only Tako research provider

**Date:** 2026-07-07
**Status:** Approved (design)
**Author:** Eric + Claude

## Summary

Add a **4th provider**, `tako-search` (label **"LLM + Tako (search-only)"**), that reuses
the *entire* existing Tako recursive research engine — question decomposition tree,
leaf/branch synthesis, compose report, web-source filtering, publisher sources, and the
follow-up path — and changes **exactly one thing**: how a leaf turns a sub-question into
`takoSearch` queries.

The existing `tako` provider (graph-grounded) must remain **behaviorally identical**. This
is a purely additive feature that also serves as an A/B testing structure: run the same
question through `tako` (graph-grounded) and `tako-search` (query-only) and compare.

## Motivation

The current `tako` leaf grounds every query in the Tako graph: `graphSearch` (name → node)
+ `graphRelated` (node → metrics Tako actually has), then an LLM `metricFilter` emits one
query per confirmed entity×metric pair. This is precise but graph-dependent.

We want a variant that skips the graph entirely and lets the LLM invent search queries
straight from the sub-question text — to measure how much the graph grounding actually
buys us, and to have a simpler path when the graph is sparse.

## Behavior

The two providers differ at a single step in the research tree. Everything else is shared.

| Step | `tako` (existing) | `tako-search` (new) |
|---|---|---|
| Route (initial vs. follow-up) | same | same |
| Decompose question → sub-question tree | same | same |
| Extract entities/metrics (from decompose) | used for grounding | **ignored** |
| `graphSearch` + `graphRelated` | yes | **removed** |
| `metricFilter` / `groundedQueries` / `fallbackQueries` | yes | **removed** |
| Compose leaf queries | from confirmed graph entity×metric pairs | **LLM writes 1–3 queries straight from the sub-question text** |
| Compose broad/overview queries (root) | `resolveGraph` + `BROAD_COMPOSE` | **LLM writes 1–2 queries from the overall question** |
| `runSearches` → findings → leaf/branch synthesis → compose report | same | same |
| Follow-up turns (`takoAnswer`) | same | same (already graph-free) |

Notes:
- **Question decomposition stays.** The tree structure (branch/leaf, `MAX_DEPTH`,
  `MAX_CHILDREN`, caps) is unchanged. Only leaf query generation changes.
- **Entities/metrics still get produced** by the shared decompose step but are **ignored**
  by the search strategy (not passed to the graph, because there is no graph step). They
  remain available on the trace for parity but carry no grounding meaning for this provider.
- Leaf query count stays capped at **1–3** (`LEAF_QUERY_CAP`) and passes through
  `diversifyQueries` so we never fire near-duplicate searches.
- Broad/overview stays capped at **1–2** queries.

## Architecture: the `QueryStrategy` seam

One engine, two behaviors, selected by a strategy object stored on `ResearchCtx`.

```ts
// lib/agents/tako/strategy.ts
export interface QueryPlan {
  queries: string[];
  graph: { entity: string; related: string[] }[]; // provenance for the trace; [] for search-only
}

export interface QueryStrategy {
  // Leaf: turn a sub-question into the searches to run (+ graph provenance for the trace).
  leafQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[]): Promise<QueryPlan>;
  // Root broad/overview fetch.
  broadQueries(ctx: ResearchCtx, question: string, entities: string[], metrics: string[]): Promise<QueryPlan>;
}
```

- **`graphStrategy`** — the current behavior, **moved out of `research.ts` verbatim**:
  - `leafQueries` = today's `resolveGraph` + `groundedQueries` (with the `fallbackQueries`
    and free-form `COMPOSE` fallbacks intact). `graph` = resolved entities → related metrics.
  - `broadQueries` = today's `resolveGraph` + `BROAD_COMPOSE`.
  - This is a **pure extraction**: same code, same prompts, same behavior. The existing
    tako tests are the equivalence guardrail.
- **`searchStrategy`** — new:
  - `leafQueries` = one `generateStructured` call with `SEARCH_LEAF_COMPOSE_SYSTEM` over the
    sub-question, `zQueries` schema, deduped + `diversifyQueries`-capped to `LEAF_QUERY_CAP`.
    Returns `graph: []`.
  - `broadQueries` = one call with `SEARCH_BROAD_COMPOSE_SYSTEM`, capped to 2. Returns
    `graph: []`.

`research.ts`'s `leaf()` and `broadFetch()` stop calling graph functions directly and call
`ctx.strategy.leafQueries(...)` / `ctx.strategy.broadQueries(...)`. **No other logic in
`research.ts` changes.** The `graph` field of the returned `QueryPlan` feeds the existing
`ctx.tree[].graph` for the trace.

The strategy is threaded from the registry down:

```
registry:  tako        → runTako(r, e)                    // default → graphStrategy
           tako-search  → runTako(r, e, searchStrategy)
agent.ts:  runTako(req, emit, strategy = graphStrategy)
pipeline:  runTakoInitial(req, emit, strategy = graphStrategy)
research:  newResearchCtx(req, ledger, push, emit, strategy = graphStrategy)  → ctx.strategy
```

Every new parameter defaults to `graphStrategy`, so **every existing caller is unaffected**.

## Files

### New (additive)
- `lib/agents/tako/strategy.ts` — `QueryStrategy` / `QueryPlan` types, `graphStrategy`
  (extracted `resolveGraph` / `groundedQueries` / `fallbackQueries` / broad-compose logic),
  and `searchStrategy`.
- `lib/agents/tako/strategy.test.ts` — unit tests for `searchStrategy`.

### New prompts (additive; existing prompts untouched)
- `SEARCH_LEAF_COMPOSE_SYSTEM` in `prompts.ts` — "write 1–3 independent, non-duplicate
  Tako `/v3/search` queries that directly answer this ONE sub-question; each query a
  distinct angle, no near-duplicates, no graph."
- `SEARCH_BROAD_COMPOSE_SYSTEM` in `prompts.ts` — the 1–2-query broad/overview variant.

### Edited (additive params only; existing behavior preserved by defaults)
- `lib/agents/tako/research.ts` — `leaf()` / `broadFetch()` call `ctx.strategy.*`;
  `ResearchCtx` gains `strategy`; `newResearchCtx(..., strategy = graphStrategy)`. Move
  `resolveGraph` / `groundedQueries` / `fallbackQueries` into `strategy.ts`.
- `lib/agents/tako/pipeline.ts` — `runTakoInitial(req, emit, strategy = graphStrategy)`.
- `lib/agents/tako/agent.ts` — `runTako(req, emit, strategy = graphStrategy)`.
- `lib/providers/registry.ts` — add `tako-search` provider def (`tako_graph: false`,
  otherwise same capabilities as `tako`) → `runTako(r, e, searchStrategy)`.
- `lib/schema.ts` — `ProviderId` union += `"tako-search"`.
- `lib/sessions.ts` — `Provider` union += `"tako-search"`.
- `components/ProviderControls.tsx` — `PROVIDERS` list += `{ id: "tako-search", label: "LLM + Tako (search-only)" }`.

Note: `ProviderId` (schema), `Provider` (sessions), and the `PROVIDERS` UI list are the
same three-value union declared in three places; all three must add the new id.

## Trace

- Search-strategy nodes carry `graph: []`. `TraceView` / `TraceNode` already render the
  per-node graph block only when it has entries, so no trace UI change is required
  (verify during implementation; add a guard if one is missing).
- `ctx.calls` will contain **only `search` endpoint calls** for `tako-search` (no
  `graph/search` or `graph/related`) — this is what the pipeline test asserts.

## Testing

- **`strategy.test.ts` (new):** `searchStrategy.leafQueries` composes queries from a
  sub-question, returns `graph: []`, respects `LEAF_QUERY_CAP`, and de-duplicates via
  `diversifyQueries`. `broadQueries` caps at 2 and returns `graph: []`. (LLM call mocked.)
- **Pipeline test (new):** run `runTakoInitial(req, emit, searchStrategy)` against mocked
  `takoSearch`; assert a tree is built, searches run, findings/synthesis produced, and
  **zero graph calls** were issued (`graphSearch`/`graphRelated` not invoked).
- **Regression guardrail:** all existing `tako` tests (`pipeline.test.ts`,
  `queries.test.ts`, `findings.test.ts`, `followup.test.ts`, `compose.test.ts`) stay
  green unchanged — proof the graph provider is byte-for-byte the same after extraction.

## Out of scope (YAGNI)

- No query refinement / critique second pass.
- No changes to decomposition, synthesis, compose report, or follow-up logic.
- No new canvas node types or trace UI redesign.
- No change to the graph-grounded `tako` provider's behavior.

## Risks

- **Extraction drift:** moving `resolveGraph`/`groundedQueries`/`fallbackQueries` into
  `strategy.ts` could subtly change behavior. Mitigation: move code verbatim; rely on the
  unchanged existing tako test suite as the equivalence check before touching anything else.
- **Query quality without grounding:** LLM-invented queries may retrieve less relevant
  cards than graph-confirmed ones. That is the *point* of the experiment; the compose/
  synthesis layers already tolerate empty/low-relevance findings (pruned leaves).

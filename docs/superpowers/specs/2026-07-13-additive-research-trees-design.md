# Additive research trees for the canvas assistant

**Date:** 2026-07-13
**Status:** Approved design, pending implementation plan

## Problem

The canvas assistant funnels every follow-up into one of three constrained lanes:

- **EXPLAIN** answers from board context and never mints nodes (and the router
  prompt says "when in doubt, prefer EXPLAIN").
- **AUGMENT / GENERATE** mint exactly **one** leaf node anchored to the selection
  (`component.ts`).
- **REPLACE** is the only path into the full recursive research pipeline
  (`pipeline.ts` → `research.ts`), and it **wipes the whole board** first.

So "do more research on X" either gets a prose answer, a single card, or destroys
the existing board. There is no way to grow a **new research tree next to the
existing ones**, and no way for new work to link back to related existing branches.

## Goals

1. **Answering stays the default.** A one-part / data question ("why did X jump?",
   "how much is Y?") looks at current board info, grounds with `tako_answer`, and
   just responds — exactly today's EXPLAIN lane, unchanged.
2. Only when the user **states or shows they want more on the graph** ("research X",
   "dig into this", "explore", "build out a tree on Y") does the assistant build a
   **full new research tree** beside the existing ones — a mirror of the initial
   pipeline (decompose → parallel leaves → gap-fill round → composed report).
3. New trees **connect to existing branches/trees when directly related** —
   deterministic anchor to the selection plus LLM-proposed semantic edges.
4. **Context scoping:** if a node/tree is selected, the planner sees that tree's
   context; if nothing is selected it sees all nodes but only their front-facing
   information (titles/summaries — never chart points, CSVs, or report bodies).
5. Board wipes happen **only on explicit restart** ("start over", "clear this and
   look at Y instead").

## Non-goals

- No changes to the EXPLAIN answer lane's retrieval or grounding.
- No changes to AUGMENT/GENERATE (single-component lane stays for "add a chart of…").
- No layout rework — `treeLayout` in `lib/layout.ts` already places multiple roots
  side-by-side.
- No new providers or Tako endpoints.

## Design

### 1. Routing (`lib/agents/shared/router.ts`)

Add a fifth action to the enum: `RESEARCH`.

```
zRouteAction = z.enum(["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN", "RESEARCH"])
```

Rewritten prompt contract:

- **EXPLAIN** — the default for questions. Any single-part / data / explanation
  question, even about a new subject: answer from the board + a grounded Tako
  answer; the board does not change.
- **RESEARCH** — the user explicitly wants more research ON THE CANVAS: verbs like
  "research", "dig into", "explore", "investigate", "expand", "build out", "map
  out", or a clear request for a multi-facet investigation of something not already
  covered. Builds a new tree next to the existing ones; never clears.
- **REPLACE** — ONLY an explicit restart: "start over", "clear the board",
  "scrap this and do Y instead". Ambiguous new-topic questions are NOT replace —
  they are EXPLAIN (question) or RESEARCH (research intent).
- **AUGMENT / GENERATE** — unchanged (one supporting card / one explicit component).
- Empty board: deterministic REPLACE as today (no router call).
- Router hard-failure default stays EXPLAIN.

### 2. Root-id parameterization (`flow.ts`, `research.ts`, `gaps.ts`, `compose.ts`, `pipeline.ts`)

Today the tree root is the hard-coded `SYNTH_ID = "synth"`. A second tree needs its
own root. Add `rootId: string` to `ResearchCtx`:

- `newResearchCtx(...)` gains an options arg `{ rootId?: string }`, defaulting to
  `SYNTH_ID`; `usedIds` is seeded with `ctx.rootId`.
- `synthNode(headline, summary)` becomes `synthNode(id, headline, summary)`.
- Every `SYNTH_ID` reference on the research path reads `ctx.rootId` instead:
  `research.ts` (root nodeId, grounding call ids), `gaps.ts` (gap answers'
  `derivedEdge` target), `compose.ts` (contents call ids), `pipeline.ts`
  (synthesis events, tree-entry patching, final `update_node`).
- The initial REPLACE turn passes nothing and behaves byte-identically
  (`rootId === "synth"`).

### 3. Shared tree runner + the RESEARCH lane (`pipeline.ts`, new `expand.ts`)

Extract the core of `runTakoInitial` (research → gap round → compose → synth patch
→ trace assembly) into a shared `runResearchTree(req, ctx, emit)` inside
`pipeline.ts`, so the additive lane is not a 130-line copy. `runTakoInitial`
becomes a thin wrapper (fresh ctx, default rootId).

New `lib/agents/tako/expand.ts` — `runTakoExpand(req, historyText, emit, strategy)`:

1. Build ctx with `rootId = uniqueResearchId(ctx, req.message)`-style unique synth
   id (e.g. `synth_<slug>`); seed `ctx.usedIds` with every existing board node id
   (the component lane already does this).
2. The decompose/planner prompts receive the **scoped context block**
   (section 5) instead of the full `ctxBlock` board dump.
3. Run `runResearchTree` — streams the new tree live exactly like the initial run.
4. **No remove ops.** Purely additive.
5. Cross-links (section 4).
6. Zero evidence anywhere → degrade to `runAnswerLane` carrying the notes
   (same pattern as `component.ts`'s `degrade()`); a RESEARCH turn never dies.

`agent.ts` dispatch:

```
action === "REPLACE"  → runTakoInitial (with board-clearing remove ops, as today)
action === "RESEARCH" → runTakoExpand   (no remove ops)
action === "EXPLAIN"  → runAnswerLane
else                  → runComponentLane
```

### 4. Cross-tree connections

- **Deterministic anchor:** if a selection exists, emit
  `derivedEdge(newRootId → root of the selected node's tree)` (walk
  `getAncestors` from `lib/lineage.ts`; the selected node itself if it has no
  ancestors). No selection → no anchor edge.
- **LLM semantic links:** after compose, one cheap structured call
  (`generateStructured`, OpenAI): input = the new tree's root verdict + leaf
  titles, plus existing nodes' `{id, title, summary}` (front-facing only);
  output = 0–3 proposed edges `{from, to, kind: supports|contradicts}` where the
  new tree genuinely bears on an existing node. Proposals whose ids are not real
  board/new-tree node ids are dropped in code. Everything then flows through the
  existing `finalizeOps` → `validateGraph` (dedupe by `(from,to)` pair, cycle
  rejection, fan-in cap). Failure of this call is a trace note, never fatal —
  worst case the trees sit side by side.

### 5. Scoped context builder (`lib/agents/shared/ctx.ts`)

New `scopedCtxBlock(req, historyText)` used by the RESEARCH lane's planning
prompts (decompose, cohort, cross-link):

- **Selection present:** the selected node's whole tree = selection ∪
  `getAncestors` ∪ `getDescendants` (from `lib/lineage.ts`). Include front-facing
  info (`id`, `type`, `title`, `summary`, `section`) for every tree node; full
  content (`nodeContentBlock`) only for the selected nodes themselves.
- **No selection:** front-facing info for **all** content nodes — never chart
  points, CSV data, consensus rows, or report bodies.
- Always includes MESSAGE / SURFACE / SELECTION / CONVERSATION SO FAR /
  CURRENT_EDGES, same as `ctxBlock`.

**Plumbing:** `research.ts`, `compose.ts`, and `gaps.ts` call `ctxBlock(ctx.req)`
directly inside their prompts, so the scoped block must ride on the ctx:
`ResearchCtx` gains `ctxText: string` (built once per turn), defaulting to
`ctxBlock(req)`; those call sites read `ctx.ctxText` instead. The initial REPLACE
turn is unaffected (empty/cleared board → identical output).

The EXPLAIN answer lane keeps `ctxBlock` + full retrieval unchanged.

### 6. Frontend focus (`app/page.tsx`)

`setFocusNodeId("synth")` is hard-coded after a main-surface run. Change to: focus
the newest synthesis-role node found in the applied ops (last
`add_node`/`upsert_node` whose node has `role === "synthesis"`), falling back to
`"synth"`. The narration fallback `synthBuf["synth"]` likewise falls back through
the new root id. No other UI changes — `NodeCard`, `treeLayout`, and the trace
panel already handle research/synthesis roles generically.

## Error handling

- Router failure → EXPLAIN (unchanged).
- RESEARCH with no evidence → degrade to answer lane with notes (never a dead turn).
- Cross-link LLM failure or invalid ids → dropped + trace note.
- All new edges pass `validateGraph` (cycles, dupes, hairballs, missing nodes).

## Testing

TDD; extend the existing mocked-strategy test harness (`pipeline.test.ts` pattern):

1. **Router** (`router` cases in agent tests): one-part data question → EXPLAIN;
   "research/dig into/explore X" → RESEARCH; "start over with Y" → REPLACE;
   schema accepts RESEARCH.
2. **Expand lane** (`expand.test.ts`): unique root id when a `synth` node exists;
   no `remove_node` ops; existing board ids seeded into `usedIds` (no collisions);
   anchor `derivedEdge` to the selected tree's root; degrade path when zero
   findings; trace carries tree + calls keyed on the new root id.
3. **Root-id parameterization**: initial pipeline still emits `synth` everywhere
  (byte-identical trace node ids) — existing `pipeline.test.ts` must pass unmodified.
4. **Scoped context** (`ctx` tests): selection → tree-only front-facing block +
   full content for the selected node; no selection → all nodes, and assert chart
   points/CSV/report bodies are absent.
5. **Cross-links**: proposed edges with unknown ids dropped; duplicate `(from,to)`
   and cycle-closing proposals removed by `validateGraph`.

## Files touched

| File | Change |
| --- | --- |
| `lib/agents/shared/router.ts` | add RESEARCH, rewrite prompt contract |
| `lib/agents/shared/ctx.ts` | add `scopedCtxBlock` |
| `lib/agents/tako/flow.ts` | `rootId` on ctx, `synthNode(id, …)` |
| `lib/agents/tako/research.ts` / `gaps.ts` / `compose.ts` | `SYNTH_ID` → `ctx.rootId` |
| `lib/agents/tako/pipeline.ts` | extract shared `runResearchTree` |
| `lib/agents/tako/expand.ts` (new) | the RESEARCH lane |
| `lib/agents/tako/prompts.ts` | cross-link system prompt |
| `lib/agents/tako/agent.ts` | dispatch RESEARCH |
| `app/page.tsx` | focus newest synthesis node |

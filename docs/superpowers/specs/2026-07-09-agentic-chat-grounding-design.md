# Agentic chat grounding — tako answer + contents + component generation

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan
**Scope:** The tako provider's follow-up/chat turns and the router. The initial
(empty-board) research-tree pipeline is unchanged and remains the target REPLACE
routes into.

## Problem

The tako+LLM chat path (`lib/agents/tako/agent.ts` → `followup.ts`) is not agentic:

- A fixed if/else makes at most **one** `takoAnswer` call and never fetches the
  underlying data (`/v1/contents` CSV) behind board nodes — even though every
  tako-grounded node carries `tako.webpageUrl` and the machinery already exists
  (`fetchContents` in `flow.ts`, the composer's `get_card_contents` loop in
  `compose.ts`).
- Selected nodes reach the prompt as a shallow serialization (title, summary,
  8-point chart excerpt); report blocks, criteria, and searches are omitted.
- The chat cannot mint new components: AUGMENT drops raw answer cards on the
  board instead of routing through the subquery answer node machinery
  (`researchLeaf` with graph search + related) the initial pipeline uses.
- Answers do not cite which nodes/data they used in a clickable way.

## Design overview

Approach: **extended router + bounded gather loop** (chosen over a single full
tool-loop agent, and over plan-then-fetch without iteration).

```
message ──► empty board? ──yes──► initial research-tree pipeline (unchanged, no router call)
                │ no
                ▼
         router (4 actions)
        ┌────────┬──────────┬──────────┬─────────┐
        │REPLACE │ AUGMENT  │ GENERATE │ EXPLAIN │
        ▼        ▼          ▼          ▼
   initial   research    research    answer lane
   pipeline  lane        lane        (gather loop)
```

## 1. Router (`lib/agents/shared/router.ts`)

`zRouteAction` becomes exactly `REPLACE | AUGMENT | GENERATE | EXPLAIN`.
`NEW_BOARD` and `REFRAME` are deleted.

- **Empty board bypasses the router entirely.** `agent.ts` already forces the
  initial pipeline when the board is empty; with NEW_BOARD gone as a router
  output, the router LLM call is skipped on first turns (latency win).
- **REPLACE** — "start over / investigate something else": routes to the full
  initial research-tree pipeline (`runTakoInitial`); its ops replace the board.
  This absorbs what NEW_BOARD meant on a non-empty board.
- **AUGMENT** and **GENERATE** — research lane (§3). GENERATE is an explicit
  "make me a component" request ("add a chart of…", "create a comparison
  of…"); AUGMENT is "add data about X to what's here". Both mint a subquery
  answer node; the distinction is kept for routing legibility and traces.
  Today's AUGMENT behavior (loose answer-cards dropped near an anchor) goes
  away.
- **EXPLAIN** — answer lane (§2). Never mints nodes.
- REFRAME's "change criteria only" case folds into EXPLAIN/AUGMENT; the
  `recompute_consensus` op remains available to the lanes.
- Router prompt is rewritten with the 4 actions plus discriminating examples
  (GENERATE vs AUGMENT vs EXPLAIN), keeping the existing selection-preference
  and reference-resolution guidance.

## 2. Answer lane — the gather loop (`lib/agents/tako/chat.ts`, new)

Two-phase, modeled on the composer's proven pattern in `compose.ts`
(`gatherCardContents` → tool-free emit).

### Phase A — gather (OpenAI `generateText` tool loop, `maxSteps: 6`)

Prompt context:

- `ctxBlock` as today (message, history, selection-first BOARD CONTEXT).
- A **node catalog**: every content node's `{id, type, title, section,
  hasData}` (`hasData` = has a `tako.webpageUrl` whose contents can be
  fetched), so the model knows what exists beyond the retrieved set.
- **Selected nodes serialized in full** — `fmtNode` (in
  `lib/agents/shared/retrieval.ts`) upgraded to also serialize report blocks
  (verdict + per-block compact rendering: table rows, leaderboard rows,
  section titles/figures, timeline events), `criteria` weights, and
  `searches`. Compact but complete: clicking a node exposes the component.

Tools:

- **`tako_answer({query})`** → `takoAnswer()` (`/v1/answer`, effort "fast").
  Returns grounded prose + card titles as the tool result. Cards are evidence
  for grounding only — the answer lane never nodes them onto the board.
  **Omitted from the toolset entirely when `takoAnswerEnabled` is false**
  (kill-switch preserved).
- **`get_node_contents({nodeId})`** → resolves the node's `tako.webpageUrl` →
  `takoContents()`; CSV excerpted via the existing `excerptCsv`. Web-source
  nodes return page text. Per-turn cache keyed by URL; fetch budget 8
  (mirrors `COMPOSER_CONTENTS_BUDGET`). Unknown node id → helpful tool result
  listing valid ids (not a throw).

Every tool call emits a live `tako_call` trace event (`/v1/answer` or
`/v1/contents`) so TraceView renders the gathering exactly like pipeline calls.

Gotcha honored: the gather call passes **no `reasoningEffort`** — OpenAI
rejects tools + reasoning_effort on chat completions (commit f4da8e7).

### Phase B — answer (streamed)

`streamAnswer` composes the final prose from board context plus everything
Phase A fetched, appended as `GROUNDED_ANSWER` block(s) and
`FETCHED_CONTENTS` excerpts. Tokens stream to the client as today; side-chat
turns land in `sideReply`.

`groundedIn` (in `TurnTrace`) grows a `contents` field:

```ts
groundedIn: {
  nodes: {id, title}[],
  takoAnswerUsed: boolean,
  cards: {id, title, url}[],
  contents: {nodeId, cardId, title, rows}[],   // NEW — one per contents fetch
}
```

## 3. Research lane — GENERATE / AUGMENT

1. **Distill**: a structured call (`zComponentPlan`) turns message + selection
   context into `{question, entities: string[] (1-3), subtype?, metricFilters:
   string[] (1-5)}` — the same lookup shape `researchLeaf` consumes. Selection
   informs the distilled question ("chart this for Germany too" with a
   France-inflation node selected → Germany-inflation question). On schema
   failure: one corrective retry naming the violation (the established
   decompose pattern), then degrade to the answer lane.
2. **Research**: run the existing `researchLeaf` with a fresh `newResearchCtx`
   (graph strategy: graph search + related compose the queries; data cards
   stream onto the board feeding the new subquery answer node; the node's
   synthesis streams live). No changes to `researchLeaf` semantics.
3. **Anchor**: after the leaf completes, add a `derived_from` edge from the new
   research node to `selection[0]`, else the board's synthesis node, else no
   edge — so layout places it beside what the user was looking at.
4. **Narrate**: the chat message is a one-liner + the leaf's synthesis; the
   trace carries the leaf's queries/calls/graphCalls as usual, so thread and
   board tell the same story.

If the leaf finds nothing (`nodeId: null`), the turn degrades to the answer
lane with a note ("couldn't find data to build that component — here's what I
know…"). Never a dead turn.

## 4. Click exposure — both directions

- **Canvas → chat**: transport is already wired (`selection.nodeIds` →
  `retrieveNodes` selection-first). The upgrade is depth: full `fmtNode`
  serialization + node catalog + `get_node_contents` means a clicked node
  exposes the component — report blocks and underlying CSV series, not just
  title/summary.
- **Chat → canvas**: a **`GroundedChips`** component renders under the answer
  in `ChatPanel`, fed from `trace.groundedIn` (nodes + contents): "Grounded
  in: ⬡ France CPI · ⬡ Germany CPI (data)". Each chip calls the existing
  `onSelectNode` to select/zoom the node on canvas. `TraceView` already
  receives `onSelectNode`; this is a sibling component, no new plumbing.

## 5. Error handling

"Never kill the turn" throughout:

- Tool failures return as tool **results** ("contents unavailable: …") so the
  loop continues; each also lands in `notes[]` and its `tako_call` trace
  record with `error`.
- Gather-loop hard failure → fall back to the current simple path (board
  context + one optional `takoAnswer`), noted in trace. `runTakoFollowup`'s
  present body survives as this fallback.
- Distill failure → one corrective retry, then answer lane.
- Tool args Zod-validated at the boundary.

## 6. Testing (vitest, existing mock patterns)

- **Router**: 4-action discrimination cases (GENERATE vs AUGMENT vs EXPLAIN),
  REPLACE → initial pipeline, empty-board bypass skips the router call.
- **Gather loop** (mocked llm/tako, per `pipeline.test.ts` conventions): tool
  budget + per-turn cache enforcement; kill-switch removes `tako_answer` from
  the toolset; error-as-tool-result keeps the loop alive;
  `groundedIn.contents` recorded per fetch; `tako_call` events emitted.
- **Research lane**: distill schema (+ corrective retry); `researchLeaf`
  called with the distilled lookup; anchor edge to selection / synthesis /
  none; `nodeId: null` degradation to answer lane.
- **Serialization**: `fmtNode` renders report blocks, criteria, searches.
- **Component**: `GroundedChips` renders from `groundedIn` and click calls
  `onSelectNode` (pattern from `ComparisonChart.test.tsx`).

## Out of scope

- The initial research-tree pipeline (decompose, cohort, gap-fill, composer).
- Baseline providers (`gpt`, `claude`).
- Multi-turn tool memory beyond the existing folded-history summary.
- `tako_agent` / `tako_visualize` remain forbidden (CLAUDE.md).

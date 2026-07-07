# Context-Aware Grounded Chat — Design

**Date:** 2026-07-06
**Status:** Approved (pre-implementation)
**Branch target:** `stage1-agentic-core`

## Goal

Make the Canvas Assistant understand three things it currently does not, and prove
what it used to answer:

1. **The conversation so far** — the backend is stateless today; each turn sees only
   the current message. "Tell me more about that" has no referent.
2. **The canvas content** — `ctxBlock` sends node *metadata* only (id/type/title/
   grounding), never the actual content (summaries, chart data, consensus rows).
3. **The selection** — selection ids are already passed and the router prefers
   `EXPLAIN`, but the answer is not grounded in the *content* of the selected nodes.

Then: answer **board-first** from retrieved node content, and surface exactly which
nodes / Tako grounding fed the answer.

### Constraints (from CLAUDE.md + prior decisions)
- Stack stays **Vercel AI SDK (`ai@4`) + Zod**, server-only, React 18.3 / Next 14.2.
- **No new framework** (no LangChain / Mem0), **no embeddings / vector store**.
- Backend stays stateless — history is sent per-request from the client session store.
- Follow-up / side-chat traces remain **live-only** (not persisted); main-turn Tako
  search calls still persist. (Established in the prior session.)

## Non-goals (YAGNI)

- Embeddings / vector similarity retrieval.
- LangChain / Mem0 / any new memory framework.
- Cross-session long-term user memory (facts extracted over time).
- Persisted follow-up traces.
- Per-claim inline citations in the answer prose.

---

## 1. Chat memory — windowed history + rolling summary

The industry-standard short-term-memory pattern (which LangChain's
`BufferWindowMemory` / `SummaryMemory` are thin wrappers over): send a window of
recent turns, and replace older turns with an LLM summary once the thread grows.

### Contract change (`lib/schema.ts`)
`AgentRequest` gains:
```ts
history: ChatTurn[];        // recent turns, verbatim (trace/steps stripped)
historySummary?: string;    // rolling summary of turns older than the window
```
where `ChatTurn = { role: "user" | "agent"; text: string; surface: Surface; focus?: string[] }`.

### Client (`app/page.tsx` + `lib/sessions.ts`)
- A `buildHistory(session)` helper (in `sessions.ts`) returns the **last N = 8**
  turns as `ChatTurn[]`, stripping `trace`/`steps`/`kind`/`icon`.
- The request body gains `history` and `historySummary: session.summary`.

### Rolling summary (`lib/agents/shared/memory.ts`, new)
Summarization runs **on the server, inside the turn** — one module, no new route,
backend stays stateless. The client sends the full window `history` plus the last
known `historySummary`; the server folds anything beyond the window into the summary
before prompting.

- `foldHistory({ history, historySummary }, summarize)` — the pure entry point. It
  splits `history` into the **last N = 8** turns (`windowTurns`, verbatim) and any
  older turns; older turns are folded into `historySummary` via the injected
  `summarize(text)` fn. Returns prompt-ready `{ summaryText, windowTurns, summary }`.
  `summary` is the updated rolling summary the client should cache.
- The updated `summary` is returned to the client on the `result` event so it can be
  cached on the session; `Session` gains `summary?: string` and `summaryUpToId?:
  string` (id of the newest turn already folded in) so the next request sends the
  latest cached summary and only genuinely-new-and-aged-out turns get re-summarized.
- `memory.ts` stays pure and fully unit-testable: the LLM `summarize` call is
  injected, so tests stub it.

---

## 2. Nodes as RAG — `lib/agents/shared/retrieval.ts` (new)

Boards are small (~5–50 nodes) and node content fits in context, so retrieval is
**structured**, not vector-based.

```ts
retrieveNodes(state, selection, message, k = 6): RetrievedNode[]
```
- **Selection-first:** if `selection.nodeIds` is non-empty, the retrieved set *is*
  those nodes (full content), in selection order. No ranking.
- **Else heuristic rank:** score each node by normalized token overlap between the
  message and the node's `title` + `summary` + `section`, with small boosts for
  `grounding === "tako"` and recency (later nodes rank higher on ties). Take top-K.

```ts
nodeContentBlock(nodes): string
```
- Serializes **full** content per node: `title`, `summary`, `metric` (value/label/
  delta), a digest of `chartSpec` (kind + unit + up to ~8 points per series),
  `consensusRows` (rank/entity/score), and `sources`/`tako` refs. This replaces the
  metadata-only node list in `ctxBlock`.

---

## 3. Pipeline wiring (board-first)

### `ctxBlock` (`lib/agents/shared/ctx.ts`)
Extended to include: windowed history + summary (from `memory.ts`), and the
**retrieved node content block** (from `retrieval.ts`) in place of today's raw
metadata list. Still includes selection ids and edges.

### Router (`lib/agents/shared/router.ts`)
Prompt receives history summary + node menu so routing is context-aware — e.g.
"tell me more about that" resolves to `EXPLAIN`/`AUGMENT` on the referent instead of
being misread as a fresh board.

### Follow-up path (`lib/agents/tako/followup.ts`)
Board-first:
1. Build retrieved context (selection-first or top-K).
2. Answer from node content.
3. Call `takoAnswer` **only** when the board is insufficient:
   - router action is `AUGMENT` / `REPLACE` (user explicitly wants new data), or
   - `EXPLAIN` but retrieval returned nothing usable (empty board / no match).
   When Tako is called, the answer says so.
4. `EXPLAIN` with sufficient board content **skips Tako entirely**.

Track which nodes and cards were actually used → `groundedIn` (below).

---

## 4. Provenance — "Grounded in" in the trace

### Types (`lib/agents/shared/types.ts`)
`PipelineResult.trace` and `TurnTrace` gain:
```ts
groundedIn?: {
  nodes: { id: string; title: string }[];
  takoAnswerUsed: boolean;
  cards: { id: string; title: string; url: string }[];
};
```

### UI (`components/TraceView.tsx`)
New **"Grounded in"** block rendering:
- node chips (one per grounded node),
- Tako cards / answer-grounding indicator when `takoAnswerUsed`.

Clicking a node chip **selects + highlights it on the canvas** via a new
`onSelectNode(id: string)` prop threaded `TraceView → ChatPanel → page.tsx`, wired
into the existing `selection` state setter. This closes the loop with the
selection-focus feature (chip click → canvas focus → next question is scoped).

### Persistence (`lib/sessions.ts`)
- Follow-up/side-chat traces stay live-only (unchanged).
- Main-turn `slimTrace` keeps `groundedIn` node ids/titles (cheap to persist).

---

## 5. Testing (TDD — write tests first)

- **`lib/agents/shared/retrieval.test.ts`** — selection-first returns exactly the
  selection; keyword ranking orders by overlap; top-K cap; `nodeContentBlock`
  serializes metric/chart/consensus/sources.
- **`lib/agents/shared/memory.test.ts`** — window boundary (≤N verbatim, >N folds);
  summary trigger threshold; incremental reuse of a cached summary; injected
  `summarize` stub.
- **`lib/agents/tako/followup.test.ts`** (extend) — board-first answers without a
  Tako call when retrieval suffices; Tako fallback fires on empty board / AUGMENT;
  `groundedIn` populated with the nodes/cards actually used.
- **Component** — `TraceView` renders the grounded-in block and chip-click invokes
  `onSelectNode`; `ChatPanel` focus banner (already covered) still passes.

Target: keep the ≥80% coverage bar; all new pure modules fully unit-tested.

---

## 6. Files touched

| File | Change |
|------|--------|
| `lib/schema.ts` | `AgentRequest` gains `history`, `historySummary` |
| `lib/sessions.ts` | `ChatTurn` type, `buildHistory()`, `Session.summary`/`summaryUpToId`, persist summary |
| `lib/agents/shared/memory.ts` | **new** — `foldHistory()`, injected `summarize()` |
| `lib/agents/shared/retrieval.ts` | **new** — `retrieveNodes()`, `nodeContentBlock()` |
| `lib/agents/shared/ctx.ts` | include history + retrieved node content |
| `lib/agents/shared/types.ts` | `groundedIn` on `TurnTrace` / `PipelineResult.trace` |
| `lib/agents/shared/router.ts` | history-aware routing prompt |
| `lib/agents/tako/agent.ts` | pass route action into follow-up for Tako-fallback decision |
| `lib/agents/tako/followup.ts` | board-first answer; populate `groundedIn` |
| `components/TraceView.tsx` | "Grounded in" block + clickable node chips |
| `components/ChatPanel.tsx` | thread `onSelectNode` prop |
| `app/page.tsx` | build+send history; wire `onSelectNode` into `selection` |
| `app/api/agent/route.ts` | accept/pass `history`, `historySummary` |
| test files above | TDD coverage |

## Key defaults (confirmed)
- History window **N = 8** turns.
- Retrieval **top-K = 6** nodes.
- Node-chip click threads back into canvas `selection`.

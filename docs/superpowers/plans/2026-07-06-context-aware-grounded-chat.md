# Context-Aware Grounded Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Canvas Assistant understand the conversation history and the canvas contents, answer board-first from the user's selection/retrieved nodes, and show exactly which nodes / Tako grounding fed each answer.

**Architecture:** No new framework. Short-term memory = windowed recent turns + an incrementally-cached LLM summary of older turns (folded server-side per turn). Nodes act as RAG via structured selection-first + heuristic top-K retrieval (no embeddings). The follow-up pipeline answers from retrieved node content and only calls Tako when the board can't answer or the user asked for new data. A `groundedIn` block on the trace records the nodes/cards used; the trace UI renders them as chips that re-focus the canvas.

**Tech Stack:** Next 14.2 / React 18.3, Vercel AI SDK (`ai@4`) + Zod, Vitest (node environment — `lib/**/*.test.ts` only). LLM helpers in `lib/llm.ts` (`generateFreeText`, `streamAnswer`, `generateStructured`). Text helpers in `lib/text.ts` (`tokenize`, `jaccard`).

## Global Constraints

- **No new dependencies.** No LangChain / Mem0 / vector store / embeddings. Stack stays Vercel AI SDK + Zod.
- **Backend stays stateless.** All history arrives per-request from the client session store; server returns updated summary for the client to cache.
- **Tests are node-only and live in `lib/**/*.test.ts`.** All new logic must be a pure function in `lib/` and unit-tested. `.tsx` component changes are untested UI (matches existing repo pattern) and are gated by `npm run build` + a manual smoke check.
- **Immutability.** Never mutate inputs; return new objects/arrays (per repo coding-style rule).
- **Follow-up / side-chat traces stay live-only** (not persisted); main-turn Tako search calls still persist via `slimTrace`.
- **OpenAI model uses `structuredOutputs:false`** (already handled in `lib/llm.ts`) — do not change schemas to all-required.
- History window **N = 8**; retrieval **top-K = 6**.
- Run all tests with `npm test` (`vitest run`). Run a single file with `npx vitest run <path>`.

**Refinement over the spec (incremental memory):** the spec's §2 says the client sends "the last N=8 turns." For incremental summarization to work, the client instead sends **all turns not yet folded into the cached summary** (turns after `summaryUpToId`) plus the cached `historySummary`; the server windows those into the last 8 verbatim + folds the remainder into the summary. Same intent (window + rolling summary), corrected data flow.

---

### Task 1: Wire contract types + `buildHistory`

Adds the request/response wire fields and the client helper that extracts sendable turns. Pure logic (`buildHistory`) is unit-tested; type additions compile-check.

**Files:**
- Modify: `lib/schema.ts` (add `ChatTurn`, extend `AgentRequest`, extend `AgentResponse`)
- Modify: `lib/sessions.ts` (extend `Session`, add `buildHistory`)
- Test: `lib/sessions.test.ts` (create)

**Interfaces:**
- Produces:
  - `interface ChatTurn { id: string; role: "user" | "agent"; text: string; surface: Surface; focus?: string[] }` (in `schema.ts`)
  - `AgentRequest.history: ChatTurn[]` and `AgentRequest.historySummary?: string`
  - `AgentResponse.memory?: { summary?: string; summarizedThrough?: string }`
  - `Session.summary?: string`, `Session.summaryUpToId?: string`
  - `buildHistory(session: Session): ChatTurn[]` — messages after `summaryUpToId`, legacy `kind:"tool"` chips dropped, `trace`/`steps` stripped.

- [ ] **Step 1: Write the failing test**

Create `lib/sessions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildHistory } from "./sessions";
import type { Session } from "./sessions";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1", title: "t", createdAt: 0, state: { nodes: [], edges: [] },
    messages: [], provider: "tako", takoAnswer: false, view: { x: 0, y: 0, scale: 1 },
    ...over,
  };
}

describe("buildHistory", () => {
  it("maps messages to wire turns, dropping trace/steps and legacy tool chips", () => {
    const s = session({
      messages: [
        { id: "m1", role: "user", text: "hi", surface: "main" },
        { id: "m2", role: "agent", text: "hello", surface: "main", trace: {} as any, steps: [] },
        { id: "m3", role: "user", text: "chip", surface: "side_chat", focus: ["NVDA"], kind: "tool", icon: "x" } as any,
      ],
    });
    const turns = buildHistory(s);
    expect(turns).toEqual([
      { id: "m1", role: "user", text: "hi", surface: "main", focus: undefined },
      { id: "m2", role: "agent", text: "hello", surface: "main", focus: undefined },
    ]);
  });

  it("only returns turns after summaryUpToId", () => {
    const s = session({
      summaryUpToId: "m1",
      messages: [
        { id: "m1", role: "user", text: "old", surface: "main" },
        { id: "m2", role: "agent", text: "kept", surface: "main" },
      ],
    });
    expect(buildHistory(s).map((t) => t.id)).toEqual(["m2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/sessions.test.ts`
Expected: FAIL — `buildHistory is not a function` (not yet exported).

- [ ] **Step 3: Add the types**

In `lib/schema.ts`, add `ChatTurn` and extend the request/response interfaces. Add after the `ProviderId` type (around line 102):

```ts
export interface ChatTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  surface: "main" | "side_chat";
  focus?: string[];
}
```

Then extend `AgentRequest` (add the two fields to the existing interface):

```ts
export interface AgentRequest {
  canvasId: string;
  message: string;
  surface: "main" | "side_chat";
  canvasState: CanvasState;
  selection?: { nodeIds: string[]; nodes: Partial<CanvasNode>[] };
  providerId: ProviderId;
  takoAnswerEnabled?: boolean;
  history: ChatTurn[];
  historySummary?: string;
}
```

And extend `AgentResponse`:

```ts
export interface AgentResponse {
  canvasOps: CanvasOp[];
  narration: string;
  sideReply: string | null;
  trace?: import("./agents/shared/types").TurnTrace;
  memory?: { summary?: string; summarizedThrough?: string };
  debug?: unknown;
}
```

- [ ] **Step 4: Extend `Session` and add `buildHistory`**

In `lib/sessions.ts`, add the two fields to `Session`:

```ts
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  state: CanvasState;
  messages: ChatMsg[];
  provider: Provider;
  takoAnswer: boolean;
  view: CanvasView;
  summary?: string;
  summaryUpToId?: string;
}
```

Add the import at the top (reuse the existing `./schema` import line):

```ts
import type { CanvasState, ChatTurn } from "./schema";
```

Add the helper (place after `hasStarted`):

```ts
// Wire subset of the thread the backend needs: turns not yet folded into the
// cached summary, with client-only trace/steps and legacy tool chips stripped.
export function buildHistory(s: Session): ChatTurn[] {
  const all = s.messages;
  const start = s.summaryUpToId ? all.findIndex((m) => m.id === s.summaryUpToId) + 1 : 0;
  return all
    .slice(start)
    .filter((m) => m.kind !== "tool")
    .map((m) => ({ id: m.id, role: m.role, text: m.text, surface: m.surface, focus: m.focus }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/sessions.test.ts`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add lib/schema.ts lib/sessions.ts lib/sessions.test.ts
git commit -m "feat: history wire contract (ChatTurn, buildHistory, memory fields)"
```

---

### Task 2: Memory module — `foldHistory` + `summarizeTurns`

Pure windowing/summary folding with an injected LLM summarizer, plus the real summarizer used in production.

**Files:**
- Create: `lib/agents/shared/memory.ts`
- Test: `lib/agents/shared/memory.test.ts`

**Interfaces:**
- Consumes: `ChatTurn` (from Task 1), `generateFreeText` (from `lib/llm.ts`).
- Produces:
  - `HISTORY_WINDOW = 8`
  - `renderTurns(turns: ChatTurn[]): string`
  - `type Summarize = (turnsText: string, priorSummary?: string) => Promise<string>`
  - `foldHistory(input: { turns: ChatTurn[]; priorSummary?: string }, summarize: Summarize, window?: number): Promise<{ historyText: string; windowTurns: ChatTurn[]; summary?: string; summarizedThrough?: string }>`
  - `summarizeTurns: Summarize` (real impl for production)

- [ ] **Step 1: Write the failing test**

Create `lib/agents/shared/memory.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { foldHistory, renderTurns } from "./memory";
import type { ChatTurn } from "../../schema";

const turn = (id: string, text: string): ChatTurn => ({ id, role: "user", text, surface: "main" });

describe("foldHistory", () => {
  it("passes short threads through verbatim without summarizing", async () => {
    const turns = [turn("a", "one"), turn("b", "two")];
    const summarize = vi.fn();
    const r = await foldHistory({ turns }, summarize, 8);
    expect(summarize).not.toHaveBeenCalled();
    expect(r.windowTurns).toEqual(turns);
    expect(r.summary).toBeUndefined();
    expect(r.summarizedThrough).toBeUndefined();
    expect(r.historyText).toContain("one");
    expect(r.historyText).toContain("two");
  });

  it("folds turns older than the window into the summary", async () => {
    const turns = Array.from({ length: 5 }, (_, i) => turn(`m${i}`, `msg${i}`));
    const summarize = vi.fn(async () => "SUMMARY_TEXT");
    const r = await foldHistory({ turns, priorSummary: "PRIOR" }, summarize, 3);
    expect(summarize).toHaveBeenCalledTimes(1);
    // older = m0,m1 (5 - window 3); newest folded id = m1
    expect(summarize.mock.calls[0][1]).toBe("PRIOR");
    expect(r.summarizedThrough).toBe("m1");
    expect(r.windowTurns.map((t) => t.id)).toEqual(["m2", "m3", "m4"]);
    expect(r.summary).toBe("SUMMARY_TEXT");
    expect(r.historyText).toContain("SUMMARY_TEXT");
    expect(r.historyText).toContain("msg4");
  });

  it("includes the prior summary in the prompt block when nothing new is folded", async () => {
    const r = await foldHistory({ turns: [turn("a", "hi")], priorSummary: "EARLIER" }, vi.fn(), 8);
    expect(r.historyText).toContain("EARLIER");
  });
});

describe("renderTurns", () => {
  it("labels roles and appends focus for side_chat", () => {
    const out = renderTurns([
      { id: "1", role: "user", text: "q", surface: "side_chat", focus: ["NVDA", "AMD"] },
      { id: "2", role: "agent", text: "a", surface: "main" },
    ]);
    expect(out).toContain("USER (focused on NVDA, AMD): q");
    expect(out).toContain("ASSISTANT: a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/shared/memory.test.ts`
Expected: FAIL — cannot find module `./memory`.

- [ ] **Step 3: Write the implementation**

Create `lib/agents/shared/memory.ts`:

```ts
import type { ChatTurn } from "../../schema";
import { generateFreeText } from "../../llm";

export const HISTORY_WINDOW = 8;

export type Summarize = (turnsText: string, priorSummary?: string) => Promise<string>;

// Render turns as a compact transcript. Side-chat turns note their focused nodes.
export function renderTurns(turns: ChatTurn[]): string {
  return turns
    .map((t) => {
      const who = t.role === "user" ? "USER" : "ASSISTANT";
      const focus = t.surface === "side_chat" && t.focus?.length ? ` (focused on ${t.focus.join(", ")})` : "";
      return `${who}${focus}: ${t.text}`;
    })
    .join("\n");
}

function composeHistory(summaryText: string, windowTurns: ChatTurn[]): string {
  const parts: string[] = [];
  if (summaryText) parts.push(`SUMMARY OF EARLIER CONVERSATION:\n${summaryText}`);
  if (windowTurns.length) parts.push(`RECENT MESSAGES:\n${renderTurns(windowTurns)}`);
  return parts.join("\n\n");
}

// Split the sent turns into a verbatim window (last `window`) + older turns folded
// into the rolling summary. `summary`/`summarizedThrough` are only set when new
// turns were folded, so the caller knows whether to update its cache.
export async function foldHistory(
  input: { turns: ChatTurn[]; priorSummary?: string },
  summarize: Summarize,
  window: number = HISTORY_WINDOW,
): Promise<{ historyText: string; windowTurns: ChatTurn[]; summary?: string; summarizedThrough?: string }> {
  const turns = input.turns ?? [];
  const prior = input.priorSummary?.trim() ?? "";

  if (turns.length <= window) {
    return { historyText: composeHistory(prior, turns), windowTurns: turns };
  }

  const older = turns.slice(0, turns.length - window);
  const windowTurns = turns.slice(turns.length - window);
  const summary = await summarize(renderTurns(older), prior || undefined);
  return {
    historyText: composeHistory(summary, windowTurns),
    windowTurns,
    summary,
    summarizedThrough: older[older.length - 1].id,
  };
}

const SUMMARY_SYSTEM =
  "Summarize this conversation between a user and a data-analysis assistant into a compact factual brief " +
  "(<=120 words). Preserve entities, metrics, questions asked, and conclusions reached. No preamble, no bullet headers.";

// Production summarizer: fold new turns into any existing summary.
export const summarizeTurns: Summarize = (turnsText, priorSummary) =>
  generateFreeText({
    provider: "openai",
    system: SUMMARY_SYSTEM,
    prompt: `${priorSummary ? `Existing summary:\n${priorSummary}\n\n` : ""}New messages to fold in:\n${turnsText}`,
    label: "history-summary",
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agents/shared/memory.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/memory.ts lib/agents/shared/memory.test.ts
git commit -m "feat: rolling-summary chat memory (foldHistory)"
```

---

### Task 3: Node retrieval — `retrieveNodes` + `nodeContentBlock`

Structured RAG over board nodes: selection-first, else heuristic top-K; plus a full-content serializer for the prompt.

**Files:**
- Create: `lib/agents/shared/retrieval.ts`
- Test: `lib/agents/shared/retrieval.test.ts`

**Interfaces:**
- Consumes: `CanvasNode`, `CanvasState` (from `lib/schema.ts`), `tokenize`, `jaccard` (from `lib/text.ts`).
- Produces:
  - `RETRIEVE_K = 6`
  - `retrieveNodes(state: CanvasState, selection: { nodeIds: string[] } | undefined, message: string, k?: number): CanvasNode[]`
  - `nodeContentBlock(nodes: CanvasNode[]): string`

- [ ] **Step 1: Write the failing test**

Create `lib/agents/shared/retrieval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { retrieveNodes, nodeContentBlock } from "./retrieval";
import type { CanvasNode, CanvasState } from "../../schema";

const node = (over: Partial<CanvasNode>): CanvasNode => ({
  id: "n", type: "data_card", title: "t", grounding: "tako", confidence: 0.9, ...over,
});

const state: CanvasState = {
  nodes: [
    node({ id: "nvda", title: "Nvidia data-center revenue", summary: "grew fast" }),
    node({ id: "amd", title: "AMD gross margin", summary: "steady" }),
    node({ id: "sec", type: "entity_section", role: "header", title: "United States" }),
  ],
  edges: [],
};

describe("retrieveNodes", () => {
  it("returns exactly the selection, in order, when present", () => {
    const r = retrieveNodes(state, { nodeIds: ["amd", "nvda"] }, "anything");
    expect(r.map((n) => n.id)).toEqual(["amd", "nvda"]);
  });

  it("ranks by keyword overlap when there is no selection", () => {
    const r = retrieveNodes(state, undefined, "how did Nvidia data-center revenue do?");
    expect(r[0].id).toBe("nvda");
  });

  it("skips entity_section / header nodes", () => {
    const r = retrieveNodes(state, undefined, "united states");
    expect(r.some((n) => n.id === "sec")).toBe(false);
  });

  it("caps at k and falls back to most-recent on no match", () => {
    const many: CanvasState = { nodes: Array.from({ length: 10 }, (_, i) => node({ id: `x${i}`, title: `zzz${i}` })), edges: [] };
    const r = retrieveNodes(many, undefined, "unrelated query terms", 3);
    expect(r).toHaveLength(3);
    expect(r.map((n) => n.id)).toEqual(["x7", "x8", "x9"]); // recency fallback = last k
  });
});

describe("nodeContentBlock", () => {
  it("serializes metric, chart, consensus, and sources", () => {
    const out = nodeContentBlock([
      node({ id: "m", title: "Rev", metric: { value: "$26B", label: "Q2 revenue", delta: "+88%" } }),
      node({ id: "c", title: "Trend", chartSpec: { kind: "line", unit: "USD", series: [{ label: "NVDA", points: [{ x: "Q1", y: 1 }, { x: "Q2", y: 2 }] }] } }),
      node({ id: "k", title: "Ranking", consensusRows: [{ rank: 1, entity: "NVDA", score: 0.9 }] }),
      node({ id: "s", title: "Article", sources: [{ url: "https://ex.com/a" }] }),
    ]);
    expect(out).toContain("$26B");
    expect(out).toContain("Q2 revenue");
    expect(out).toContain("chart(line USD) NVDA: Q1:1, Q2:2");
    expect(out).toContain("1. NVDA (0.9)");
    expect(out).toContain("https://ex.com/a");
    expect(out).toContain("[#m");
  });

  it("returns a sentinel when empty", () => {
    expect(nodeContentBlock([])).toBe("(no matching board nodes)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/shared/retrieval.test.ts`
Expected: FAIL — cannot find module `./retrieval`.

- [ ] **Step 3: Write the implementation**

Create `lib/agents/shared/retrieval.ts`:

```ts
import type { CanvasNode, CanvasState } from "../../schema";
import { tokenize, jaccard } from "../../text";

export const RETRIEVE_K = 6;

// Empty group labels / section headers carry no content to reason from.
function isContentNode(n: CanvasNode): boolean {
  return n.type !== "entity_section" && n.role !== "header";
}

function haystack(n: CanvasNode): string {
  return [n.title, n.summary, n.section].filter(Boolean).join(" ");
}

// Selection-first: the selected nodes ARE the retrieved set (full content, in
// selection order). Otherwise rank content nodes by keyword overlap with the
// message (small boost for Tako grounding + recency), top-K; if nothing matches,
// fall back to the K most-recent nodes so the model still has board context.
export function retrieveNodes(
  state: CanvasState,
  selection: { nodeIds: string[] } | undefined,
  message: string,
  k: number = RETRIEVE_K,
): CanvasNode[] {
  const nodes = (state.nodes ?? []).filter(isContentNode);
  const ids = selection?.nodeIds ?? [];
  if (ids.length) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return ids.map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n);
  }
  if (nodes.length === 0) return [];

  const q = tokenize(message);
  const scored = nodes.map((n, i) => ({
    n,
    i,
    base: jaccard(q, tokenize(haystack(n))) + (n.grounding === "tako" ? 0.05 : 0),
  }));
  if (!scored.some((s) => s.base > 0)) return nodes.slice(-k); // no keyword match → recency
  return [...scored]
    .sort((a, b) => b.base - a.base || b.i - a.i)
    .slice(0, k)
    .map((s) => s.n);
}

function fmtNode(n: CanvasNode): string {
  const lines = [`[#${n.id} · ${n.type}/${n.grounding}] ${n.title}`];
  if (n.summary) lines.push(n.summary);
  if (n.metric) lines.push(`metric: ${n.metric.value} ${n.metric.label}${n.metric.delta ? ` (${n.metric.delta})` : ""}`);
  if (n.chartSpec) {
    for (const s of n.chartSpec.series) {
      const pts = s.points.slice(0, 8).map((p) => `${p.x}:${p.y}`).join(", ");
      lines.push(`chart(${n.chartSpec.kind}${n.chartSpec.unit ? ` ${n.chartSpec.unit}` : ""}) ${s.label}: ${pts}`);
    }
  }
  if (n.consensusRows?.length) {
    lines.push("consensus: " + n.consensusRows.map((r) => `${r.rank}. ${r.entity}${r.score != null ? ` (${r.score})` : ""}`).join("; "));
  }
  if (n.sources?.length) lines.push("sources: " + n.sources.map((s) => s.url).join(", "));
  else if (n.tako?.webpageUrl) lines.push(`source: ${n.tako.webpageUrl}`);
  return lines.join("\n");
}

// Full-content serialization of the retrieved nodes for the prompt.
export function nodeContentBlock(nodes: CanvasNode[]): string {
  if (!nodes.length) return "(no matching board nodes)";
  return nodes.map(fmtNode).join("\n\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agents/shared/retrieval.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/retrieval.ts lib/agents/shared/retrieval.test.ts
git commit -m "feat: structured node retrieval (selection-first + heuristic top-K)"
```

---

### Task 4: `groundedIn` trace type + context block wiring

Adds the provenance field to the trace types and rebuilds `ctxBlock` to include conversation history + retrieved node **content** (replacing the metadata-only list).

**Files:**
- Modify: `lib/agents/shared/types.ts` (add `groundedIn` to `TurnTrace`)
- Modify: `lib/agents/shared/ctx.ts` (history + retrieved content)
- Test: `lib/agents/shared/ctx.test.ts` (create)

**Interfaces:**
- Consumes: `retrieveNodes`, `nodeContentBlock` (Task 3); `AgentRequest` (Task 1).
- Produces:
  - `TurnTrace.groundedIn?: { nodes: { id: string; title: string }[]; takoAnswerUsed: boolean; cards: { id: string; title: string; url: string }[] }`
  - `ctxBlock(req: AgentRequest, historyText?: string): string` (new second parameter)

- [ ] **Step 1: Write the failing test**

Create `lib/agents/shared/ctx.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ctxBlock } from "./ctx";
import type { AgentRequest } from "../../schema";

const base: AgentRequest = {
  canvasId: "c", message: "how did Nvidia do?", surface: "main",
  canvasState: {
    nodes: [{ id: "nvda", type: "data_card", title: "Nvidia revenue", summary: "grew 88%", grounding: "tako", confidence: 0.9 }],
    edges: [],
  },
  providerId: "tako", history: [],
};

describe("ctxBlock", () => {
  it("includes retrieved node CONTENT, not just metadata", () => {
    const out = ctxBlock(base);
    expect(out).toContain("grew 88%");        // summary content
    expect(out).toContain("[#nvda");          // content-block marker
    expect(out).toContain("BOARD CONTEXT");
  });

  it("includes the conversation block when historyText is provided", () => {
    const out = ctxBlock(base, "SUMMARY OF EARLIER CONVERSATION:\nuser asked about chips");
    expect(out).toContain("CONVERSATION SO FAR");
    expect(out).toContain("user asked about chips");
  });

  it("omits the conversation block when no history", () => {
    expect(ctxBlock(base)).not.toContain("CONVERSATION SO FAR");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/shared/ctx.test.ts`
Expected: FAIL — `ctxBlock` output lacks `BOARD CONTEXT` / `grew 88%` (current impl emits metadata only).

- [ ] **Step 3: Add `groundedIn` to the trace type**

In `lib/agents/shared/types.ts`, add the field to `TurnTrace` (after `reasoning`, around line 62):

```ts
  reasoning?: { nodeId: string; question: string; rationale: string }[];
  // Which board nodes / Tako grounding actually fed this turn's answer.
  groundedIn?: {
    nodes: { id: string; title: string }[];
    takoAnswerUsed: boolean;
    cards: { id: string; title: string; url: string }[];
  };
```

- [ ] **Step 4: Rewrite `ctxBlock`**

Replace the entire body of `lib/agents/shared/ctx.ts`:

```ts
import type { AgentRequest } from "../../schema";
import { retrieveNodes, nodeContentBlock } from "./retrieval";

// The per-turn context handed to the router and the follow-up answerer.
// - CONVERSATION SO FAR: folded history (summary + recent turns), when present.
// - BOARD CONTEXT: FULL content of the retrieved (selection-first) nodes — the
//   grounded data the assistant reasons from (nodes-as-RAG).
// - ALL NODES / EDGES: the light structural map for routing + edge ops.
export function ctxBlock(req: AgentRequest, historyText?: string): string {
  const retrieved = retrieveNodes(req.canvasState, req.selection, req.message);
  const allNodes = req.canvasState.nodes.map((n) => ({ id: n.id, type: n.type, title: n.title }));
  const parts = [
    `MESSAGE: ${req.message}`,
    `SURFACE: ${req.surface}`,
    `SELECTION: ${JSON.stringify(req.selection?.nodeIds || [])}`,
  ];
  if (historyText) parts.push(`\nCONVERSATION SO FAR:\n${historyText}`);
  parts.push(`\nBOARD CONTEXT (grounded data to reason from):\n${nodeContentBlock(retrieved)}`);
  parts.push(`\nALL NODES: ${JSON.stringify(allNodes)}`);
  parts.push(`CURRENT_EDGES: ${JSON.stringify(req.canvasState.edges)}`);
  return parts.join("\n");
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/agents/shared/ctx.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite to catch contract fallout**

Run: `npm test`
Expected: PASS. (If `followup.test.ts` fails to compile because `runTakoFollowup` gains params in Task 6, that's expected only AFTER Task 6 — at this point the signature is unchanged and existing tests still pass. Existing callers of `ctxBlock` pass one arg, which still type-checks.)

- [ ] **Step 7: Commit**

```bash
git add lib/agents/shared/types.ts lib/agents/shared/ctx.ts lib/agents/shared/ctx.test.ts
git commit -m "feat: groundedIn trace field + content-rich ctxBlock with history"
```

---

### Task 5: `groundedNodes` trace helper (UI-facing, pure)

A pure selector the trace UI (Task 9) uses to render node chips, unit-tested here in the node environment so the `.tsx` stays thin.

**Files:**
- Modify: `lib/trace.ts` (add helper + re-export the `groundedIn` shape)
- Test: `lib/trace.test.ts` (append)

**Interfaces:**
- Consumes: `TurnTrace` (already imported in `trace.ts`).
- Produces: `groundedInOf(trace: TurnTrace | undefined): { nodes: { id: string; title: string }[]; takoAnswerUsed: boolean; cards: TraceCard[] }` — always returns a well-formed object (empty arrays when absent).

- [ ] **Step 1: Write the failing test**

Append to `lib/trace.test.ts`:

```ts
import { groundedInOf } from "./trace";

describe("groundedInOf", () => {
  it("returns empty structure when the trace has no groundedIn", () => {
    expect(groundedInOf(undefined)).toEqual({ nodes: [], takoAnswerUsed: false, cards: [] });
    expect(groundedInOf({} as any)).toEqual({ nodes: [], takoAnswerUsed: false, cards: [] });
  });

  it("passes through nodes/cards and the tako flag", () => {
    const g = groundedInOf({
      groundedIn: {
        nodes: [{ id: "nvda", title: "Nvidia revenue" }],
        takoAnswerUsed: true,
        cards: [{ id: "c1", title: "Card", url: "https://x" }],
      },
    } as any);
    expect(g.nodes[0].id).toBe("nvda");
    expect(g.takoAnswerUsed).toBe(true);
    expect(g.cards[0].id).toBe("c1");
  });
});
```

> Note: `lib/trace.test.ts` already has `import { describe, it, expect }` at the top — reuse them; only add the `groundedInOf` import and the new `describe` block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/trace.test.ts`
Expected: FAIL — `groundedInOf` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `lib/trace.ts` (after `groundingOf`, near line 49):

```ts
// Normalized provenance for the "Grounded in" trace block. Always well-formed so
// the UI can render unconditionally.
export function groundedInOf(trace: TurnTrace | undefined): {
  nodes: { id: string; title: string }[];
  takoAnswerUsed: boolean;
  cards: TraceCard[];
} {
  const g = trace?.groundedIn;
  return {
    nodes: g?.nodes ?? [],
    takoAnswerUsed: g?.takoAnswerUsed ?? false,
    cards: g?.cards ?? [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/trace.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/trace.ts lib/trace.test.ts
git commit -m "feat: groundedInOf trace selector for the grounded-in UI"
```

---

### Task 6: Board-first follow-up + provenance

Rewire the follow-up pipeline to answer from retrieved node content, call Tako only when needed, and record `groundedIn`. Adds a dedicated conversational answer prompt.

**Files:**
- Modify: `lib/agents/tako/prompts.ts` (add `FOLLOWUP_ANSWER_SYSTEM`)
- Modify: `lib/agents/tako/followup.ts` (new signature + board-first logic + `groundedIn`)
- Test: `lib/agents/tako/followup.test.ts` (extend)

**Interfaces:**
- Consumes: `retrieveNodes` (Task 3), `ctxBlock(req, historyText)` (Task 4), `RouteAction` (from `types.ts`), `FOLLOWUP_ANSWER_SYSTEM`.
- Produces: `runTakoFollowup(req: AgentRequest, action: RouteAction, historyText: string, emit?: EmitFn): Promise<PipelineResult>` — **new signature** (was `runTakoFollowup(req, emit?)`). The returned `trace.groundedIn` is populated.

- [ ] **Step 1: Write the failing tests**

Replace the body of `lib/agents/tako/followup.test.ts` with (keeps the existing mocks, updates the call signature, adds board-first cases):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";
import type { AgentRequest } from "../../schema";

vi.mock("../../tako", () => ({
  takoAnswer: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "amd", title: "AMD rev", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "Tako" }];
    opts.onCall?.({ query: q, endpoint: "/v1/answer", effort: opts.effort ?? "fast", web: false, ms: 2, cards });
    return { answer: "AMD grew revenue.", cards };
  }),
}));

vi.mock("../../llm", () => ({
  streamAnswer: vi.fn(async (opts: any) => {
    opts.onToken("answer");
    return "answer";
  }),
}));

import { runTakoFollowup } from "./followup";
import { takoAnswer } from "../../tako";

const boardNode = { id: "nvda", type: "data_card" as const, title: "Nvidia revenue", summary: "grew 88%", grounding: "tako" as const, confidence: 0.9 };

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    canvasId: "c", message: "explain this", surface: "side_chat",
    canvasState: { nodes: [boardNode], edges: [] },
    selection: { nodeIds: ["nvda"], nodes: [boardNode] },
    providerId: "tako", takoAnswerEnabled: true, history: [],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("runTakoFollowup — board-first", () => {
  it("EXPLAIN with board content answers WITHOUT calling Tako", async () => {
    const result = await runTakoFollowup(req(), "EXPLAIN", "", () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
    expect(result.trace.groundedIn?.nodes.map((n) => n.id)).toEqual(["nvda"]);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(false);
    expect(result.sideReply).toBe("answer");
  });

  it("AUGMENT calls Tako for new data even with board content", async () => {
    const result = await runTakoFollowup(req({ surface: "main" }), "AUGMENT", "", () => {});
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(true);
  });

  it("EXPLAIN on an empty board falls back to Tako", async () => {
    const result = await runTakoFollowup(
      req({ canvasState: { nodes: [], edges: [] }, selection: undefined }),
      "EXPLAIN", "", () => {},
    );
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(true);
  });

  it("never calls Tako when takoAnswerEnabled is false", async () => {
    await runTakoFollowup(req({ takoAnswerEnabled: false }), "AUGMENT", "", () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
  });

  it("emits tako_call events and records calls when Tako is used", async () => {
    const events: AgentEvent[] = [];
    const result = await runTakoFollowup(req({ surface: "main" }), "AUGMENT", "", (e) => events.push(e));
    expect((events.filter((e) => e.type === "tako_call") as any[]).length).toBe(1);
    expect(result.trace.calls?.[0].endpoint).toBe("/v1/answer");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/followup.test.ts`
Expected: FAIL — `runTakoFollowup` still has the old 2-arg signature; board-first / `groundedIn` behavior absent.

- [ ] **Step 3: Add the conversational answer prompt**

Add to `lib/agents/tako/prompts.ts` (after `FOLLOWUP_SYSTEM`):

```ts
// Board-first conversational follow-up answer. Reasons from BOARD CONTEXT first;
// uses GROUNDED_ANSWER only when a Tako call was made this turn.
export const FOLLOWUP_ANSWER_SYSTEM = `You are the Canvas Assistant answering a follow-up in a chat panel.
Answer the user's MESSAGE using the BOARD CONTEXT (the nodes they can see) as your primary source, taking the
CONVERSATION SO FAR into account for what "this"/"that"/"them" refer to.
- Prefer the board's own data. If a GROUNDED_ANSWER is provided, it is fresh Tako data fetched this turn — weave it in.
- Be concise and conversational: 1-3 short paragraphs, no headings. Light markdown only (**bold** a key figure, "- " bullets for 3+ items).
- Use ONLY facts present in BOARD CONTEXT / GROUNDED_ANSWER. Never invent a number or source. Never mention missing data.`;
```

- [ ] **Step 4: Rewrite `followup.ts`**

Replace `lib/agents/tako/followup.ts` in full:

```ts
import type { AgentRequest, CanvasNode, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings, TakoCallRecord, RouteAction } from "../shared/types";
import { streamAnswer } from "../../llm";
import { takoAnswer } from "../../tako";
import { FindingLedger } from "./findings";
import { FOLLOWUP_ANSWER_SYSTEM } from "./prompts";
import { ctxBlock } from "../shared/ctx";
import { retrieveNodes } from "../shared/retrieval";
import { log } from "../../log";

const OPENAI = "openai" as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Board-first follow-up: answer from the retrieved (selection-first) board nodes.
// Only call Tako when the user asked for new/changed data (AUGMENT/REPLACE) or the
// board has nothing to answer from — and never when takoAnswer is disabled. On a
// side-chat / EXPLAIN turn the answer goes to sideReply and no board nodes are minted.
export async function runTakoFollowup(
  req: AgentRequest,
  action: RouteAction,
  historyText: string,
  emit?: EmitFn,
): Promise<PipelineResult> {
  const timings: Partial<Timings> = {};
  const notes: string[] = [];
  const calls: TakoCallRecord[] = [];
  const ledger = new FindingLedger();
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const toBoard = req.surface !== "side_chat";
  const answerEnabled = req.takoAnswerEnabled !== false;

  const retrieved: CanvasNode[] = retrieveNodes(req.canvasState, req.selection, req.message);
  const wantsNewData = action === "AUGMENT" || action === "REPLACE";
  const boardCanAnswer = retrieved.length > 0;
  const needsTako = answerEnabled && (wantsNewData || !boardCanAnswer);

  let answer = "";
  let t = Date.now();
  if (needsTako) {
    emit?.({ type: "trace", stage: "asking Tako (web enabled)" });
    try {
      const res = await takoAnswer(req.message, {
        effort: "fast",
        onCall: (m) => {
          const call: TakoCallRecord = {
            callId: `followup:${calls.length}`, nodeId: "followup",
            query: m.query, endpoint: m.endpoint, effort: m.effort, web: m.web, ms: m.ms,
            cards: m.cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
            error: m.error,
          };
          calls.push(call);
          emit?.({ type: "tako_call", call });
        },
      });
      answer = res.answer;
      for (const c of res.cards) {
        const f = ledger.add(c);
        if (f && toBoard) {
          nodeOps.push({ op: "add_node", node: ledger.toNode(f) });
          allowedNodeIds.add(f.nodeId);
          emit?.({ type: "ops", ops: [{ op: "add_node", node: ledger.toNode(f) }] });
        }
      }
    } catch (e: unknown) {
      notes.push(`Tako Answer unavailable (${errorMessage(e)})`);
    }
    emit?.({ type: "trace", stage: `Tako answered with ${ledger.size} findings` });
  } else {
    notes.push(`Answering from ${retrieved.length} board node(s)`);
    emit?.({ type: "trace", stage: `answering from ${retrieved.length} board node(s)` });
  }
  timings.search = Date.now() - t;

  const takoAnswerUsed = calls.length > 0;

  // Compose the answer. Board content + history come from ctxBlock; a fresh Tako
  // answer (when fetched) is appended as GROUNDED_ANSWER.
  emit?.({ type: "trace", stage: "writing answer" });
  t = Date.now();
  const prompt = `${ctxBlock(req, historyText)}\n\nGROUNDED_ANSWER: ${answer || "(none — answer from board context)"}`;

  emit?.({
    type: "synthesis", phase: "start", nodeId: "followup", kind: "root",
    inputs: { fromNodeIds: retrieved.map((n) => n.id), findingTitles: ledger.list().map((f) => f.title) },
  });

  let prose: string;
  if (retrieved.length > 0 || ledger.size > 0 || answer) {
    prose = await streamAnswer({
      provider: OPENAI, system: FOLLOWUP_ANSWER_SYSTEM, prompt, label: "followup",
      onToken: (chunk) => { if (toBoard) emit?.({ type: "token", text: chunk }); },
    });
  } else {
    prose = "I couldn't find anything on the board or in Tako to answer that.";
    if (toBoard) emit?.({ type: "token", text: prose });
  }
  emit?.({ type: "synthesis", phase: "end", nodeId: "followup", kind: "root" });
  timings.stream = Date.now() - t;

  log("tako", "followup board-first", { retrieved: retrieved.length, findings: ledger.size, takoAnswerUsed, ...timings });

  return {
    nodeOps,
    narration: toBoard ? prose : "",
    sideReply: toBoard ? null : prose,
    validCardIds: new Set(ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      queries: [req.message],
      answerUsed: takoAnswerUsed,
      cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      calls,
      notes,
      groundedIn: {
        nodes: retrieved.map((n) => ({ id: n.id, title: n.title })),
        takoAnswerUsed,
        cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      },
      timings: { ...timings, total: 0 } as Timings,
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/agents/tako/followup.test.ts`
Expected: PASS (all five cases).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/prompts.ts lib/agents/tako/followup.ts lib/agents/tako/followup.test.ts
git commit -m "feat: board-first follow-up answers with groundedIn provenance"
```

---

### Task 7: Agent orchestration — history-aware routing + threading

`runTako` now folds history once, feeds it to the router and follow-up, and forwards the memory update. Router prompt becomes history-aware.

**Files:**
- Modify: `lib/agents/shared/router.ts` (history-aware prompt line)
- Modify: `lib/agents/tako/agent.ts` (fold history, thread `action`/`historyText`, forward `memory`)
- Test: `lib/agents/tako/agent.test.ts` (create)

**Interfaces:**
- Consumes: `foldHistory`, `summarizeTurns` (Task 2); `runTakoFollowup(req, action, historyText, emit)` (Task 6); `ctxBlock(req, historyText)` (Task 4).
- Produces: `runTako` returns `AgentResponse` with `memory: { summary?, summarizedThrough? }` populated from `foldHistory`.

- [ ] **Step 1: Write the failing test**

Create `lib/agents/tako/agent.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRequest } from "../../schema";

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async () => ({ action: "EXPLAIN", reason: "r" })),
}));
vi.mock("../shared/memory", () => ({
  foldHistory: vi.fn(async () => ({ historyText: "HIST", windowTurns: [], summary: "NEWSUM", summarizedThrough: "m3" })),
  summarizeTurns: vi.fn(),
}));
const runTakoFollowup = vi.fn(async () => ({
  nodeOps: [], narration: "", sideReply: "ok", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { groundedIn: { nodes: [{ id: "nvda", title: "N" }], takoAnswerUsed: false, cards: [] } },
}));
vi.mock("./followup", () => ({ runTakoFollowup: (...a: any[]) => runTakoFollowup(...a) }));
vi.mock("./pipeline", () => ({ runTakoInitial: vi.fn() }));

import { runTako } from "./agent";
import { foldHistory } from "../shared/memory";

const req: AgentRequest = {
  canvasId: "c", message: "tell me more", surface: "side_chat",
  canvasState: { nodes: [{ id: "nvda", type: "data_card", title: "N", grounding: "tako", confidence: 0.9 }], edges: [] },
  selection: { nodeIds: ["nvda"], nodes: [] },
  providerId: "tako", takoAnswerEnabled: true,
  history: [{ id: "m1", role: "user", text: "how did Nvidia do", surface: "main" }],
  historySummary: "PRIOR",
};

beforeEach(() => vi.clearAllMocks());

describe("runTako", () => {
  it("folds history and threads action + historyText into the follow-up", async () => {
    const res = await runTako(req);
    expect(foldHistory).toHaveBeenCalledTimes(1);
    const [, actionArg, historyArg] = runTakoFollowup.mock.calls[0];
    expect(actionArg).toBe("EXPLAIN");
    expect(historyArg).toBe("HIST");
    expect(res.memory).toEqual({ summary: "NEWSUM", summarizedThrough: "m3" });
    expect(res.trace?.groundedIn?.nodes[0].id).toBe("nvda");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: FAIL — `runTako` doesn't call `foldHistory`, doesn't pass `action`/`historyText`, and `res.memory` is undefined.

- [ ] **Step 3: Make the router prompt history-aware**

In `lib/agents/shared/router.ts`, replace the final instruction line of the `ROUTER` template string:

```ts
If surface is "side_chat", put the answer in sideReply and keep narration short.
Use CONVERSATION SO FAR to resolve references ("it", "that", "them", "tell me more") to the entity/nodes
already discussed — a reference to prior context is usually EXPLAIN or AUGMENT, not NEW_BOARD.`;
```

(That replaces the existing closing line `If surface is "side_chat", ...short.`; keep everything above it unchanged.)

- [ ] **Step 4: Rewrite `agent.ts`**

Replace `lib/agents/tako/agent.ts` in full:

```ts
import type { AgentRequest, AgentResponse } from "../../schema";
import type { EmitFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { ROUTER, zRoute } from "../shared/router";
import { foldHistory, summarizeTurns } from "../shared/memory";
import { runTakoInitial } from "./pipeline";
import { runTakoFollowup } from "./followup";

const OPENAI = "openai" as const;

export async function runTako(req: AgentRequest, emit?: EmitFn): Promise<AgentResponse> {
  // Fold conversation history first — feeds routing AND the follow-up answer.
  const folded = await foldHistory({ turns: req.history ?? [], priorSummary: req.historySummary }, summarizeTurns);
  const historyText = folded.historyText;

  // Route (fast, cheap), now history-aware so "tell me more" resolves its referent.
  emit?.({ type: "trace", stage: "routing" });
  const hasBoard = req.canvasState.nodes.length > 0;
  const route = await generateStructured({
    provider: OPENAI,
    system: `${ROUTER}\nReturn { action, reason }.`,
    prompt: ctxBlock(req, historyText),
    schema: zRoute,
    label: "route",
  });
  // NEW_BOARD when empty board regardless of model guess.
  const action = hasBoard ? route.action : "NEW_BOARD";

  const isFollowup = action === "EXPLAIN" || action === "AUGMENT" || action === "REPLACE";
  const result = isFollowup
    ? await runTakoFollowup(req, action, historyText, emit)
    : await runTakoInitial(req, emit);

  // Node ops were already streamed; sanitize + provenance-filter them, then let
  // relate.ts append the structural edges.
  const sanitized = sanitizeOps(result.nodeOps, { allowTako: true, validCardIds: result.validCardIds });
  const provenanced = sanitized.filter(
    (o) => (o.op !== "add_node" && o.op !== "upsert_node") || result.allowedNodeIds.has(o.node.id),
  );
  const ops = finalizeOps(req.canvasState, provenanced);

  return {
    canvasOps: ops,
    narration: result.narration,
    sideReply: result.sideReply,
    memory: { summary: folded.summary, summarizedThrough: folded.summarizedThrough },
    trace: { action, provider: "tako", queries: [], cards: [], opsApplied: ops.length, notes: [], ms: 0, ...result.trace } as any,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (all files).

- [ ] **Step 7: Commit**

```bash
git add lib/agents/shared/router.ts lib/agents/tako/agent.ts lib/agents/tako/agent.test.ts
git commit -m "feat: history-aware routing + memory forwarding in runTako"
```

---

### Task 8: API route — accept history, forward memory

Thread the new request fields in and relay the memory update on the `result` event. Thin pass-through (no unit test — `app/` is outside the test include; gated by build).

**Files:**
- Modify: `app/api/agent/route.ts`

**Interfaces:**
- Consumes: `AgentRequest.history`/`historySummary` (Task 1); `AgentResponse.memory` (Task 1/7).
- Produces: `result` NDJSON event now carries `memory`.

- [ ] **Step 1: Add the fields to request construction**

In `app/api/agent/route.ts`, extend the `request` object (after `takoAnswerEnabled`, around line 22):

```ts
  const request: AgentRequest = {
    canvasId: body.canvasId || "default",
    message: body.message,
    surface: body.surface || "main",
    canvasState: body.canvasState || { nodes: [], edges: [] },
    selection: body.selection,
    providerId: body.providerId || "tako",
    takoAnswerEnabled: body.takoAnswerEnabled ?? true,
    history: body.history || [],
    historySummary: body.historySummary,
  };
```

- [ ] **Step 2: Forward `memory` on the result event**

In the same file, update the `send({ type: "result", ... })` call (around line 55) to include memory:

```ts
        send({ type: "result", canvasOps: result.canvasOps, narration: result.narration, sideReply: result.sideReply, memory: result.memory, trace });
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors. (If `tsc` isn't wired, run `npm run build` and confirm it compiles.)

- [ ] **Step 4: Commit**

```bash
git add app/api/agent/route.ts
git commit -m "feat: relay history in + memory out through /api/agent"
```

---

### Task 9: "Grounded in" trace UI + node chips

Render the provenance block in the trace, with clickable node chips that call `onSelectNode`. UI only (no node test); uses `groundedInOf` from Task 5.

**Files:**
- Modify: `components/TraceView.tsx` (render block + `onSelectNode` prop)
- Modify: `app/globals.css` (chip styles)

**Interfaces:**
- Consumes: `groundedInOf` (Task 5).
- Produces: `TraceView` gains prop `onSelectNode?: (id: string) => void`.

- [ ] **Step 1: Add the prop + grounded-in block**

In `components/TraceView.tsx`:

1. Update the import to add `groundedInOf`:

```ts
import { traceToDisplay, stepsToDisplay, countCalls, groundedInOf, type TurnTrace, type LiveStep } from "@/lib/trace";
```

2. Extend the component signature:

```ts
export default function TraceView({
  trace, steps, streaming, onSelectNode,
}: { trace?: TurnTrace; steps?: LiveStep[]; streaming: boolean; onSelectNode?: (id: string) => void }) {
```

3. Compute the grounded-in data just before the `return` (after the `findings` line, ~line 25):

```ts
  const grounded = groundedInOf(trace);
  const hasGrounded = grounded.nodes.length > 0 || grounded.cards.length > 0 || grounded.takoAnswerUsed;
```

4. Inside the open panel, render the block ABOVE the `trace-footer` (i.e. insert immediately before `{trace && (` at ~line 52):

```tsx
          {hasGrounded && (
            <div className="grounded-in">
              <div className="grounded-in-label">Grounded in</div>
              <div className="grounded-in-chips">
                {grounded.nodes.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="ground-chip node"
                    onClick={() => onSelectNode?.(n.id)}
                    title="Focus this node on the canvas"
                  >
                    {n.title}
                  </button>
                ))}
                {grounded.takoAnswerUsed && <span className="ground-chip tako-src">Tako answer</span>}
                {grounded.cards.map((c) => (
                  <a
                    key={c.id}
                    className="ground-chip card"
                    href={c.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.title}
                  </a>
                ))}
              </div>
            </div>
          )}
```

- [ ] **Step 2: Add chip styles**

Append to `app/globals.css`:

```css
.grounded-in { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--hairline, rgba(0,0,0,0.08)); }
.grounded-in-label { font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.6; margin-bottom: 6px; }
.grounded-in-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ground-chip { font-size: 12px; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--hairline, rgba(0,0,0,0.12)); background: var(--chip-bg, rgba(0,0,0,0.03)); color: inherit; cursor: default; text-decoration: none; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ground-chip.node { cursor: pointer; }
.ground-chip.node:hover { background: var(--accent-soft, rgba(16,185,129,0.14)); border-color: var(--accent, rgba(16,185,129,0.5)); }
.ground-chip.tako-src { background: rgba(16,185,129,0.12); border-color: rgba(16,185,129,0.35); }
```

> If the codebase already defines `--hairline` / `--accent` tokens, the fallbacks are harmless. Match neighboring token names if they differ (grep `globals.css` for `--accent`).

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: Compiles (TraceView still accepts the extra optional prop; callers pass it in Task 10).

- [ ] **Step 4: Commit**

```bash
git add components/TraceView.tsx app/globals.css
git commit -m "feat: grounded-in trace block with clickable node chips"
```

---

### Task 10: Client wiring — send history, cache memory, focus from chips

Final glue in `page.tsx` and `ChatPanel.tsx`: build+send history, cache the returned summary, and route node-chip clicks into canvas selection. UI/glue — gated by build + a manual smoke check.

**Files:**
- Modify: `components/ChatPanel.tsx` (thread `onSelectNode` to `TraceView`)
- Modify: `app/page.tsx` (send `history`/`historySummary`; handle `result.memory`; pass `onSelectNode`)

**Interfaces:**
- Consumes: `buildHistory` (Task 1); `TraceView.onSelectNode` (Task 9).
- Produces: chip click → `setSelection([id])`; `result.memory` → session `summary`/`summaryUpToId`.

- [ ] **Step 1: Thread `onSelectNode` through `ChatPanel`**

In `components/ChatPanel.tsx`:

1. Add to the props type + destructure (after `error`):

```ts
  error: string | null;
  onSelectNode: (id: string) => void;
```
```ts
  onSend, loading, loadingStage, error, onSelectNode,
```

2. Pass it to the two `TraceView` usages. The streaming one and the finalized one are the same JSX at line 99 — update it:

```tsx
                {hasTrace ? <TraceView trace={m.trace} steps={m.steps} streaming={streaming} onSelectNode={onSelectNode} /> : null}
```

- [ ] **Step 2: Import `buildHistory` in `page.tsx`**

In `app/page.tsx`, add `buildHistory` to the existing `@/lib/sessions` import:

```ts
import {
  type Session, type Provider, type Surface, type ChatMsg, type CanvasView,
  newSession, loadSessions, saveSessions, hasStarted, uid, buildHistory,
} from "@/lib/sessions";
```

- [ ] **Step 3: Send history in the request body**

In the `send` callback (around line 94), add `history`/`historySummary` to the JSON body:

```ts
        body: JSON.stringify({
          canvasId: snap.id, message: text, surface,
          canvasState: snap.state,
          selection: { nodeIds: selection, nodes: selection.map((id) => nodeById[id]).filter(Boolean) },
          providerId: snap.provider, takoAnswerEnabled: snap.takoAnswer,
          history: buildHistory(snap), historySummary: snap.summary,
        }),
```

> `snap` is the session captured at send time (`const snap = active;`). The just-added user message isn't in `snap` yet — that's correct: the current message travels as `message`, and history is the prior turns.

- [ ] **Step 4: Cache the returned memory on the `result` event**

In the `else if (evt.type === "result")` branch (around line 168), update the session-patch to also fold in memory. Replace the `return { ...s, state: nextState, messages };` line with:

```ts
              const memory = evt.memory as { summary?: string; summarizedThrough?: string } | undefined;
              return {
                ...s,
                state: nextState,
                messages,
                summary: memory?.summary ?? s.summary,
                summaryUpToId: memory?.summarizedThrough ?? s.summaryUpToId,
              };
```

- [ ] **Step 5: Wire chip clicks into canvas selection**

In the `<ChatPanel .../>` JSX (around line 443), add the `onSelectNode` prop:

```tsx
      <ChatPanel
        away={!started}
        collapsed={panelCollapsed}
        onToggleCollapse={() => setPanelCollapsed((v) => !v)}
        messages={active.messages}
        selectionTitles={selectionTitles}
        onClearSelection={() => setSelection([])}
        onSend={sendFromPanel}
        loading={loading}
        loadingStage={loadingStage}
        error={error}
        onSelectNode={(id) => setSelection([id])}
      />
```

- [ ] **Step 6: Verify build + full test suite**

Run: `npm run build && npm test`
Expected: Build compiles; all tests pass.

- [ ] **Step 7: Manual smoke check**

Run: `npm run dev`, then in the browser:
1. Ask a question that builds a board (e.g. "Nvidia vs AMD data-center revenue").
2. Ask a follow-up "tell me more about the first one" — confirm the answer references prior context (history working) and the trace shows a **Grounded in** block.
3. Select a node on the canvas, ask "explain this" — confirm the answer is scoped to it and the trace's grounded-in node chip matches; **no Tako call** appears in the trace (board-first).
4. Click a node chip in the trace — confirm it selects/focuses that node on the canvas.

- [ ] **Step 8: Commit**

```bash
git add app/page.tsx components/ChatPanel.tsx
git commit -m "feat: send chat history, cache rolling summary, focus canvas from trace chips"
```

---

## Self-Review

**1. Spec coverage:**
- §1 windowed history + rolling summary → Tasks 1 (contract/`buildHistory`), 2 (`foldHistory`/`summarizeTurns`), 7 (fold in `runTako`), 10 (client send/cache). ✓
- §2 nodes as RAG (selection-first + top-K, `nodeContentBlock`) → Task 3; consumed in Task 4 (`ctxBlock`) and Task 6 (follow-up). ✓
- §3 board-first pipeline → Task 6; router history-awareness → Task 7. ✓
- §4 `groundedIn` provenance → Task 4 (type), 6 (populate), 5 (`groundedInOf`), 9 (UI), 10 (chip→selection). ✓
- §6 persistence: follow-up traces live-only (unchanged — no code touches `serializeSession`'s side_chat branch); session `summary` persisted (already covered — `serializeSession` spreads `...s`, so `summary`/`summaryUpToId` persist automatically). ✓
- §5 testing → each lib task has a unit test; UI tasks gated by build + manual smoke. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**3. Type consistency:** `ChatTurn` (schema.ts) used by `buildHistory`, `foldHistory`, `renderTurns`. `runTakoFollowup(req, action, historyText, emit?)` signature matches its call in `agent.ts` and all tests. `foldHistory` return shape (`historyText`/`windowTurns`/`summary`/`summarizedThrough`) is consistent across memory.ts, agent.ts, and both tests. `groundedIn` shape identical in `types.ts`, `followup.ts`, `groundedInOf`, and the agent test. `AgentResponse.memory` shape matches route.ts relay and page.tsx caching. ✓

**Note on persistence auto-coverage:** `serializeSession` and `shedTraces` in `sessions.ts` spread `...s`/`...m`, so the new `Session.summary`/`summaryUpToId` fields persist without changes. No task needed there — confirmed by inspection.

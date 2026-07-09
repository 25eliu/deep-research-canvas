# Agentic Chat Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the tako provider's follow-up chat into an agentic system: a 4-action router (REPLACE / AUGMENT / GENERATE / EXPLAIN), an evidence-gathering tool loop (tako answer + node contents) for EXPLAIN, a research lane that mints subquery answer nodes via `researchLeaf` for AUGMENT/GENERATE, and clickable grounded-in citations (nodes + fetched data) in the trace.

**Architecture:** Extended router + bounded gather loop (spec: `docs/superpowers/specs/2026-07-09-agentic-chat-grounding-design.md`). The gather loop copies the proven two-phase pattern from `lib/agents/tako/compose.ts` (tool loop → streamed emit). The research lane reuses `researchLeaf`/`newResearchCtx` from `lib/agents/tako/flow.ts` unchanged.

**Tech Stack:** Next.js 14 / React 18, TypeScript, Vercel AI SDK `ai@4` (`generateText` tool loop via the existing `generateWithTools` in `lib/llm.ts`), Zod schemas, vitest (+ @testing-library/react for component tests, jsdom via `environmentMatchGlobs`).

## Global Constraints

- Tako host MUST be `staging.tako.com` (never `staging.trytako.com`) — already encoded in `lib/tako.ts`; do not touch.
- NEVER call `tako_agent` or `tako_visualize` (CLAUDE.md).
- OpenAI + tools: NEVER pass `reasoningEffort` to a `generateWithTools` call (OpenAI rejects function tools + reasoning_effort — see `lib/agents/tako/compose.ts:187-189`).
- Do NOT rewrite Zod schemas to all-required — `lib/llm.ts` sets `structuredOutputs: false` on OpenAI deliberately (CLAUDE.md).
- Never mutate objects — always return new copies (user's global coding style).
- "Never kill the turn": every lane failure degrades to a weaker answer path with a `notes[]` entry; tool failures return as tool-result strings, never throws.
- Test runner: `npx vitest run <path>` (config: `vitest.config.ts`; component tests live in `components/**/*.test.tsx` and run in jsdom).
- Commit format: `<type>: <description>` (feat/fix/refactor/test/chore), no attribution footer.
- Files ≤ 800 lines; keep new modules focused (one lane per file).

## File Map

| File | Role |
|---|---|
| `lib/agents/shared/router.ts` (modify) | 4-action enum + rewritten router prompt |
| `lib/agents/shared/types.ts` (modify) | `RouteAction` narrowed; `groundedIn.contents` added |
| `lib/agents/shared/retrieval.ts` (modify) | full `fmtNode` serialization (report/criteria/searches); new `nodeCatalog()` |
| `lib/agents/shared/retrieval.test.ts` (create) | serialization + catalog tests |
| `lib/agents/shared/schemas.ts` (modify) | `zComponentPlan` |
| `lib/agents/tako/agent.ts` (modify) | empty-board bypass, router fallback, lane dispatch |
| `lib/agents/tako/chat.ts` (create) | answer lane: gather tool loop + streamed answer |
| `lib/agents/tako/chat.test.ts` (create) | gather loop tests |
| `lib/agents/tako/component.ts` (create) | research lane: distill → `researchLeaf` → anchor |
| `lib/agents/tako/component.test.ts` (create) | research lane tests |
| `lib/agents/tako/prompts.ts` (modify) | `CHAT_GATHER_SYSTEM`, `CHAT_ANSWER_SYSTEM`, `COMPONENT_DISTILL_SYSTEM` |
| `lib/trace.ts` (modify) | `groundedInOf` returns `contents` |
| `components/TraceView.tsx` (modify) | contents chips in the Grounded-in block |
| `components/TraceView.test.tsx` (create) | grounded chips component test |
| `app/globals.css` (modify) | `.ground-chip.data` style |
| `lib/agents/tako/followup.ts` (unchanged) | survives as the answer lane's hard-failure fallback |

---

### Task 1: 4-action router + staged agent dispatch

Delete `NEW_BOARD` and `REFRAME`. Empty board bypasses the router LLM call entirely; `REPLACE` routes to the initial research-tree pipeline; router hard-failure defaults to `EXPLAIN`. EXPLAIN/AUGMENT/GENERATE keep flowing to the legacy `runTakoFollowup` **for now** (Tasks 4-6 replace that) so every commit stays green.

**Files:**
- Modify: `lib/agents/shared/types.ts:3`
- Modify: `lib/agents/shared/router.ts`
- Modify: `lib/agents/tako/agent.ts`
- Modify: `lib/trace.test.ts:11` (fixture uses `NEW_BOARD`)
- Test: `lib/agents/tako/agent.test.ts`

**Interfaces:**
- Produces: `RouteAction = "REPLACE" | "AUGMENT" | "GENERATE" | "EXPLAIN"`; `runTako` dispatch shape later tasks rewire.
- Consumes: existing `runTakoInitial(req, emit, strategy)`, `runTakoFollowup(req, action, historyText, emit)`.

- [ ] **Step 1: Write the failing tests**

Replace the entire contents of `lib/agents/tako/agent.test.ts` with:

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
vi.mock("./strategy", () => ({ graphStrategy: {} }));

const emptyResult = () => ({
  nodeOps: [], narration: "", sideReply: "ok", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { groundedIn: { nodes: [{ id: "nvda", title: "N" }], takoAnswerUsed: false, cards: [] } },
});
const runTakoFollowup = vi.fn(async (..._args: unknown[]) => emptyResult());
vi.mock("./followup", () => ({ runTakoFollowup: (...a: any[]) => runTakoFollowup(...a) }));
const runTakoInitial = vi.fn(async (..._args: unknown[]) => ({ ...emptyResult(), sideReply: null, trace: {} }));
vi.mock("./pipeline", () => ({ runTakoInitial: (...a: any[]) => runTakoInitial(...a) }));

import { runTako } from "./agent";
import { generateStructured } from "../../llm";
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

describe("runTako routing", () => {
  it("folds history and threads action + historyText into the follow-up", async () => {
    const res = await runTako(req);
    expect(foldHistory).toHaveBeenCalledTimes(1);
    const [, actionArg, historyArg] = runTakoFollowup.mock.calls[0];
    expect(actionArg).toBe("EXPLAIN");
    expect(historyArg).toBe("HIST");
    expect(res.memory).toEqual({ summary: "NEWSUM", summarizedThrough: "m3" });
    expect(res.trace?.groundedIn?.nodes[0].id).toBe("nvda");
  });

  it("empty board runs the initial pipeline WITHOUT a router call", async () => {
    const res = await runTako({ ...req, canvasState: { nodes: [], edges: [] }, selection: undefined });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
    expect(res.trace?.action).toBe("REPLACE");
  });

  it("REPLACE on a non-empty board runs the initial pipeline", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "REPLACE", reason: "new topic" } as any);
    await runTako(req);
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
    expect(runTakoFollowup).not.toHaveBeenCalled();
  });

  it("router hard-failure defaults to EXPLAIN instead of killing the turn", async () => {
    vi.mocked(generateStructured).mockRejectedValueOnce(new Error("llm down"));
    const res = await runTako(req);
    expect(runTakoFollowup.mock.calls[0][1]).toBe("EXPLAIN");
    expect(res.trace?.action).toBe("EXPLAIN");
  });

  it("GENERATE flows to the follow-up as AUGMENT until the research lane lands", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "GENERATE", reason: "make a chart" } as any);
    await runTako(req);
    expect(runTakoFollowup.mock.calls[0][1]).toBe("AUGMENT");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: FAIL — `GENERATE`/`REPLACE` cases fail (current agent forwards REPLACE to followup, has no GENERATE, always calls the router).

- [ ] **Step 3: Implement**

`lib/agents/shared/types.ts` line 3 — replace:

```ts
export type RouteAction = "REPLACE" | "AUGMENT" | "GENERATE" | "EXPLAIN";
```

`lib/agents/shared/router.ts` — replace entire file:

```ts
import { z } from "zod";

export const zRouteAction = z.enum(["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN"]);
export const zRoute = z.object({ action: zRouteAction, reason: z.string() });

export const ROUTER = `Route each message to ONE action:
REPLACE — a fresh or different investigation ("actually, let's look at European banks instead"); the research pipeline rebuilds the board.
AUGMENT — add supporting data about something already on the board and connect it ("pull in Intel's numbers too").
GENERATE — the user explicitly asks for a NEW component/chart/card/breakdown on the board ("add a chart of AMD's data-center revenue", "break down X into a card", "create a comparison of...").
EXPLAIN — answer a question from what's known; the board does not change ("why did Nvidia's revenue jump in 2024?").
If a selection is present, prefer EXPLAIN about it, or AUGMENT/GENERATE scoped to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.
Use CONVERSATION SO FAR to resolve references ("it", "that", "them", "tell me more") to the entity/nodes
already discussed — a reference to prior context is usually EXPLAIN or AUGMENT, not REPLACE.
AUGMENT vs GENERATE: both add to the board; GENERATE is an explicit "make/add/create a component" request,
AUGMENT is "bring in more data". When in doubt between EXPLAIN and AUGMENT, prefer EXPLAIN.`;
```

`lib/agents/tako/agent.ts` — replace entire file (staged dispatch; Task 6 finalizes):

```ts
import type { AgentRequest, AgentResponse } from "../../schema";
import type { EmitFn, RouteAction } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { ROUTER, zRoute } from "../shared/router";
import { foldHistory, summarizeTurns } from "../shared/memory";
import { runTakoInitial } from "./pipeline";
import { runTakoFollowup } from "./followup";
import { graphStrategy, type QueryStrategy } from "./strategy";

const OPENAI = "openai" as const;

// Route the turn. An empty board deterministically runs the initial pipeline —
// no router LLM call. A router hard-failure defaults to EXPLAIN (answer the
// turn from board context; never kill it).
async function routeTurn(req: AgentRequest, historyText: string, emit?: EmitFn): Promise<RouteAction> {
  if (req.canvasState.nodes.length === 0) return "REPLACE";
  emit?.({ type: "trace", stage: "routing" });
  try {
    const route = await generateStructured({
      provider: OPENAI,
      system: `${ROUTER}\nReturn { action, reason }.`,
      prompt: ctxBlock(req, historyText),
      schema: zRoute,
      label: "route",
    });
    return route.action;
  } catch {
    return "EXPLAIN";
  }
}

export async function runTako(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<AgentResponse> {
  // Fold conversation history first — feeds routing AND the lanes.
  const folded = await foldHistory({ turns: req.history ?? [], priorSummary: req.historySummary }, summarizeTurns);
  const historyText = folded.historyText;

  const action = await routeTurn(req, historyText, emit);

  // Staged wiring: EXPLAIN/AUGMENT/GENERATE still answer via the legacy
  // follow-up (GENERATE behaves as AUGMENT); the answer/research lanes replace
  // this in the lane tasks. REPLACE (and the empty board) rebuilds via the
  // initial research-tree pipeline.
  const result = action === "REPLACE"
    ? await runTakoInitial(req, emit, strategy)
    : await runTakoFollowup(req, action === "GENERATE" ? "AUGMENT" : action, historyText, emit);

  // Node ops were already streamed; sanitize + provenance-filter them, then let
  // relate.ts append the structural edges. The result carries the authoritative
  // full op set (idempotent with the streamed ops on the client).
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
    trace: { action, provider: req.providerId, queries: [], cards: [], opsApplied: ops.length, notes: [], ms: 0, ...result.trace } as any,
  };
}
```

`lib/trace.test.ts` line 11 — change the fixture action:

```ts
  action: "REPLACE", provider: "tako", queries: ["q nvda", "q amd"], cards: [], opsApplied: 0,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/agent.test.ts lib/trace.test.ts lib/agents/tako/followup.test.ts`
Expected: PASS (followup tests are untouched and must stay green).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc --noEmit`
Expected: no errors (`RouteAction` narrowing compiles because followup.ts only references AUGMENT/REPLACE/EXPLAIN literals, all still in the union).

```bash
git add lib/agents/shared/types.ts lib/agents/shared/router.ts lib/agents/tako/agent.ts lib/agents/tako/agent.test.ts lib/trace.test.ts
git commit -m "feat: 4-action router (REPLACE/AUGMENT/GENERATE/EXPLAIN) with empty-board bypass"
```

---

### Task 2: Full node serialization + node catalog

Clicking a node must expose the whole component to the agent: `fmtNode` gains report blocks, criteria weights, and searches. `nodeCatalog()` gives the gather loop a compact map of every content node.

**Files:**
- Modify: `lib/agents/shared/retrieval.ts`
- Test: `lib/agents/shared/retrieval.test.ts` (create)

**Interfaces:**
- Produces: `nodeCatalog(state: CanvasState): NodeCatalogEntry[]` where `NodeCatalogEntry = { id: string; type: string; title: string; section?: string; hasData: boolean }`. Task 4 consumes it. `nodeContentBlock` output grows new lines; no signature changes.

- [ ] **Step 1: Write the failing tests**

Create `lib/agents/shared/retrieval.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nodeContentBlock, nodeCatalog, retrieveNodes } from "./retrieval";
import type { CanvasNode, CanvasState } from "../../schema";

const base = { grounding: "tako" as const, confidence: 0.9 };

describe("nodeContentBlock full serialization", () => {
  it("serializes report blocks (verdict, tiles, leaderboard, comparison)", () => {
    const node: CanvasNode = {
      id: "synth", type: "text", title: "Verdict", ...base,
      report: {
        verdict: "Nvidia leads.",
        blocks: [
          { kind: "tiles", tiles: [{ label: "Rev", value: "$130B", delta: "+126%" }] },
          { kind: "leaderboard", metricLabel: "Revenue", rows: [{ rank: 1, entity: "Nvidia", value: "$130B" }] },
          { kind: "comparison", series: [{ label: "NVDA", entity: "Nvidia", points: [{ x: "2024", y: 130 }] }] },
        ],
      },
    };
    const out = nodeContentBlock([node]);
    expect(out).toContain("report: Nvidia leads.");
    expect(out).toContain("tiles: Rev=$130B (+126%)");
    expect(out).toContain("leaderboard (Revenue): 1. Nvidia $130B");
    expect(out).toContain("comparison Nvidia: 2024:130");
  });

  it("serializes criteria weights and searches", () => {
    const node: CanvasNode = {
      id: "crit", type: "criteria", title: "Criteria", ...base,
      criteria: { weights: { growth: 0.6, value: 0.4 } },
      searches: ["nvidia revenue", "amd revenue"],
    };
    const out = nodeContentBlock([node]);
    expect(out).toContain("criteria: growth=0.6, value=0.4");
    expect(out).toContain("searches: nvidia revenue; amd revenue");
  });
});

describe("nodeCatalog", () => {
  const state: CanvasState = {
    nodes: [
      { id: "sec", type: "entity_section", title: "Nvidia", ...base },
      { id: "card", type: "data_card", title: "Nvidia revenue", section: "sec", ...base, tako: { cardId: "c1", webpageUrl: "https://t/c1" } },
      { id: "note", type: "text", title: "A note", ...base },
      { id: "src", type: "text", role: "source", title: "Reuters", ...base, sources: [{ url: "https://r/x" }] },
    ],
    edges: [],
  };
  it("lists content nodes with hasData for tako cards and web sources", () => {
    const cat = nodeCatalog(state);
    expect(cat.map((c) => c.id)).toEqual(["card", "note", "src"]); // entity_section excluded
    expect(cat[0]).toEqual({ id: "card", type: "data_card", title: "Nvidia revenue", section: "sec", hasData: true });
    expect(cat[1].hasData).toBe(false);
    expect(cat[2].hasData).toBe(true);
  });
});

describe("retrieveNodes (regression)", () => {
  it("selection-first still returns selected nodes in order", () => {
    const state: CanvasState = {
      nodes: [
        { id: "a", type: "text", title: "A", ...base },
        { id: "b", type: "text", title: "B", ...base },
      ],
      edges: [],
    };
    const out = retrieveNodes(state, { nodeIds: ["b", "a"] }, "anything");
    expect(out.map((n) => n.id)).toEqual(["b", "a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/shared/retrieval.test.ts`
Expected: FAIL — `nodeCatalog` is not exported; report/criteria/searches lines missing.

- [ ] **Step 3: Implement**

In `lib/agents/shared/retrieval.ts`, change the schema import (line 1) to:

```ts
import type { AnswerReport, CanvasNode, CanvasState } from "../../schema";
```

Add below `haystack()`:

```ts
// Compact but complete rendering of a composed answer report — a selected
// synthesis node exposes its actual component content, not just its title.
function fmtReport(r: AnswerReport): string[] {
  const lines = [`report: ${r.verdict}`];
  for (const b of r.blocks) {
    switch (b.kind) {
      case "prose":
        lines.push(`prose: ${b.md.slice(0, 240)}`);
        break;
      case "table":
        lines.push(`table [${b.columns.join(" | ")}]: ${b.rows.slice(0, 6).map((row) => row.join(" | ")).join(" ; ")}`);
        break;
      case "tiles":
        lines.push(`tiles: ${b.tiles.map((t) => `${t.label}=${t.value}${t.delta ? ` (${t.delta})` : ""}`).join("; ")}`);
        break;
      case "chart":
        for (const s of b.chartSpec.series) {
          lines.push(`chart(${b.chartSpec.kind}) ${s.label}: ${s.points.slice(-8).map((p) => `${p.x}:${p.y}`).join(", ")}`);
        }
        break;
      case "comparison":
        for (const s of b.series) {
          lines.push(`comparison ${s.entity}: ${s.points.slice(-8).map((p) => `${p.x}:${p.y}`).join(", ")}`);
        }
        break;
      case "leaderboard":
        lines.push(`leaderboard (${b.metricLabel}): ${b.rows.slice(0, 8).map((row) => `${row.rank}. ${row.entity} ${row.value}`).join("; ")}`);
        break;
      case "sections":
        lines.push(`sections: ${b.sections.map((s) => `${s.title}${s.figure ? ` (${s.figure.label}=${s.figure.value})` : ""}`).join("; ")}`);
        break;
      case "timeline":
        lines.push(`timeline: ${b.events.slice(0, 8).map((e) => `${e.date} ${e.title}${e.value ? ` (${e.value})` : ""}`).join("; ")}`);
        break;
    }
  }
  return lines;
}
```

In `fmtNode`, after the `consensusRows` block and before the `sources` block, add:

```ts
  if (n.criteria) {
    lines.push("criteria: " + Object.entries(n.criteria.weights).map(([k, v]) => `${k}=${v}`).join(", "));
  }
  if (n.searches?.length) lines.push("searches: " + n.searches.join("; "));
  if (n.report) lines.push(...fmtReport(n.report));
```

At the end of the file, add:

```ts
export interface NodeCatalogEntry {
  id: string;
  type: string;
  title: string;
  section?: string;
  hasData: boolean; // has fetchable underlying contents (tako card CSV or web source text)
}

// The gather loop's map of the whole board: every content node, with a flag for
// whether get_node_contents can pull real data behind it.
export function nodeCatalog(state: CanvasState): NodeCatalogEntry[] {
  return (state.nodes ?? []).filter(isContentNode).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    ...(n.section ? { section: n.section } : {}),
    hasData: !!(n.tako?.webpageUrl || n.sources?.length),
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agents/shared/retrieval.test.ts lib/agents/tako/followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/retrieval.ts lib/agents/shared/retrieval.test.ts
git commit -m "feat: full node serialization (report/criteria/searches) + nodeCatalog for the gather loop"
```

---

### Task 3: groundedIn.contents + clickable data chips

The trace's `groundedIn` grows a `contents` list (one entry per real `/v1/contents` fetch). The existing Grounded-in chip row in `TraceView` renders them as clickable chips that select the node on canvas.

**Files:**
- Modify: `lib/agents/shared/types.ts` (groundedIn)
- Modify: `lib/trace.ts` (`groundedInOf`)
- Modify: `lib/trace.test.ts` (`groundedInOf` expectations)
- Modify: `components/TraceView.tsx`
- Modify: `app/globals.css` (after line 667)
- Test: `components/TraceView.test.tsx` (create)

**Interfaces:**
- Produces: `TurnTrace.groundedIn.contents?: { nodeId: string; cardId?: string; title: string; rows: number }[]`; `groundedInOf(...)` now returns `{ nodes, takoAnswerUsed, cards, contents }`. Task 4 populates `contents`.

- [ ] **Step 1: Write the failing tests**

In `lib/trace.test.ts`, replace the `groundedInOf` describe block with:

```ts
describe("groundedInOf", () => {
  it("returns empty structure when the trace has no groundedIn", () => {
    expect(groundedInOf(undefined)).toEqual({ nodes: [], takoAnswerUsed: false, cards: [], contents: [] });
    expect(groundedInOf({} as any)).toEqual({ nodes: [], takoAnswerUsed: false, cards: [], contents: [] });
  });

  it("passes through nodes/cards/contents and the tako flag", () => {
    const g = groundedInOf({
      groundedIn: {
        nodes: [{ id: "nvda", title: "Nvidia revenue" }],
        takoAnswerUsed: true,
        cards: [{ id: "c1", title: "Card", url: "https://x" }],
        contents: [{ nodeId: "nvda", cardId: "c1", title: "Nvidia revenue", rows: 12 }],
      },
    } as any);
    expect(g.nodes[0].id).toBe("nvda");
    expect(g.takoAnswerUsed).toBe(true);
    expect(g.cards[0].id).toBe("c1");
    expect(g.contents[0]).toEqual({ nodeId: "nvda", cardId: "c1", title: "Nvidia revenue", rows: 12 });
  });
});
```

Create `components/TraceView.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import TraceView from "./TraceView";

afterEach(cleanup);

const trace: any = {
  action: "EXPLAIN", provider: "tako", queries: [], cards: [], opsApplied: 0, notes: [], ms: 1200,
  groundedIn: {
    nodes: [{ id: "nvda", title: "Nvidia revenue" }],
    takoAnswerUsed: true,
    cards: [],
    contents: [{ nodeId: "nvda", cardId: "c1", title: "Nvidia revenue", rows: 12 }],
  },
};

describe("TraceView grounded chips", () => {
  it("renders a contents chip and selects its node on click", () => {
    const onSelect = vi.fn();
    render(<TraceView trace={trace} streaming={false} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Trace")); // expand the collapsed trace
    fireEvent.click(screen.getByText("Nvidia revenue · data"));
    expect(onSelect).toHaveBeenCalledWith("nvda");
  });

  it("node chips still select on click", () => {
    const onSelect = vi.fn();
    render(<TraceView trace={trace} streaming={false} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Trace"));
    fireEvent.click(screen.getByText("Nvidia revenue"));
    expect(onSelect).toHaveBeenCalledWith("nvda");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/trace.test.ts components/TraceView.test.tsx`
Expected: FAIL — `contents` missing from `groundedInOf`; no "· data" chip rendered.

- [ ] **Step 3: Implement**

`lib/agents/shared/types.ts` — inside `TurnTrace.groundedIn`, add the `contents` field:

```ts
  groundedIn?: {
    nodes: { id: string; title: string }[];
    takoAnswerUsed: boolean;
    cards: { id: string; title: string; url: string }[];
    // One entry per real /v1/contents fetch this turn — the underlying data the
    // answer actually read. Optional for back-compat with persisted sessions.
    contents?: { nodeId: string; cardId?: string; title: string; rows: number }[];
  };
```

`lib/trace.ts` — replace `groundedInOf` with:

```ts
export function groundedInOf(trace: TurnTrace | undefined): {
  nodes: { id: string; title: string }[];
  takoAnswerUsed: boolean;
  cards: TraceCard[];
  contents: { nodeId: string; cardId?: string; title: string; rows: number }[];
} {
  const g = trace?.groundedIn;
  return {
    nodes: g?.nodes ?? [],
    takoAnswerUsed: g?.takoAnswerUsed ?? false,
    cards: g?.cards ?? [],
    contents: g?.contents ?? [],
  };
}
```

`components/TraceView.tsx` — update `hasGrounded` (currently `grounded.nodes.length > 0 || grounded.cards.length > 0 || grounded.takoAnswerUsed`):

```ts
  const hasGrounded = grounded.nodes.length > 0 || grounded.cards.length > 0
    || grounded.contents.length > 0 || grounded.takoAnswerUsed;
```

In the grounded-in chips block, after the `grounded.nodes.map(...)` buttons and before the `takoAnswerUsed` chip, add:

```tsx
                {grounded.contents.map((c) => (
                  <button
                    key={`${c.nodeId}:${c.cardId ?? c.title}`}
                    type="button"
                    className="ground-chip data"
                    onClick={() => onSelectNode?.(c.nodeId)}
                    title={`Read ${c.rows} rows of this node's underlying data`}
                  >
                    {c.title} · data
                  </button>
                ))}
```

`app/globals.css` — after the `.ground-chip.tako-src` rule (line 667), add:

```css
.ground-chip.data { cursor: pointer; background: var(--accent-wash); border-color: var(--accent-border); }
.ground-chip.data:hover { border-color: var(--accent); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/trace.test.ts components/TraceView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/types.ts lib/trace.ts lib/trace.test.ts components/TraceView.tsx components/TraceView.test.tsx app/globals.css
git commit -m "feat: groundedIn.contents provenance + clickable data chips in the trace"
```

---

### Task 4: Answer lane — the gather tool loop (`chat.ts`)

Phase A: an OpenAI `generateWithTools` loop with `get_node_contents` (always) and `tako_answer` (only when the kill-switch allows) over the node catalog. Phase B: `streamAnswer` composes the grounded prose. Hard Phase-A failure falls back to `runTakoFollowup`.

**Files:**
- Modify: `lib/agents/tako/prompts.ts` (append two prompts)
- Create: `lib/agents/tako/chat.ts`
- Test: `lib/agents/tako/chat.test.ts` (create)

**Interfaces:**
- Consumes: `nodeCatalog` (Task 2), `groundedIn.contents` shape (Task 3), `generateWithTools`/`streamAnswer` (`lib/llm.ts`), `takoAnswer`/`takoContents` (`lib/tako.ts`), `excerptCsv` (`lib/agents/tako/flow.ts`), `runTakoFollowup` (fallback).
- Produces: `runAnswerLane(req: AgentRequest, historyText: string, emit?: EmitFn): Promise<PipelineResult>` — Task 5 (degrade) and Task 6 (dispatch) consume it.

- [ ] **Step 1: Write the failing tests**

Create `lib/agents/tako/chat.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";
import type { AgentRequest, CanvasNode } from "../../schema";

// generateWithTools mock: simulates the model calling each provided tool once,
// then returning an analyst note. Tests override `script` to drive other flows.
let script: ((tools: any) => Promise<void>) | null = null;
vi.mock("../../llm", () => ({
  generateWithTools: vi.fn(async (opts: any) => {
    if (script) await script(opts.tools);
    else {
      if (opts.tools.get_node_contents) await opts.tools.get_node_contents.execute({ nodeId: "nvda" });
      if (opts.tools.tako_answer) await opts.tools.tako_answer.execute({ query: "amd revenue" });
    }
    return { text: "note", steps: 2 };
  }),
  streamAnswer: vi.fn(async (opts: any) => {
    opts.onToken("answer");
    return "answer";
  }),
}));

vi.mock("../../tako", () => ({
  takoContents: vi.fn(async () => ({ csv: "Timestamp,Revenue\n2023,61\n2024,130", totalRows: 2 })),
  takoAnswer: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "amd", title: "AMD rev", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "Tako" }];
    opts.onCall?.({ query: q, endpoint: "/v1/answer", effort: "fast", web: false, ms: 2, cards });
    return { answer: "AMD grew revenue.", cards };
  }),
}));

const runTakoFollowup = vi.fn(async () => ({
  nodeOps: [], narration: "", sideReply: "legacy", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { notes: ["legacy path"] },
}));
vi.mock("./followup", () => ({ runTakoFollowup: (...a: any[]) => runTakoFollowup(...a) }));

import { runAnswerLane } from "./chat";
import { generateWithTools } from "../../llm";
import { takoContents, takoAnswer } from "../../tako";

const cardNode: CanvasNode = {
  id: "nvda", type: "data_card", title: "Nvidia revenue", grounding: "tako", confidence: 0.9,
  tako: { cardId: "c-nvda", webpageUrl: "https://t/nvda" },
};

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    canvasId: "c", message: "when did it peak?", surface: "side_chat",
    canvasState: { nodes: [cardNode], edges: [] },
    selection: { nodeIds: ["nvda"], nodes: [cardNode] },
    providerId: "tako", takoAnswerEnabled: true, history: [],
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); script = null; });

describe("runAnswerLane — gather loop", () => {
  it("fetches node contents and records groundedIn.contents with rows", async () => {
    const result = await runAnswerLane(req(), "", () => {});
    expect(takoContents).toHaveBeenCalledWith("https://t/nvda", { mode: "inline" });
    expect(result.trace.groundedIn?.contents).toEqual([
      { nodeId: "nvda", cardId: "c-nvda", title: "Nvidia revenue", rows: 2 },
    ]);
    expect(result.sideReply).toBe("answer"); // side_chat → sideReply
    expect(result.nodeOps).toEqual([]); // the answer lane never mints nodes
  });

  it("records tako answer usage in trace + groundedIn", async () => {
    const result = await runAnswerLane(req(), "", () => {});
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    expect(result.trace.answerUsed).toBe(true);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(true);
    expect(result.trace.queries).toEqual(["amd revenue"]);
  });

  it("omits the tako_answer tool entirely when takoAnswerEnabled is false", async () => {
    await runAnswerLane(req({ takoAnswerEnabled: false }), "", () => {});
    const tools = vi.mocked(generateWithTools).mock.calls[0][0].tools;
    expect(tools.tako_answer).toBeUndefined();
    expect(tools.get_node_contents).toBeDefined();
    expect(takoAnswer).not.toHaveBeenCalled();
  });

  it("emits a tako_call event per real fetch", async () => {
    const events: AgentEvent[] = [];
    await runAnswerLane(req(), "", (e) => events.push(e));
    const calls = events.filter((e) => e.type === "tako_call") as any[];
    expect(calls.map((c) => c.call.endpoint).sort()).toEqual(["/v1/answer", "/v1/contents"]);
  });

  it("caches repeat fetches and enforces the contents budget", async () => {
    const many = Array.from({ length: 10 }, (_, i): CanvasNode => ({
      id: `n${i}`, type: "data_card", title: `N${i}`, grounding: "tako", confidence: 0.9,
      tako: { cardId: `c${i}`, webpageUrl: `https://t/${i}` },
    }));
    script = async (tools) => {
      await tools.get_node_contents.execute({ nodeId: "n0" });
      await tools.get_node_contents.execute({ nodeId: "n0" }); // cache hit — no second fetch
      for (let i = 1; i < 10; i++) await tools.get_node_contents.execute({ nodeId: `n${i}` });
    };
    await runAnswerLane(req({ canvasState: { nodes: many, edges: [] }, selection: undefined }), "", () => {});
    expect(takoContents).toHaveBeenCalledTimes(8); // budget of 8 real fetches
  });

  it("returns tool-result strings for unknown nodes and fetch errors (loop survives)", async () => {
    let unknownMsg = "", errMsg = "";
    vi.mocked(takoContents).mockRejectedValueOnce(new Error("boom"));
    script = async (tools) => {
      unknownMsg = await tools.get_node_contents.execute({ nodeId: "nope" });
      errMsg = await tools.get_node_contents.execute({ nodeId: "nvda" });
    };
    const result = await runAnswerLane(req(), "", () => {});
    expect(unknownMsg).toContain("unknown nodeId");
    expect(errMsg).toContain("contents unavailable");
    expect(result.sideReply).toBe("answer"); // turn still answered
  });

  it("falls back to the legacy follow-up when the gather loop hard-fails", async () => {
    vi.mocked(generateWithTools).mockRejectedValueOnce(new Error("tool loop exploded"));
    const result = await runAnswerLane(req(), "HIST", () => {});
    expect(runTakoFollowup).toHaveBeenCalledWith(expect.anything(), "EXPLAIN", "HIST", expect.anything());
    expect(result.sideReply).toBe("legacy");
    expect(result.trace.notes?.[0]).toContain("gather loop failed");
  });

  it("main surface streams tokens into narration", async () => {
    const events: AgentEvent[] = [];
    const result = await runAnswerLane(req({ surface: "main" }), "", (e) => events.push(e));
    expect(result.narration).toBe("answer");
    expect(result.sideReply).toBeNull();
    expect(events.some((e) => e.type === "token")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/chat.test.ts`
Expected: FAIL with "Cannot find module './chat'".

- [ ] **Step 3: Add the prompts**

Append to `lib/agents/tako/prompts.ts`:

```ts
// Phase A of the answer lane: decide which evidence the follow-up answer needs.
export const CHAT_GATHER_SYSTEM = `You are the Canvas Assistant's evidence gatherer for a follow-up question about a research canvas.
You are given the conversation context, BOARD CONTEXT (full content of the relevant/selected nodes) and
NODE_CATALOG — every node on the board as {id, type, title, section?, hasData}.
Tools:
- get_node_contents(nodeId): the REAL underlying data behind that node — the CSV series behind a chart card,
  or the page text behind a web source. Only hasData:true nodes have contents.
- tako_answer(query): a grounded answer (prose + real data cards) for data the board does NOT have.
  This tool may be absent this turn — then answer from the board alone.
Decide what the answer needs:
- Answerable from the visible node summaries alone → fetch nothing.
- About the values/trend inside a node's series ("when did it peak", "latest value", "compare these two") →
  get_node_contents on THAT node (and every comparison counterpart).
- Needs data beyond the board ("how does that compare to Germany") → tako_answer with a short,
  single-subject data query (one entity + one measure; never "X vs Y" in one query).
Fetch ONLY what the question needs. Then reply with a SHORT analyst note (<=120 words): what the gathered
evidence shows and which pieces matter for the answer. Plain text only.`;

// Phase B of the answer lane: the streamed grounded answer.
export const CHAT_ANSWER_SYSTEM = `You are the Canvas Assistant answering a follow-up in a chat panel.
Answer the user's MESSAGE from BOARD CONTEXT (the nodes they can see) plus the evidence gathered this turn:
GROUNDED_ANSWERS (fresh Tako answers), FETCHED_CONTENTS (the REAL data series behind board nodes, as CSV
excerpts), and ANALYST_NOTES. Use CONVERSATION SO FAR to resolve what "this"/"that"/"them" refer to.
- Prefer the real fetched series over one-line node summaries — read the CSVs and quote actual, latest values.
- Be concise and conversational: 1-3 short paragraphs, no headings. Light markdown only (**bold** a key
  figure, "- " bullets for 3+ items).
- Use ONLY facts present in the provided context. Never invent a number or source. Never mention missing data.`;
```

- [ ] **Step 4: Implement `lib/agents/tako/chat.ts`**

```ts
// Answer lane (EXPLAIN): a bounded agentic gather loop over the board's real data,
// then a streamed grounded answer. Phase A (generateWithTools) decides which node
// contents to pull (/v1/contents) and which fresh grounded answers to fetch
// (/v1/answer); Phase B streams the final prose composed from board context +
// gathered evidence. A hard Phase-A failure falls back to the legacy simple
// follow-up — never kill the turn.
import { tool } from "ai";
import type { CoreTool } from "ai";
import { z } from "zod";
import type { AgentRequest } from "../../schema";
import type { EmitFn, PipelineResult, TakoCallRecord, Timings } from "../shared/types";
import { generateWithTools, streamAnswer } from "../../llm";
import { takoAnswer, takoContents } from "../../tako";
import { ctxBlock } from "../shared/ctx";
import { retrieveNodes, nodeCatalog } from "../shared/retrieval";
import { excerptCsv } from "./flow";
import { CHAT_GATHER_SYSTEM, CHAT_ANSWER_SYSTEM } from "./prompts";
import { runTakoFollowup } from "./followup";
import { log } from "../../log";

const OPENAI = "openai" as const;
const GATHER_MAX_STEPS = 6; // bounded evidence loop (spec)
const CONTENTS_BUDGET = 8; // real /v1/contents fetches per turn (cache hits are free)
const CHAT_NODE = "chat"; // nodeId all chat-lane calls/synthesis events key on

interface GatheredAnswer { query: string; answer: string; cardTitles: string[] }
interface GatheredContents { nodeId: string; cardId?: string; title: string; data: string; rows: number }
interface GatherOut {
  note: string;
  answers: GatheredAnswer[];
  contents: GatheredContents[];
  answerCards: { id: string; title: string; url: string }[];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Phase A: the model reads the node catalog + board context and pulls exactly the
// evidence it needs. Tool failures come back as tool-RESULT strings so the loop
// always survives them; only a loop-level throw escapes (the caller falls back).
async function gatherEvidence(
  req: AgentRequest, historyText: string, calls: TakoCallRecord[], emit?: EmitFn,
): Promise<GatherOut> {
  const catalog = nodeCatalog(req.canvasState);
  const byId = new Map(req.canvasState.nodes.map((n) => [n.id, n]));
  const cache = new Map<string, string>();
  let fetched = 0;
  const answers: GatheredAnswer[] = [];
  const contents: GatheredContents[] = [];
  const answerCards: { id: string; title: string; url: string }[] = [];

  const recordCall = (call: TakoCallRecord) => {
    calls.push(call);
    emit?.({ type: "tako_call", call });
  };

  const tools: Record<string, CoreTool> = {
    get_node_contents: tool({
      description:
        "Fetch the real underlying data behind a board node from NODE_CATALOG — the CSV series behind a chart card, or the page text behind a web source. Only hasData:true nodes have contents.",
      parameters: z.object({ nodeId: z.string() }),
      execute: async ({ nodeId }) => {
        const n = byId.get(nodeId);
        if (!n) {
          const valid = catalog.filter((c) => c.hasData).map((c) => c.id).join(", ") || "(none)";
          return `unknown nodeId — nodes with data: ${valid}`;
        }
        const url = n.tako?.webpageUrl || n.sources?.[0]?.url;
        if (!url) return "this node has no underlying data source";
        const hit = cache.get(url);
        if (hit !== undefined) return hit ? excerptCsv(hit) : "no data available";
        if (fetched >= CONTENTS_BUDGET) return "contents budget exhausted — answer from the evidence you already have";
        fetched++;
        const t0 = Date.now();
        try {
          const c = await takoContents(url, { mode: "inline" });
          const data = c.csv || c.text || "";
          cache.set(url, data);
          recordCall({
            callId: `${CHAT_NODE}:contents:${calls.length}`, nodeId: CHAT_NODE,
            query: n.title, endpoint: "/v1/contents", effort: "fast", ms: Date.now() - t0,
            cards: [{ id: n.tako?.cardId ?? nodeId, title: n.title, url }],
            ...(data ? {} : { error: "no data available" }),
          });
          if (!data) return "no data available";
          contents.push({
            nodeId, cardId: n.tako?.cardId, title: n.title,
            data: excerptCsv(data),
            rows: Math.max(0, data.split("\n").filter(Boolean).length - 1),
          });
          return excerptCsv(data);
        } catch (e: unknown) {
          cache.set(url, "");
          recordCall({
            callId: `${CHAT_NODE}:contents:${calls.length}`, nodeId: CHAT_NODE,
            query: n.title, endpoint: "/v1/contents", effort: "fast", ms: Date.now() - t0,
            cards: [], error: errorMessage(e),
          });
          return `contents unavailable: ${errorMessage(e)}`;
        }
      },
    }),
  };

  // Kill-switch: when disabled, the grounded-answer tool simply does not exist.
  if (req.takoAnswerEnabled !== false) {
    tools.tako_answer = tool({
      description:
        "Ask Tako for a grounded answer (prose + real data cards) to a short, single-subject data question the board cannot answer.",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        try {
          const res = await takoAnswer(query, {
            effort: "fast",
            onCall: (m) => recordCall({
              callId: `${CHAT_NODE}:answer:${calls.length}`, nodeId: CHAT_NODE,
              query: m.query, endpoint: m.endpoint, effort: m.effort, web: m.web, ms: m.ms,
              cards: m.cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
              error: m.error,
            }),
          });
          answers.push({ query, answer: res.answer, cardTitles: res.cards.map((c) => c.title) });
          answerCards.push(...res.cards.map((c) => ({ id: c.cardId!, title: c.title, url: c.webpageUrl || c.embedUrl || "" })));
          return res.answer
            ? `${res.answer}\n\nCARDS: ${res.cards.map((c) => c.title).join("; ") || "(none)"}`
            : "no grounded answer available";
        } catch (e: unknown) {
          return `tako answer unavailable: ${errorMessage(e)}`;
        }
      },
    });
  }

  // No reasoningEffort here: OpenAI rejects function tools + reasoning_effort on
  // chat completions (see compose.ts / commit f4da8e7).
  const res = await generateWithTools({
    provider: OPENAI, system: CHAT_GATHER_SYSTEM,
    prompt: `${ctxBlock(req, historyText)}\n\nNODE_CATALOG: ${JSON.stringify(catalog)}`,
    tools, maxSteps: GATHER_MAX_STEPS, label: "chat-gather",
  });
  return { note: res.text, answers, contents, answerCards };
}

// The EXPLAIN lane. Gathers evidence agentically, then streams the grounded
// answer. Never mints board nodes.
export async function runAnswerLane(
  req: AgentRequest, historyText: string, emit?: EmitFn,
): Promise<PipelineResult> {
  const timings: Partial<Timings> = {};
  const calls: TakoCallRecord[] = [];
  const toBoard = req.surface !== "side_chat";
  const retrieved = retrieveNodes(req.canvasState, req.selection, req.message);

  emit?.({ type: "trace", stage: "gathering evidence" });
  let gathered: GatherOut;
  let t = Date.now();
  try {
    gathered = await gatherEvidence(req, historyText, calls, emit);
  } catch (e: unknown) {
    // Phase-A hard failure → the legacy simple follow-up answers the turn.
    const note = `gather loop failed — falling back (${errorMessage(e)})`;
    log("tako", "chat gather fallback", { error: errorMessage(e) });
    const fallback = await runTakoFollowup(req, "EXPLAIN", historyText, emit);
    fallback.trace.notes = [note, ...(fallback.trace.notes ?? [])];
    return fallback;
  }
  timings.search = Date.now() - t;

  const takoAnswerUsed = gathered.answers.length > 0;
  emit?.({ type: "trace", stage: "writing answer" });
  emit?.({
    type: "synthesis", phase: "start", nodeId: CHAT_NODE, kind: "root",
    inputs: { fromNodeIds: retrieved.map((n) => n.id), findingTitles: gathered.contents.map((c) => c.title) },
  });
  t = Date.now();
  const prompt = [
    ctxBlock(req, historyText),
    `\nGROUNDED_ANSWERS: ${gathered.answers.length ? JSON.stringify(gathered.answers) : "(none)"}`,
    `\nFETCHED_CONTENTS: ${gathered.contents.length ? JSON.stringify(gathered.contents.map((c) => ({ node: c.title, data: c.data }))) : "(none)"}`,
    `\nANALYST_NOTES: ${gathered.note || "(none)"}`,
  ].join("\n");
  const prose = await streamAnswer({
    provider: OPENAI, system: CHAT_ANSWER_SYSTEM, prompt, label: "chat-answer",
    onToken: (c) => { if (toBoard) emit?.({ type: "token", text: c }); },
  });
  emit?.({ type: "synthesis", phase: "end", nodeId: CHAT_NODE, kind: "root" });
  timings.stream = Date.now() - t;

  log("tako", "chat answer lane", {
    retrieved: retrieved.length, answers: gathered.answers.length, contents: gathered.contents.length, ...timings,
  });

  return {
    nodeOps: [], // the answer lane NEVER mints board nodes
    narration: toBoard ? prose : "",
    sideReply: toBoard ? null : prose,
    validCardIds: new Set(),
    allowedNodeIds: new Set(),
    trace: {
      queries: gathered.answers.map((a) => a.query),
      answerUsed: takoAnswerUsed,
      cards: gathered.answerCards,
      calls,
      notes: [],
      groundedIn: {
        nodes: retrieved.map((n) => ({ id: n.id, title: n.title })),
        takoAnswerUsed,
        cards: gathered.answerCards,
        contents: gathered.contents.map(({ nodeId, cardId, title, rows }) => ({ nodeId, cardId, title, rows })),
      },
      timings: { ...timings, total: 0 } as Timings,
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/chat.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/chat.ts lib/agents/tako/chat.test.ts lib/agents/tako/prompts.ts
git commit -m "feat: answer-lane gather loop — tako_answer + get_node_contents tools with budget, cache, kill-switch"
```

---

### Task 5: Research lane — distill → researchLeaf → anchor (`component.ts`)

GENERATE/AUGMENT distill the request into `{question, entities, subtype?, metricFilters}` (one corrective retry), run the existing `researchLeaf` to mint the subquery answer node, anchor it with a `derived_from` edge to `selection[0]` (else the synthesis node), and degrade to the answer lane on any failure.

**Files:**
- Modify: `lib/agents/shared/schemas.ts` (add `zComponentPlan` after `zResearchPlan`)
- Modify: `lib/agents/shared/schemas.test.ts` (add plan cases)
- Modify: `lib/agents/tako/prompts.ts` (append distill prompt)
- Create: `lib/agents/tako/component.ts`
- Test: `lib/agents/tako/component.test.ts` (create)

**Interfaces:**
- Consumes: `researchLeaf(question, depth, nodeId, root, ctx, lookup, rationale?)`, `newResearchCtx(req, ledger, push, emit, strategy)`, `uniqueResearchId(ctx, question)`, `derivedEdge(from, to)` — all already exported from `lib/agents/tako/flow.ts`; `runAnswerLane` (Task 4); `GraphLookup` from schemas.
- Produces: `runComponentLane(req: AgentRequest, action: "AUGMENT" | "GENERATE", historyText: string, emit?: EmitFn, strategy?: QueryStrategy): Promise<PipelineResult>` — Task 6 consumes it. `zComponentPlan` / `ComponentPlan` exported from schemas.

- [ ] **Step 1: Write the failing schema tests**

Append to `lib/agents/shared/schemas.test.ts`:

```ts
import { zComponentPlan } from "./schemas";

describe("zComponentPlan", () => {
  it("accepts a full plan", () => {
    const plan = zComponentPlan.parse({
      question: "AMD data-center revenue", rationale: "user asked for a chart",
      entities: ["Advanced Micro Devices", "AMD"], subtype: "Companies", metricFilters: ["revenue", "data center"],
    });
    expect(plan.question).toBe("AMD data-center revenue");
  });
  it("rejects a plan without entities or metricFilters", () => {
    expect(() => zComponentPlan.parse({ question: "q", rationale: "r", entities: [], metricFilters: ["x"] })).toThrow();
    expect(() => zComponentPlan.parse({ question: "q", rationale: "r", entities: ["A"], metricFilters: [] })).toThrow();
  });
});
```

(If the file has no top-level `describe` import block covering these, follow its existing import style — it already imports from `vitest` and `./schemas`.)

- [ ] **Step 2: Write the failing lane tests**

Create `lib/agents/tako/component.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRequest, CanvasNode } from "../../schema";

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async () => ({
    question: "AMD data-center revenue", rationale: "user asked",
    entities: ["Advanced Micro Devices", "AMD"], subtype: "Companies", metricFilters: ["revenue"],
  })),
  streamAnswer: vi.fn(),
}));

const researchLeaf = vi.fn(async (_q: string, _d: number, nodeId: string) => ({
  nodeId, title: "AMD data-center revenue", synthesis: "AMD grew.", findingCount: 2,
  children: [], depth: 1, kind: "leaf" as const,
}));
vi.mock("./flow", async (orig) => {
  const real: any = await orig();
  return { ...real, researchLeaf: (...a: any[]) => researchLeaf(...a) };
});

const runAnswerLane = vi.fn(async () => ({
  nodeOps: [], narration: "", sideReply: "degraded answer", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { notes: [] },
}));
vi.mock("./chat", () => ({ runAnswerLane: (...a: any[]) => runAnswerLane(...a) }));
vi.mock("./strategy", () => ({ graphStrategy: {} }));

import { runComponentLane } from "./component";
import { generateStructured } from "../../llm";

const boardNode: CanvasNode = { id: "nvda", type: "data_card", title: "Nvidia revenue", grounding: "tako", confidence: 0.9 };
const synthNode: CanvasNode = { id: "synth", type: "text", role: "synthesis", title: "Answer", grounding: "tako", confidence: 0.9 };

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    canvasId: "c", message: "add a chart of AMD's data-center revenue", surface: "main",
    canvasState: { nodes: [boardNode, synthNode], edges: [] },
    selection: { nodeIds: ["nvda"], nodes: [boardNode] },
    providerId: "tako", takoAnswerEnabled: true, history: [],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("runComponentLane", () => {
  it("distills a plan and runs researchLeaf with the lookup", async () => {
    await runComponentLane(req(), "GENERATE", "", () => {});
    expect(researchLeaf).toHaveBeenCalledTimes(1);
    const [question, depth, nodeId, root, , lookup] = researchLeaf.mock.calls[0];
    expect(question).toBe("AMD data-center revenue");
    expect(depth).toBe(1);
    expect(root).toBe(false);
    expect(String(nodeId)).toMatch(/^rq_/);
    expect(lookup).toEqual({ entities: ["Advanced Micro Devices", "AMD"], subtype: "Companies", metricFilters: ["revenue"] });
  });

  it("anchors the new node to the selection with a derived_from edge", async () => {
    const result = await runComponentLane(req(), "GENERATE", "", () => {});
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges).toContainEqual(expect.objectContaining({ to: "nvda", kind: "derived_from" }));
  });

  it("falls back to the synthesis node as anchor when nothing is selected", async () => {
    const result = await runComponentLane(req({ selection: undefined }), "AUGMENT", "", () => {});
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges).toContainEqual(expect.objectContaining({ to: "synth", kind: "derived_from" }));
  });

  it("narration carries the leaf synthesis; side_chat routes it to sideReply", async () => {
    const main = await runComponentLane(req(), "GENERATE", "", () => {});
    expect(main.narration).toContain("AMD grew.");
    expect(main.sideReply).toBeNull();
    const side = await runComponentLane(req({ surface: "side_chat" }), "GENERATE", "", () => {});
    expect(side.sideReply).toContain("AMD grew.");
  });

  it("degrades to the answer lane when the leaf finds nothing", async () => {
    researchLeaf.mockResolvedValueOnce({ nodeId: null, title: "q", synthesis: "", findingCount: 0, children: [], depth: 1, kind: "leaf" });
    const result = await runComponentLane(req(), "GENERATE", "HIST", () => {});
    expect(runAnswerLane).toHaveBeenCalledTimes(1);
    expect(result.sideReply).toBe("degraded answer");
    expect(result.trace.notes?.some((n: string) => n.includes("no data found"))).toBe(true);
  });

  it("retries the distill once with a schema reminder, then degrades if both fail", async () => {
    vi.mocked(generateStructured)
      .mockRejectedValueOnce(new Error("invalid"))
      .mockRejectedValueOnce(new Error("invalid again"));
    const result = await runComponentLane(req(), "GENERATE", "", () => {});
    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateStructured).mock.calls[1][0].prompt).toContain("SCHEMA_REMINDER");
    expect(runAnswerLane).toHaveBeenCalledTimes(1);
    expect(result.sideReply).toBe("degraded answer");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/agents/shared/schemas.test.ts lib/agents/tako/component.test.ts`
Expected: FAIL — `zComponentPlan` not exported; `./component` module missing.

- [ ] **Step 4: Implement the schema and prompt**

In `lib/agents/shared/schemas.ts`, after `zResearchPlan`, add:

```ts
// The research lane's distilled plan: ONE researchable sub-question + the same
// entity-first lookup researchLeaf consumes (see zLookup docs above).
export const zComponentPlan = z.object({
  question: z.string().min(1),
  rationale: z.string(),
  ...zLookup,
});
export type ComponentPlan = z.infer<typeof zComponentPlan>;
```

Append to `lib/agents/tako/prompts.ts`:

```ts
// Research lane (GENERATE/AUGMENT): distill the request into ONE researchable
// sub-question + entity-first lookup for researchLeaf.
export const COMPONENT_DISTILL_SYSTEM = `You turn a user's request to add data/a component to a research canvas into ONE researchable sub-question with an entity-first graph lookup.
You are given the conversation context, BOARD CONTEXT (the nodes they can see, selection first) and the REQUEST.
Return { question, rationale, entities, subtype?, metricFilters }.
- question: ONE subject + ONE measure, phrased as a research question ("AMD's data-center revenue").
  Resolve references from the SELECTION/BOARD CONTEXT: "chart this for Germany too" with a France-inflation
  node selected → the Germany equivalent of that node's measure. A multi-entity request ("compare X and Y")
  targets the entity NOT already on the board — the board already covers the rest.
- entities: 1-3 COMPLETELY DIFFERENT candidate names for that ONE subject, the graph might register it under
  ("Google" and "Alphabet"). For companies lead with the FORMAL registered name ("Advanced Micro Devices",
  not "AMD" — add the colloquial name as a SECOND candidate). Never two different subjects.
- subtype: one of these graph entity classes copied verbatim when it clearly fits, else omit/null:
  ${GRAPH_ENTITY_SUBTYPES_LINE}
- metricFilters: 2-5 case-insensitive substring fragments of metric NAMES ("revenue", "margin", "stock price")
  — one word preferred, never the subject/domain, list naming variants of the SAME measure.
- rationale: 1 sentence — why this lookup answers the request.`;
```

- [ ] **Step 5: Implement `lib/agents/tako/component.ts`**

```ts
// Research lane (GENERATE / AUGMENT): distill the request into ONE researchable
// sub-question + entity-first lookup, run the existing researchLeaf (graph search +
// related → cards → streamed mini-synthesis) to mint a subquery answer node on the
// board, and anchor it beside the selection. Every failure degrades to the answer
// lane — never a dead turn.
import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings } from "../shared/types";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zComponentPlan, type ComponentPlan, type GraphLookup } from "../shared/schemas";
import { FindingLedger } from "./findings";
import { newResearchCtx, researchLeaf, uniqueResearchId, derivedEdge } from "./flow";
import { COMPONENT_DISTILL_SYSTEM } from "./prompts";
import { runAnswerLane } from "./chat";
import { graphStrategy, type QueryStrategy } from "./strategy";
import { log } from "../../log";

const OPENAI = "openai" as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Distill with one corrective retry (the established decompose pattern). Null when
// both attempts fail — the caller degrades to the answer lane.
async function distillPlan(req: AgentRequest, historyText: string, notes: string[]): Promise<ComponentPlan | null> {
  const prompt = `${ctxBlock(req, historyText)}\n\nREQUEST: ${req.message}`;
  try {
    return await generateStructured({
      provider: OPENAI, system: COMPONENT_DISTILL_SYSTEM, prompt,
      schema: zComponentPlan, label: "component-distill",
    });
  } catch (e: unknown) {
    notes.push(`component distill invalid — retrying once (${errorMessage(e).slice(0, 100)})`);
    try {
      return await generateStructured({
        provider: OPENAI, system: COMPONENT_DISTILL_SYSTEM,
        prompt: `${prompt}\n\nSCHEMA_REMINDER: Your previous response did not match the required schema.` +
          ` Return { question, rationale, entities (1-3 candidate name strings), subtype?, metricFilters (1-5 short metric-name fragments) }.`,
        schema: zComponentPlan, label: "component-distill",
      });
    } catch (e2: unknown) {
      notes.push(`component distill failed — ${errorMessage(e2).slice(0, 100)}`);
      return null;
    }
  }
}

// Any-failure escape hatch: answer the turn via the answer lane, carrying the
// research lane's notes so the trace explains the degradation.
async function degrade(req: AgentRequest, historyText: string, notes: string[], emit?: EmitFn): Promise<PipelineResult> {
  const fallback = await runAnswerLane(req, historyText, emit);
  fallback.trace.notes = [...notes, ...(fallback.trace.notes ?? [])];
  return fallback;
}

export async function runComponentLane(
  req: AgentRequest, action: "AUGMENT" | "GENERATE", historyText: string,
  emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const notes: string[] = [];
  emit?.({ type: "trace", stage: "planning component" });
  const plan = await distillPlan(req, historyText, notes);
  if (!plan) return degrade(req, historyText, notes, emit);

  const ledger = new FindingLedger();
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const push = (ops: CanvasOp[]) => {
    for (const op of ops) {
      nodeOps.push(op);
      if (op.op === "add_node" || op.op === "upsert_node") allowedNodeIds.add(op.node.id);
    }
    if (ops.length) emit?.({ type: "ops", ops });
  };
  const ctx = newResearchCtx(req, ledger, push, emit, strategy);
  ctx.notes.push(...notes);
  // Existing board ids can never be reused by the new research node.
  for (const n of req.canvasState.nodes) ctx.usedIds.add(n.id);

  const nodeId = uniqueResearchId(ctx, plan.question);
  const lookup: GraphLookup = {
    entities: plan.entities,
    ...(plan.subtype ? { subtype: plan.subtype } : {}),
    metricFilters: plan.metricFilters,
  };
  emit?.({
    type: "reasoning", nodeId, depth: 1, question: plan.question, kind: "leaf",
    rationale: plan.rationale, entities: lookup.entities, subtype: lookup.subtype, metrics: lookup.metricFilters,
  });

  const result = await researchLeaf(plan.question, 1, nodeId, false, ctx, lookup, plan.rationale);
  if (!result.nodeId) {
    ctx.notes.push(`no data found for "${plan.question.slice(0, 80)}" — answering instead`);
    return degrade(req, historyText, ctx.notes, emit);
  }

  // Anchor the new subquery node beside what the user was looking at: the first
  // selected node, else the board's synthesis node, else unanchored.
  const anchor = req.selection?.nodeIds?.[0]
    ?? req.canvasState.nodes.find((n) => n.role === "synthesis")?.id;
  if (anchor) push([derivedEdge(result.nodeId, anchor)]);

  const toBoard = req.surface !== "side_chat";
  const text = `Added **${plan.question}** to the board.\n\n${result.synthesis}`;
  if (toBoard) emit?.({ type: "token", text });
  log("tako", "component lane", { action, question: plan.question, findings: result.findingCount, anchor: anchor ?? null });

  return {
    nodeOps,
    narration: toBoard ? text : "",
    sideReply: toBoard ? null : text,
    validCardIds: new Set(ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      queries: ctx.queries,
      answerUsed: false,
      cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      calls: ctx.calls,
      notes: ctx.notes,
      tree: ctx.tree,
      graph: { resolved: ctx.resolved, related: ctx.related },
      reasoning: ctx.reasoning,
      groundedIn: {
        nodes: [],
        takoAnswerUsed: false,
        cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      },
      timings: { ...ctx.timings, total: 0 } as Timings,
    },
  };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run lib/agents/shared/schemas.test.ts lib/agents/tako/component.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/agents/shared/schemas.ts lib/agents/shared/schemas.test.ts lib/agents/tako/component.ts lib/agents/tako/component.test.ts lib/agents/tako/prompts.ts
git commit -m "feat: research lane — distill request to lookup, mint subquery answer node via researchLeaf, anchor to selection"
```

---

### Task 6: Final lane dispatch in `agent.ts`

Replace the staged follow-up wiring: EXPLAIN → `runAnswerLane`, AUGMENT/GENERATE → `runComponentLane`, REPLACE → `runTakoInitial`. `runTakoFollowup` is no longer imported by agent.ts (it remains the answer lane's internal fallback).

**Files:**
- Modify: `lib/agents/tako/agent.ts`
- Test: `lib/agents/tako/agent.test.ts`

**Interfaces:**
- Consumes: `runAnswerLane` (Task 4), `runComponentLane` (Task 5), `runTakoInitial`.

- [ ] **Step 1: Update the tests**

Replace the mock/dispatch parts of `lib/agents/tako/agent.test.ts` — full new file:

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
vi.mock("./strategy", () => ({ graphStrategy: {} }));

const emptyResult = () => ({
  nodeOps: [], narration: "", sideReply: "ok", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { groundedIn: { nodes: [{ id: "nvda", title: "N" }], takoAnswerUsed: false, cards: [] } },
});
const runAnswerLane = vi.fn(async (..._args: unknown[]) => emptyResult());
vi.mock("./chat", () => ({ runAnswerLane: (...a: any[]) => runAnswerLane(...a) }));
const runComponentLane = vi.fn(async (..._args: unknown[]) => ({ ...emptyResult(), trace: {} }));
vi.mock("./component", () => ({ runComponentLane: (...a: any[]) => runComponentLane(...a) }));
const runTakoInitial = vi.fn(async (..._args: unknown[]) => ({ ...emptyResult(), sideReply: null, trace: {} }));
vi.mock("./pipeline", () => ({ runTakoInitial: (...a: any[]) => runTakoInitial(...a) }));

import { runTako } from "./agent";
import { generateStructured } from "../../llm";
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

describe("runTako lane dispatch", () => {
  it("EXPLAIN dispatches the answer lane with historyText and folds memory", async () => {
    const res = await runTako(req);
    expect(foldHistory).toHaveBeenCalledTimes(1);
    expect(runAnswerLane).toHaveBeenCalledTimes(1);
    expect(runAnswerLane.mock.calls[0][1]).toBe("HIST");
    expect(res.memory).toEqual({ summary: "NEWSUM", summarizedThrough: "m3" });
    expect(res.trace?.groundedIn?.nodes[0].id).toBe("nvda");
    expect(res.trace?.action).toBe("EXPLAIN");
  });

  it("GENERATE dispatches the research lane with its action", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "GENERATE", reason: "chart" } as any);
    await runTako(req);
    expect(runComponentLane).toHaveBeenCalledTimes(1);
    expect(runComponentLane.mock.calls[0][1]).toBe("GENERATE");
    expect(runAnswerLane).not.toHaveBeenCalled();
  });

  it("AUGMENT dispatches the research lane", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "AUGMENT", reason: "more data" } as any);
    await runTako(req);
    expect(runComponentLane.mock.calls[0][1]).toBe("AUGMENT");
  });

  it("REPLACE dispatches the initial pipeline", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "REPLACE", reason: "new topic" } as any);
    await runTako(req);
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
  });

  it("empty board runs the initial pipeline WITHOUT a router call", async () => {
    const res = await runTako({ ...req, canvasState: { nodes: [], edges: [] }, selection: undefined });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
    expect(res.trace?.action).toBe("REPLACE");
  });

  it("router hard-failure defaults to the answer lane", async () => {
    vi.mocked(generateStructured).mockRejectedValueOnce(new Error("llm down"));
    const res = await runTako(req);
    expect(runAnswerLane).toHaveBeenCalledTimes(1);
    expect(res.trace?.action).toBe("EXPLAIN");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: FAIL — agent still imports `./followup` and never calls the lanes.

- [ ] **Step 3: Implement**

In `lib/agents/tako/agent.ts`: replace the `runTakoFollowup` import with the lanes —

```ts
import { runTakoInitial } from "./pipeline";
import { runAnswerLane } from "./chat";
import { runComponentLane } from "./component";
```

and replace the staged dispatch block with:

```ts
  const result =
    action === "REPLACE" ? await runTakoInitial(req, emit, strategy)
    : action === "EXPLAIN" ? await runAnswerLane(req, historyText, emit)
    : await runComponentLane(req, action, historyText, emit, strategy);
```

(Remove the now-stale "Staged wiring" comment; keep everything else — routeTurn, sanitize/finalize tail — unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/tako/agent.ts lib/agents/tako/agent.test.ts
git commit -m "feat: dispatch chat turns to answer/research lanes — agentic tako chat complete"
```

---

### Task 7: Full verification

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npx vitest run`
Expected: ALL PASS (including untouched suites: `followup.test.ts`, `pipeline.test.ts`, `decompose.test.ts`, report component tests). If `followup.test.ts` fails, fix the fallback path — do not weaken the tests.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit any stragglers**

```bash
git status --short
# if clean, done; otherwise:
git add -A && git commit -m "chore: post-verification fixups for agentic chat lanes"
```

---

## Self-Review Notes (already applied)

- **Spec coverage:** §1 router → Task 1+6; §2 gather loop → Tasks 2, 4; §3 research lane → Task 5; §4 click exposure → Tasks 2 (canvas→chat) and 3 (chat→canvas); §5 error handling → embedded in Tasks 1, 4, 5; §6 testing → every task + Task 7.
- The spec's "GroundedChips component" is implemented by extending the **existing** grounded-in chip row inside `TraceView.tsx` (it already renders node/card chips wired to `onSelectNode`) — a separate component would duplicate it.
- `runTakoFollowup` and its tests are intentionally kept: it is the answer lane's hard-failure fallback (spec §5).
- The dead prompt exports `SYNTH_SYSTEM`/`FOLLOWUP_SYSTEM` in `prompts.ts` reference old router actions but are unused (verified by grep); leave them — removing is out of scope.

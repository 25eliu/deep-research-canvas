# Additive Research Trees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the canvas assistant grow a new research tree beside the existing ones when the user asks to research/expand, while keeping plain questions as answer-only turns and never wiping the board except on explicit restart.

**Architecture:** Add a fifth router action `RESEARCH`. Parameterize the research engine's hard-coded root id (`"synth"`) and its prompt context onto `ResearchCtx` so a second tree can run the same pipeline with a unique root id and a scoped board context. A new `expand.ts` lane runs that pipeline additively (no board-clear), anchors the new tree to the selection, and proposes LLM cross-links validated by the existing `relate.ts`.

**Tech Stack:** TypeScript, Next.js 14.2, Vitest, Vercel AI SDK (`generateStructured`/`streamAnswer`), Zod.

## Global Constraints

- **Immutability:** never mutate existing objects; return new copies (spread). `ResearchCtx` accumulators are mutated in place as the existing engine already does — match the surrounding pattern, do not introduce new mutation elsewhere.
- **Never call `tako_agent` / `tako_visualize`.** Grounding is graph + `/v3/search` + `/v1/answer` only.
- **OpenAI provider string is `"openai"`** (`const OPENAI = "openai" as const`).
- **Tests:** TDD — write the failing test first, watch it fail, implement, watch it pass, commit. Run tests with `npx vitest run <path>`.
- **The initial REPLACE pipeline must stay byte-identical.** Existing `lib/agents/tako/pipeline.test.ts` must pass unchanged after every task — root id stays `"synth"` when no override is given.
- Root synthesis id constant: `SYNTH_ID = "synth"` in `lib/agents/tako/flow.ts`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `lib/agents/shared/router.ts` | route action enum + prompt | add `RESEARCH`, rewrite contract |
| `lib/agents/shared/ctx.ts` | prompt context blocks | add `scopedCtxBlock` |
| `lib/agents/tako/flow.ts` | research ctx + node builders | `rootId`/`ctxText` on ctx, `synthNode(id, …)` |
| `lib/agents/tako/research.ts` | recursive engine | `SYNTH_ID`→`ctx.rootId`, `ctxBlock(ctx.req)`→`ctx.ctxText` |
| `lib/agents/tako/gaps.ts` | gap-fill round | same substitutions |
| `lib/agents/tako/compose.ts` | final report | same substitutions |
| `lib/agents/tako/pipeline.ts` | initial pipeline | extract shared `runResearchTree` |
| `lib/agents/tako/expand.ts` (new) | the RESEARCH lane | additive tree + cross-links |
| `lib/agents/tako/prompts.ts` | prompt strings | add `CROSSLINK_SYSTEM` |
| `lib/agents/shared/schemas.ts` | zod schemas | add `zCrossLinks` |
| `lib/agents/tako/agent.ts` | lane dispatch | route `RESEARCH` |
| `app/page.tsx` | camera + narration | focus newest synthesis node |

---

## Task 1: Router — add the RESEARCH action

**Files:**
- Modify: `lib/agents/shared/router.ts`
- Test: `lib/agents/shared/router.test.ts` (create)

**Interfaces:**
- Produces: `zRouteAction` now includes `"RESEARCH"`; `ROUTER` prompt string documents it.

- [ ] **Step 1: Write the failing test**

Create `lib/agents/shared/router.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { zRouteAction, zRoute, ROUTER } from "./router";

describe("router schema", () => {
  it("accepts RESEARCH as a valid action", () => {
    expect(zRouteAction.parse("RESEARCH")).toBe("RESEARCH");
    expect(zRoute.parse({ action: "RESEARCH", reason: "user wants to dig in" }).action).toBe("RESEARCH");
  });

  it("still accepts the four original actions", () => {
    for (const a of ["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN"]) {
      expect(zRouteAction.parse(a)).toBe(a);
    }
  });

  it("documents RESEARCH and restricts REPLACE to explicit restarts in the prompt", () => {
    expect(ROUTER).toContain("RESEARCH");
    expect(ROUTER).toMatch(/start over|restart|scrap/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/shared/router.test.ts`
Expected: FAIL — `zRouteAction.parse("RESEARCH")` throws (invalid enum value).

- [ ] **Step 3: Implement**

Replace the entire contents of `lib/agents/shared/router.ts` with:

```typescript
import { z } from "zod";

export const zRouteAction = z.enum(["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN", "RESEARCH"]);
export const zRoute = z.object({ action: zRouteAction, reason: z.string() });

export const ROUTER = `Route each message to ONE action:
EXPLAIN — the DEFAULT for a question. Answer from what's known plus a grounded Tako answer; the board does NOT change. Use this for any single-part / data / "why did X happen", "how much is Y", "what is Z" question, EVEN about a subject not yet on the board. When in doubt between EXPLAIN and anything else, choose EXPLAIN.
RESEARCH — the user EXPLICITLY wants more research put ON THE CANVAS: verbs like "research", "dig into", "explore", "investigate", "expand on", "build out", "map out", "go deeper on", or a clear ask for a multi-facet investigation of something not already covered. Builds a NEW research tree next to the existing ones; it does NOT clear the board.
AUGMENT — add a single piece of supporting data about something already on the board and connect it ("pull in Intel's numbers too").
GENERATE — the user explicitly asks for ONE new component/chart/card/breakdown ("add a chart of AMD's data-center revenue", "break down X into a card").
REPLACE — ONLY an explicit restart: "start over", "clear the board", "scrap this and look at Y instead". An ambiguous new-topic question is NEVER replace — it is EXPLAIN (a question) or RESEARCH (an explicit research request).
If a selection is present, prefer EXPLAIN about it, or scope AUGMENT/GENERATE/RESEARCH to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.
Use CONVERSATION SO FAR to resolve references ("it", "that", "them", "tell me more") to the entity/nodes already discussed — a reference to prior context is usually EXPLAIN, RESEARCH, or AUGMENT, not REPLACE.
RESEARCH vs EXPLAIN: EXPLAIN answers; RESEARCH puts new nodes on the canvas. Only choose RESEARCH when the user's wording asks to research/expand/explore, not merely to know something.
AUGMENT vs GENERATE: both add to the board; GENERATE is an explicit "make/add/create a component" request, AUGMENT is "bring in more data".`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agents/shared/router.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/router.ts lib/agents/shared/router.test.ts
git commit -m "feat(router): add RESEARCH action and restrict REPLACE to explicit restarts"
```

---

## Task 2: Parameterize the research root id onto ResearchCtx

Today the tree root is the hard-coded `SYNTH_ID = "synth"`. A second tree needs its own root id. Thread it through `ResearchCtx` with `SYNTH_ID` as the default so the initial pipeline is unchanged.

**Files:**
- Modify: `lib/agents/tako/flow.ts` (`synthNode`, `ResearchCtx`, `newResearchCtx`)
- Modify: `lib/agents/tako/research.ts` (root nodeId, grounding call ids, `synthNode()` call)
- Modify: `lib/agents/tako/gaps.ts` (gap `derivedEdge` target)
- Modify: `lib/agents/tako/compose.ts` (contents call ids)
- Modify: `lib/agents/tako/pipeline.ts` (synthesis events, tree patch, final update)
- Test: `lib/agents/tako/flow.test.ts` (create)

**Interfaces:**
- Consumes: `SYNTH_ID` from Task 0 baseline.
- Produces:
  - `synthNode(id: string, headline: string, summary: string): CanvasNode`
  - `ResearchCtx` gains `rootId: string`
  - `newResearchCtx(req, ledger, push, emit?, strategy?, opts?: { rootId?: string }): ResearchCtx`

- [ ] **Step 1: Write the failing test**

Create `lib/agents/tako/flow.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { FindingLedger } from "./findings";
import { newResearchCtx, synthNode, SYNTH_ID } from "./flow";

const req: any = {
  canvasId: "c", message: "research the chip makers", surface: "main",
  canvasState: { nodes: [], edges: [] }, providerId: "tako", takoAnswerEnabled: true, history: [],
};

describe("research root-id parameterization", () => {
  it("synthNode uses the id it is given", () => {
    expect(synthNode(SYNTH_ID, "H", "S").id).toBe("synth");
    expect(synthNode("synth_chips", "H", "S").id).toBe("synth_chips");
    expect(synthNode("synth_chips", "H", "S").role).toBe("synthesis");
  });

  it("newResearchCtx defaults rootId to SYNTH_ID and seeds usedIds with it", () => {
    const ctx = newResearchCtx(req, new FindingLedger(), () => {});
    expect(ctx.rootId).toBe("synth");
    expect(ctx.usedIds.has("synth")).toBe(true);
  });

  it("newResearchCtx honors an override rootId", () => {
    const ctx = newResearchCtx(req, new FindingLedger(), () => {}, undefined, undefined, { rootId: "synth_chips" });
    expect(ctx.rootId).toBe("synth_chips");
    expect(ctx.usedIds.has("synth_chips")).toBe(true);
    expect(ctx.usedIds.has("synth")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/flow.test.ts`
Expected: FAIL — `synthNode` takes 2 args / `ctx.rootId` undefined.

- [ ] **Step 3: Implement — `flow.ts`**

In `lib/agents/tako/flow.ts`:

Change `synthNode` (was `synthNode(headline, summary)`):

```typescript
export function synthNode(id: string, headline: string, summary: string): CanvasNode {
  return { id, type: "text", role: "synthesis", title: headline || "Synthesis", summary, grounding: "tako", confidence: 0.9 };
}
```

Add `rootId` to the `ResearchCtx` interface (right after `strategy: QueryStrategy;`):

```typescript
  rootId: string; // the synthesis (root) node id for THIS tree — SYNTH_ID for the initial run, a unique id for additive trees
```

Change `newResearchCtx` signature and body:

```typescript
export function newResearchCtx(
  req: AgentRequest, ledger: FindingLedger, push: ResearchCtx["push"],
  emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
  opts?: { rootId?: string },
): ResearchCtx {
  const rootId = opts?.rootId ?? SYNTH_ID;
  return {
    req, ledger, push, emit, strategy, rootId,
    budget: { researchNodes: 0, maxNodes: TOTAL_RESEARCH_CAP },
    usedIds: new Set([rootId]),
    notes: [], tree: [], resolved: [], related: [], queries: [],
    webSources: [], seenSourceUrls: new Set(), sourcesByNode: new Map(),
    contents: { fetched: 0, cap: CONTENTS_CAP, cache: new Map() },
    figures: [], branchResults: [], answerGrounded: false,
    calls: [], reasoning: [],
    timings: { graph: 0, search: 0, decompose: 0, stream: 0 },
  };
}
```

- [ ] **Step 4: Implement — `flow.ts` atomic-root synth node**

`researchLeaf` creates the synth node itself for an ATOMIC root question (`flow.ts` ~line 269 — inside `if (root) { … }`). Update that call to the new signature:

```typescript
    ctx.push([{ op: "add_node", node: synthNode(ctx.rootId, "", "") }]);
```

(This is a SECOND `synthNode` call site besides the branch path in `research.ts` — both must change or an atomic-root expand tree mints a node with id `"synth"` and collides.)

- [ ] **Step 5: Implement — `research.ts`**

In `lib/agents/tako/research.ts`:

Line ~226, root nodeId:
```typescript
  const nodeId = root ? ctx.rootId : uniqueResearchId(ctx, question);
```

Line ~119, grounding call id (inside `groundWithAnswer`):
```typescript
      callId: `${ctx.rootId}:answer:${ctx.calls.length}`, nodeId: ctx.rootId,
```

Line ~452, the root synth node creation (branch path):
```typescript
    ctx.push([{ op: "add_node", node: synthNode(ctx.rootId, "", "") }]);
```

(The `synthNode` import already exists; leave `SYNTH_ID` imported — still used as the default constant elsewhere. If eslint flags it unused after edits, keep the re-export on line 24 but you may drop it from the value import on line 18 only if truly unused.)

- [ ] **Step 6: Implement — `gaps.ts`**

In `lib/agents/tako/gaps.ts`, line ~80:
```typescript
    ctx.push([derivedEdge(r.nodeId, ctx.rootId)]); // gap answer feeds the synthesis
```
`SYNTH_ID` is no longer referenced here — remove it from the import on line 9:
```typescript
import { derivedEdge, researchLeaf, uniqueResearchId, type ResearchCtx } from "./flow";
```

- [ ] **Step 7: Implement — `compose.ts`**

In `lib/agents/tako/compose.ts`, line ~223 (contents call record):
```typescript
              callId: `${ctx.rootId}:contents:${ctx.calls.length}`, nodeId: ctx.rootId,
```
Remove `SYNTH_ID` from the import on line 20:
```typescript
import { fetchContents, excerptCsv, type ResearchCtx, type GatheredFigure } from "./flow";
```

- [ ] **Step 8: Implement — `pipeline.ts`**

In `lib/agents/tako/pipeline.ts`, replace every `SYNTH_ID` with `ctx.rootId`:
- line ~58/63: `emit?.({ type: "synthesis", phase: "start", nodeId: ctx.rootId, kind: "root" });` and the matching `"end"`.
- line ~72: `if (n.nodeId !== ctx.rootId) return n;`
- line ~75: `(c) => c.nodeId === ctx.rootId && c.endpoint === "/v1/contents" && !seen.has(c.callId),`
- line ~87 & ~101: `push([{ op: "update_node", id: ctx.rootId, patch: { … } }]);`

Update the import on line 4 (drop `SYNTH_ID`):
```typescript
import { research, newResearchCtx, toNodeSources } from "./research";
```

- [ ] **Step 9: Run the whole tako suite to verify no regressions**

Run: `npx vitest run lib/agents/tako/flow.test.ts lib/agents/tako/pipeline.test.ts lib/agents/tako/decompose.test.ts lib/agents/tako/gaps.test.ts lib/agents/tako/compose.test.ts lib/agents/tako/compose.report.test.ts`
Expected: PASS — new flow tests pass AND all existing tests pass unchanged (root id still `"synth"` on the initial run).

- [ ] **Step 10: Commit**

```bash
git add lib/agents/tako/flow.ts lib/agents/tako/flow.test.ts lib/agents/tako/research.ts lib/agents/tako/gaps.ts lib/agents/tako/compose.ts lib/agents/tako/pipeline.ts
git commit -m "refactor(tako): parameterize research root id onto ResearchCtx (default SYNTH_ID)"
```

---

## Task 3: Scoped context block + `ctxText` on the ctx

The RESEARCH lane's planner must see the selected tree (front-facing) or all nodes (titles/summaries only), never the full data dump. Add `scopedCtxBlock`, and thread the chosen text onto `ResearchCtx.ctxText` so `research.ts`/`compose.ts`/`gaps.ts` read it instead of rebuilding `ctxBlock(ctx.req)`.

**Files:**
- Modify: `lib/agents/shared/ctx.ts` (add `scopedCtxBlock`)
- Modify: `lib/agents/tako/flow.ts` (`ctxText` on ctx)
- Modify: `lib/agents/tako/research.ts`, `compose.ts`, `gaps.ts` (`ctxBlock(ctx.req)` → `ctx.ctxText`)
- Test: `lib/agents/shared/ctx.test.ts` (extend)

**Interfaces:**
- Consumes: `getAncestors`, `getDescendants` from `lib/lineage.ts`; `nodeContentBlock`, `retrieveNodes` from `./retrieval`.
- Produces:
  - `scopedCtxBlock(req: AgentRequest, historyText?: string): string`
  - `ResearchCtx` gains `ctxText: string`
  - `newResearchCtx` `opts` gains `ctxText?: string` (defaults to `ctxBlock(req)`).

- [ ] **Step 1: Write the failing test**

Append to `lib/agents/shared/ctx.test.ts`:

```typescript
import { scopedCtxBlock } from "./ctx";

const treeState = {
  nodes: [
    { id: "synth", type: "text", role: "synthesis", title: "Chip leaders", summary: "Nvidia leads.", grounding: "tako", confidence: 0.9 },
    { id: "rq_nvda", type: "text", role: "research", title: "Nvidia revenue", summary: "Up 200%.", grounding: "tako", confidence: 0.85,
      chartSpec: { kind: "line", series: [{ label: "rev", points: [{ x: "2024", y: 60 }] }] } },
    { id: "rq_amd", type: "text", role: "research", title: "AMD revenue", summary: "Up 20%.", grounding: "tako", confidence: 0.85 },
    { id: "other", type: "text", role: "synthesis", title: "Unrelated EVs", summary: "Tesla stuff.", grounding: "tako", confidence: 0.9 },
  ],
  edges: [
    { id: "e1", from: "rq_nvda", to: "synth", kind: "derived_from" },
    { id: "e2", from: "rq_amd", to: "synth", kind: "derived_from" },
  ],
} as any;

const baseReq = (over: any) => ({
  canvasId: "c", message: "dig into margins", surface: "main",
  canvasState: treeState, providerId: "tako", takoAnswerEnabled: true, history: [], ...over,
});

describe("scopedCtxBlock", () => {
  it("with a selection, includes the selected node's whole tree but not unrelated trees", () => {
    const out = scopedCtxBlock(baseReq({ selection: { nodeIds: ["rq_nvda"], nodes: [] } }));
    expect(out).toContain("Nvidia revenue");
    expect(out).toContain("AMD revenue");   // sibling in the same tree
    expect(out).toContain("Chip leaders");  // the tree root (ancestor)
    expect(out).not.toContain("Unrelated EVs"); // a different tree
  });

  it("with no selection, lists all nodes' front-facing info but no chart data", () => {
    const out = scopedCtxBlock(baseReq({ selection: undefined }));
    expect(out).toContain("Nvidia revenue");
    expect(out).toContain("Unrelated EVs");
    expect(out).not.toContain("chart(");   // no raw chart points
    expect(out).not.toContain("2024:60");  // no data points
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/shared/ctx.test.ts`
Expected: FAIL — `scopedCtxBlock` is not exported.

- [ ] **Step 3: Implement — `ctx.ts`**

Append to `lib/agents/shared/ctx.ts`:

```typescript
import type { CanvasNode } from "../../schema";
import { getAncestors, getDescendants } from "../../lineage";

// Front-facing one-liner: id, type/role, title, section, summary — NO chart points,
// CSV, consensus rows, or report bodies. The light map the RESEARCH planner reasons over.
function frontFacing(n: CanvasNode): string {
  const head = `[#${n.id} · ${n.type}${n.role ? `/${n.role}` : ""}] ${n.title}`;
  const bits = [head];
  if (n.section) bits.push(`section: ${n.section}`);
  if (n.summary) bits.push(n.summary);
  return bits.join("\n");
}

// Context for the RESEARCH (additive-tree) planner.
// - Selection present: the selected node's WHOLE tree (selection ∪ ancestors ∪
//   descendants) as front-facing lines, plus FULL content for the selected nodes.
// - No selection: front-facing lines for EVERY content node (titles/summaries only).
export function scopedCtxBlock(req: AgentRequest, historyText?: string): string {
  const nodes = req.canvasState.nodes ?? [];
  const edges = req.canvasState.edges ?? [];
  const ids = req.selection?.nodeIds ?? [];
  const parts = [
    `MESSAGE: ${req.message}`,
    `SURFACE: ${req.surface}`,
    `SELECTION: ${JSON.stringify(ids)}`,
  ];
  if (historyText) parts.push(`\nCONVERSATION SO FAR:\n${historyText}`);

  if (ids.length) {
    const scope = new Set<string>(ids);
    for (const id of ids) {
      for (const a of getAncestors(id, edges)) scope.add(a);
      for (const d of getDescendants(id, edges)) scope.add(d);
    }
    const treeNodes = nodes.filter((n) => scope.has(n.id));
    const selected = nodes.filter((n) => ids.includes(n.id));
    parts.push(`\nSELECTED TREE (front-facing):\n${treeNodes.map(frontFacing).join("\n\n") || "(none)"}`);
    parts.push(`\nSELECTED NODES (full content):\n${nodeContentBlock(selected)}`);
  } else {
    const content = nodes.filter((n) => n.type !== "entity_section" && n.role !== "header");
    parts.push(`\nBOARD NODES (front-facing):\n${content.map(frontFacing).join("\n\n") || "(none)"}`);
  }

  parts.push(`\nCURRENT_EDGES: ${JSON.stringify(edges)}`);
  return parts.join("\n");
}
```

(The top of `ctx.ts` already imports `retrieveNodes, nodeContentBlock` and `AgentRequest`. Add the two new imports; if `CanvasNode` is already imported, don't duplicate it.)

- [ ] **Step 4: Run the scoped test to verify it passes**

Run: `npx vitest run lib/agents/shared/ctx.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `ctxText` to the ctx — `flow.ts`**

In `lib/agents/tako/flow.ts`, add to the `ResearchCtx` interface (right after `rootId`):

```typescript
  ctxText: string; // the prompt context block for THIS turn's planners (full board for the initial run, scoped for additive trees)
```

Import `ctxBlock` at the top of `flow.ts` (it currently imports from `../shared/ctx`):
```typescript
import { ctxBlock } from "../shared/ctx";
```
(already imported — confirm; if not, add it.)

Extend `newResearchCtx` opts and body:

```typescript
  opts?: { rootId?: string; ctxText?: string },
): ResearchCtx {
  const rootId = opts?.rootId ?? SYNTH_ID;
  return {
    req, ledger, push, emit, strategy, rootId,
    ctxText: opts?.ctxText ?? ctxBlock(req),
    …unchanged…
```

- [ ] **Step 6: Swap the call sites — `flow.ts`, `research.ts`, `compose.ts`, `gaps.ts`**

Replace `ctxBlock(ctx.req)` with `ctx.ctxText` at these prompt-building sites:
- `flow.ts` ~290 (leaf-synth prompt in `researchLeaf`), ~323 (web-filter prompt in `filterWebSources`).
- `research.ts` ~151 (cohort resolve prompt), ~279 (`basePrompt`), ~482 (branch synth prompt).
- `compose.ts` ~201 (gather prompt), ~290 (report prompt).
- `gaps.ts` ~38 (gap-analysis prompt).

Find them all with: `grep -rn "ctxBlock(ctx.req)" lib/agents/tako/` — swap every hit to `ctx.ctxText`.

**Imports:** `flow.ts` KEEPS its `ctxBlock` import (Step 5 uses it as the `newResearchCtx` default). `research.ts`, `compose.ts`, and `gaps.ts` no longer reference `ctxBlock` — remove `import { ctxBlock } from "../shared/ctx";` from each, but grep each file first (`grep -n ctxBlock <file>`) and only remove the import if zero references remain.

- [ ] **Step 7: Run the tako suite to verify no regressions**

Run: `npx vitest run lib/agents/tako/pipeline.test.ts lib/agents/tako/decompose.test.ts lib/agents/tako/gaps.test.ts lib/agents/tako/compose.test.ts lib/agents/tako/compose.report.test.ts lib/agents/shared/ctx.test.ts`
Expected: PASS — the initial run still builds its prompts from the full `ctxBlock(req)` (the default), so existing assertions hold.

- [ ] **Step 8: Commit**

```bash
git add lib/agents/shared/ctx.ts lib/agents/shared/ctx.test.ts lib/agents/tako/flow.ts lib/agents/tako/research.ts lib/agents/tako/compose.ts lib/agents/tako/gaps.ts
git commit -m "feat(tako): scopedCtxBlock + ctxText on ResearchCtx for additive-tree planning"
```

---

## Task 4: Extract the shared `runResearchTree` from `runTakoInitial`

`runTakoExpand` reuses the whole research→gap→compose→patch→trace body. Extract it so the additive lane is not a copy. `runTakoInitial` becomes a thin wrapper.

**Files:**
- Modify: `lib/agents/tako/pipeline.ts`
- Test: `lib/agents/tako/pipeline.test.ts` (must pass UNCHANGED)

**Interfaces:**
- Produces: `runResearchTree(req: AgentRequest, ctx: ResearchCtx, emit?: EmitFn): Promise<PipelineResult>` — runs the tree on an ALREADY-BUILT ctx (caller owns ctx creation, rootId, ctxText, and the `push` that records+streams ops). Returns the same `PipelineResult` shape `runTakoInitial` returns today.

- [ ] **Step 1: Refactor — split `runTakoInitial`**

Rewrite `lib/agents/tako/pipeline.ts`'s body so the current logic lives in `runResearchTree`, and `runTakoInitial` builds the ctx + `push` and calls it. Concretely:

```typescript
import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings } from "../shared/types";
import { FindingLedger } from "./findings";
import { research, newResearchCtx, toNodeSources } from "./research";
import type { ResearchCtx } from "./flow";
import { composeReport } from "./compose";
import { runGapRound } from "./gaps";
import { log } from "../../log";
import { graphStrategy, type QueryStrategy } from "./strategy";

// titleFrom unchanged — keep the existing implementation.

// Build the standard record-and-stream push + tracking sets for a research ctx.
export function trackingPush(emit?: EmitFn): {
  push: (ops: CanvasOp[]) => void; nodeOps: CanvasOp[]; allowedNodeIds: Set<string>;
} {
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const push = (ops: CanvasOp[]) => {
    for (const op of ops) {
      nodeOps.push(op);
      if (op.op === "add_node" || op.op === "upsert_node") allowedNodeIds.add(op.node.id);
    }
    if (ops.length) emit?.({ type: "ops", ops });
  };
  return { push, nodeOps, allowedNodeIds };
}

// Run a full research tree on an already-built ctx (rootId + ctxText owned by the caller):
// recursive research → one gap round → composed report → synth patch. Returns the
// authoritative PipelineResult. Additive lanes reuse this verbatim.
export async function runResearchTree(
  req: AgentRequest, ctx: ResearchCtx, nodeOps: CanvasOp[], allowedNodeIds: Set<string>, emit?: EmitFn,
): Promise<PipelineResult> {
  const push = ctx.push;
  const runStart = Date.now();
  const rootResult = await research(req.message, 0, ctx, { root: true });

  let narration = "";
  if (!rootResult.nodeId) {
    narration = "I couldn't find structured data for this question in Tako.";
    emit?.({ type: "token", text: narration });
  } else {
    await runGapRound(ctx, req.message);
    emit?.({ type: "trace", stage: "composing report" });
    emit?.({ type: "synthesis", phase: "start", nodeId: ctx.rootId, kind: "root" });
    const t = Date.now();
    const report = await composeReport(ctx, req.message);
    const composeMs = Date.now() - t;
    ctx.timings.stream = Math.max(ctx.timings.stream, composeMs);
    emit?.({ type: "synthesis", phase: "end", nodeId: ctx.rootId, kind: "root" });
    ctx.tree = ctx.tree.map((n) => {
      if (n.nodeId !== ctx.rootId) return n;
      const seen = new Set((n.calls ?? []).map((c) => c.callId));
      const synthContents = ctx.calls.filter(
        (c) => c.nodeId === ctx.rootId && c.endpoint === "/v1/contents" && !seen.has(c.callId),
      );
      return {
        ...n,
        ...(synthContents.length ? { calls: [...(n.calls ?? []), ...synthContents] } : {}),
        totalMs: Date.now() - runStart, composeMs,
      };
    });
    const rootSources = toNodeSources(ctx.webSources);
    if (report) {
      push([{ op: "update_node", id: ctx.rootId, patch: {
        title: titleFrom(report.verdict), summary: report.verdict, report,
        ...(rootSources.length ? { sources: rootSources } : {}),
      } }]);
    } else {
      const claims = ctx.branchResults.map((b) => b.claim).filter((c) => c.length > 0);
      const title = titleFrom(claims[0] || req.message);
      const summary = claims.length
        ? `The final report could not be composed — here is what the research found:\n${claims.map((c) => `- ${c}`).join("\n")}`
        : "The final report could not be composed.";
      push([{ op: "update_node", id: ctx.rootId, patch: {
        title, summary,
        ...(rootSources.length ? { sources: rootSources } : {}),
      } }]);
    }
  }

  log("tako", "research run", { findings: ctx.ledger.size, treeNodes: ctx.tree.length, ...ctx.timings });

  return {
    nodeOps, narration, sideReply: null,
    validCardIds: new Set(ctx.ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      graph: { resolved: ctx.resolved, related: ctx.related },
      answerUsed: ctx.answerGrounded,
      queries: ctx.queries,
      cards: ctx.ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      notes: ctx.notes,
      tree: ctx.tree,
      calls: ctx.calls,
      reasoning: ctx.reasoning,
      timings: { ...ctx.timings, total: 0 } as Timings,
    },
  };
}

export async function runTakoInitial(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const ledger = new FindingLedger();
  const { push, nodeOps, allowedNodeIds } = trackingPush(emit);
  const ctx = newResearchCtx(req, ledger, push, emit, strategy);
  return runResearchTree(req, ctx, nodeOps, allowedNodeIds, emit);
}
```

Note: `newResearchCtx` here still receives `ledger` and `push` as before, so `ctx.push === push` and `ctx.ledger === ledger`.

- [ ] **Step 2: Run the initial-pipeline test to verify it still passes UNCHANGED**

Run: `npx vitest run lib/agents/tako/pipeline.test.ts`
Expected: PASS — no test edits; `runTakoInitial` behaves identically.

- [ ] **Step 3: Commit**

```bash
git add lib/agents/tako/pipeline.ts
git commit -m "refactor(tako): extract runResearchTree so additive trees reuse the initial pipeline"
```

---

## Task 5: The RESEARCH lane — `runTakoExpand`

Additive tree: unique root id, existing ids reserved, scoped context, no board-clear, degrade on empty. Cross-links come in Task 6.

**Files:**
- Create: `lib/agents/tako/expand.ts`
- Test: `lib/agents/tako/expand.test.ts` (create)

**Interfaces:**
- Consumes: `runResearchTree`, `trackingPush` (Task 4); `newResearchCtx` (Task 2/3); `scopedCtxBlock` (Task 3); `runAnswerLane` from `./chat`; `derivedEdge`, `SYNTH_ID` from `./flow`; `getAncestors` from `../../lineage`.
- Produces: `runTakoExpand(req: AgentRequest, historyText: string, emit?: EmitFn, strategy?: QueryStrategy): Promise<PipelineResult>`.

- [ ] **Step 1: Write the failing test**

Create `lib/agents/tako/expand.test.ts`, reusing the `pipeline.test.ts` mock style (copy the `vi.hoisted` block + the three `vi.mock` blocks for `../../llm`, `./graph`, `../../tako` verbatim from `pipeline.test.ts` so the research engine is fully mocked). Then:

```typescript
import { runTakoExpand } from "./expand";

// A board that already has a research tree rooted at "synth".
const boardState = {
  nodes: [
    { id: "synth", type: "text", role: "synthesis", title: "Chip leaders", summary: "Nvidia leads.", grounding: "tako", confidence: 0.9 },
    { id: "rq_nvda", type: "text", role: "research", title: "Nvidia revenue", summary: "Up.", grounding: "tako", confidence: 0.85 },
  ],
  edges: [{ id: "e1", from: "rq_nvda", to: "synth", kind: "derived_from" }],
} as any;

const expandReq = (over: any = {}) => ({
  canvasId: "c", message: "research AMD's margins", surface: "main" as const,
  canvasState: boardState, providerId: "tako" as const, takoAnswerEnabled: true, history: [], ...over,
});

beforeEach(() => {
  h.plans = {}; h.report = { verdict: "**AMD margins rising.**", blocks: [{ kind: "prose", md: "x" }] };
  h.gapPlan = { sufficient: true, rationale: "ok", gaps: [] };
});

describe("runTakoExpand", () => {
  it("mints a NEW synthesis root (not 'synth') and never removes existing nodes", async () => {
    const res = await runTakoExpand(expandReq(), "HIST");
    const added = res.nodeOps.filter((o: any) => o.op === "add_node");
    const roots = added.filter((o: any) => o.node.role === "synthesis").map((o: any) => o.node.id);
    expect(roots.length).toBe(1);
    expect(roots[0]).not.toBe("synth");
    expect(res.nodeOps.some((o: any) => o.op === "remove_node")).toBe(false);
  });

  it("does not collide with existing board node ids", async () => {
    const res = await runTakoExpand(expandReq(), "HIST");
    const newIds = res.nodeOps.filter((o: any) => o.op === "add_node").map((o: any) => o.node.id);
    expect(newIds).not.toContain("rq_nvda");
    expect(newIds).not.toContain("synth");
  });

  it("anchors the new tree to the selected node's tree root with a derived_from edge", async () => {
    const res = await runTakoExpand(expandReq({ selection: { nodeIds: ["rq_nvda"], nodes: [] } }), "HIST");
    const newRoot = res.nodeOps.find((o: any) => o.op === "add_node" && o.node.role === "synthesis")!.node.id;
    const anchor = res.nodeOps.find(
      (o: any) => o.op === "add_edge" && o.edge.kind === "derived_from" && o.edge.from === newRoot,
    );
    expect(anchor?.edge.to).toBe("synth"); // rq_nvda's tree root
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/expand.test.ts`
Expected: FAIL — `./expand` has no `runTakoExpand`.

- [ ] **Step 3: Implement — `expand.ts`**

Create `lib/agents/tako/expand.ts`:

```typescript
// The RESEARCH lane: grow a NEW research tree beside the existing board. Mirrors the
// initial pipeline (research → gap round → composed report) via runResearchTree, but
// additively — a unique synth root, existing ids reserved, scoped planning context,
// no board-clear, an anchor edge to the selection's tree. Empty evidence degrades to
// the answer lane so a turn never dies.
import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult } from "../shared/types";
import { FindingLedger } from "./findings";
import { newResearchCtx } from "./research";
import { derivedEdge, uniqueResearchId, type ResearchCtx } from "./flow";
import { runResearchTree, trackingPush } from "./pipeline";
import { scopedCtxBlock } from "../shared/ctx";
import { getAncestors } from "../../lineage";
import { runAnswerLane } from "./chat";
import { graphStrategy, type QueryStrategy } from "./strategy";
import { log } from "../../log";

// A unique synthesis root id for the new tree, reserved against existing board ids.
function newRootId(req: AgentRequest, existing: Set<string>): string {
  const base = `synth_${req.message.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32)}` || "synth_x";
  let id = base, i = 2;
  while (existing.has(id)) id = `${base}_${i++}`;
  return id;
}

// The root of the selected node's tree (topmost ancestor), else the node itself.
function selectionTreeRoot(req: AgentRequest): string | undefined {
  const first = req.selection?.nodeIds?.[0];
  if (!first) return undefined;
  const ancestors = getAncestors(first, req.canvasState.edges ?? []);
  const roots = req.canvasState.nodes.filter(
    (n) => ancestors.has(n.id) && (n.role === "synthesis" || n.role === "consensus"),
  );
  return roots[0]?.id ?? first;
}

export async function runTakoExpand(
  req: AgentRequest, historyText: string, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const existing = new Set(req.canvasState.nodes.map((n) => n.id));
  const rootId = newRootId(req, existing);
  const ctxText = scopedCtxBlock(req, historyText);

  const ledger = new FindingLedger();
  const { push, nodeOps, allowedNodeIds } = trackingPush(emit);
  const ctx: ResearchCtx = newResearchCtx(req, ledger, push, emit, strategy, { rootId, ctxText });
  // Existing board ids can never be reused by the new tree's research nodes.
  for (const id of existing) ctx.usedIds.add(id);

  const result = await runResearchTree(req, ctx, nodeOps, allowedNodeIds, emit);

  // No structured data anywhere → degrade to the answer lane (never a dead turn),
  // carrying this lane's notes for the trace.
  const mintedRoot = nodeOps.some((o) => (o.op === "add_node" || o.op === "upsert_node") && o.node.id === rootId);
  if (!mintedRoot) {
    log("tako", "expand degraded — no tree minted", { message: req.message.slice(0, 60) });
    const fallback = await runAnswerLane(req, historyText, emit);
    return { ...fallback, trace: { ...fallback.trace, notes: [`research found no data — answered instead`, ...(fallback.trace.notes ?? [])] } };
  }

  // Anchor the new tree beside what the user was looking at: the selected node's tree root.
  const anchor = selectionTreeRoot(req);
  if (anchor && anchor !== rootId && existing.has(anchor)) {
    const edge: CanvasOp = derivedEdge(rootId, anchor);
    push([edge]);
  }

  log("tako", "expand lane", { rootId, findings: ledger.size, anchor: anchor ?? null });
  return result;
}
```

Note: `uniqueResearchId` is imported for parity but `newRootId` is bespoke (it must reserve against `existing` before the ctx exists) — if the import is unused, drop it. `research.ts` already re-exports `newResearchCtx`; import from `./research` to match `pipeline.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/agents/tako/expand.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/tako/expand.ts lib/agents/tako/expand.test.ts
git commit -m "feat(tako): runTakoExpand — additive research tree lane"
```

---

## Task 6: LLM cross-links between the new tree and existing nodes

After the tree composes, propose 0–3 semantic edges from the new tree to directly-related existing nodes.

**Files:**
- Modify: `lib/agents/shared/schemas.ts` (add `zCrossLinks`)
- Modify: `lib/agents/tako/prompts.ts` (add `CROSSLINK_SYSTEM`)
- Modify: `lib/agents/tako/expand.ts` (call it, emit validated edges)
- Test: `lib/agents/tako/expand.test.ts` (extend)

**Interfaces:**
- Consumes: `generateStructured` from `../../llm`.
- Produces: `zCrossLinks` = `{ links: { from: string; to: string; kind: "supports" | "contradicts"; reason: string }[] }`; `CROSSLINK_SYSTEM` string.

- [ ] **Step 1: Write the failing test**

Extend the `../../llm` mock's `generateStructured` in `expand.test.ts` to answer the new label. In the hoisted block add `crossLinks: { links: [] } as any`, and in the `generateStructured` mock add before the final `return {}`:

```typescript
    if (opts.label === "crosslink") {
      if (h.crossLinks instanceof Error) throw h.crossLinks;
      return h.crossLinks;
    }
```

Then add tests:

```typescript
describe("runTakoExpand cross-links", () => {
  it("emits a validated supports edge the LLM proposes to an existing node", async () => {
    h.crossLinks = { links: [{ from: "SELF_ROOT", to: "rq_nvda", kind: "supports", reason: "same sector" }] };
    // The lane rewrites the sentinel SELF_ROOT to the real new root id before validating.
    const res = await runTakoExpand(expandReq(), "HIST");
    const newRoot = res.nodeOps.find((o: any) => o.op === "add_node" && o.node.role === "synthesis")!.node.id;
    const link = res.nodeOps.find((o: any) => o.op === "add_edge" && o.edge.kind === "supports");
    expect(link?.edge.from).toBe(newRoot);
    expect(link?.edge.to).toBe("rq_nvda");
  });

  it("drops a proposed edge whose target is not a real board node", async () => {
    h.crossLinks = { links: [{ from: "SELF_ROOT", to: "ghost_node", kind: "supports", reason: "nope" }] };
    const res = await runTakoExpand(expandReq(), "HIST");
    expect(res.nodeOps.some((o: any) => o.op === "add_edge" && o.edge.to === "ghost_node")).toBe(false);
  });

  it("survives a cross-link LLM failure without dropping the tree", async () => {
    h.crossLinks = new Error("crosslink boom");
    const res = await runTakoExpand(expandReq(), "HIST");
    expect(res.nodeOps.some((o: any) => o.op === "add_node" && o.node.role === "synthesis")).toBe(true);
  });
});
```

Add `h.crossLinks = { links: [] }` reset to the `beforeEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/expand.test.ts`
Expected: FAIL — no crosslink handling; sentinel not rewritten, ghost edge present, etc.

- [ ] **Step 3: Implement — `schemas.ts`**

Add to `lib/agents/shared/schemas.ts`:

```typescript
export const zCrossLinks = z.object({
  links: z.array(z.object({
    from: z.string(),
    to: z.string(),
    kind: z.enum(["supports", "contradicts"]),
    reason: z.string(),
  })).max(3),
});
export type CrossLinks = z.infer<typeof zCrossLinks>;
```

- [ ] **Step 4: Implement — `prompts.ts`**

Add to `lib/agents/tako/prompts.ts`:

```typescript
export const CROSSLINK_SYSTEM = `You connect a NEW research finding to EXISTING nodes on a research canvas — ONLY where there is a genuine, direct relationship.
You are given NEW_TREE (a verdict + the sub-question titles just added) and EXISTING_NODES (id + title + summary of what is already on the board, possibly from unrelated investigations).
Return { links: [...] } with 0 to 3 links. Each link: { from: "SELF_ROOT", to: "<an EXISTING_NODES id>", kind: "supports" | "contradicts", reason: "<short why>" }.
- "from" is ALWAYS the literal string "SELF_ROOT" (the new tree's root).
- Use "supports" when the new finding reinforces/extends the existing node; "contradicts" when it points the other way.
- Link ONLY on a real topical/causal relationship (same entity, same metric, directly bearing evidence). If nothing is genuinely related, return { links: [] }. Do NOT invent links to seem thorough.
- Never link to a node that is not in EXISTING_NODES. Never use any "to" id you were not given.`;
```

- [ ] **Step 5: Implement — `expand.ts` cross-link step**

In `lib/agents/tako/expand.ts`, add imports:

```typescript
import { generateStructured } from "../../llm";
import { supportsEdge } from "./flow";
import { zCrossLinks } from "../shared/schemas";
import { CROSSLINK_SYSTEM } from "./prompts";
```

Add this helper:

```typescript
const OPENAI = "openai" as const;

// One cheap structured call: propose 0-3 semantic edges from the new tree's root to
// directly-related existing nodes. The model returns the sentinel "SELF_ROOT" as the
// source; we rewrite it to the real root and drop any edge whose target isn't a real
// existing node. finalizeOps/validateGraph downstream drop dupes + cycles. Never fatal.
async function proposeCrossLinks(
  req: AgentRequest, rootId: string, existing: Set<string>, ctx: ResearchCtx, push: (ops: CanvasOp[]) => void,
): Promise<void> {
  const newLeaves = ctx.tree.filter((n) => n.nodeId !== rootId).map((n) => n.question);
  const rootNode = req.canvasState.nodes; // not used; existing nodes come from req
  const existingNodes = req.canvasState.nodes
    .filter((n) => n.type !== "entity_section" && n.role !== "header")
    .map((n) => ({ id: n.id, title: n.title, summary: n.summary ?? "" }));
  if (existingNodes.length === 0) return;
  try {
    const out = await generateStructured({
      provider: OPENAI, system: CROSSLINK_SYSTEM,
      prompt: `NEW_TREE: ${JSON.stringify({ verdict: req.message, subQuestions: newLeaves })}\n\nEXISTING_NODES: ${JSON.stringify(existingNodes)}`,
      schema: zCrossLinks, label: "crosslink",
    });
    const ops: CanvasOp[] = [];
    for (const link of out.links) {
      if (!existing.has(link.to) || link.to === rootId) continue; // must target a real, different node
      ops.push(link.kind === "contradicts"
        ? { op: "add_edge", edge: { id: `contradicts:${rootId}->${link.to}`, from: rootId, to: link.to, kind: "contradicts" } }
        : supportsEdge(rootId, link.to));
    }
    if (ops.length) { ctx.notes.push(`cross-linked to ${ops.length} existing node(s)`); push(ops); }
  } catch (e: unknown) {
    ctx.notes.push(`cross-link step failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}
```

(Delete the unused `rootNode` line — it's shown only to clarify existingNodes comes from `req`; do not keep it.)

Call it in `runTakoExpand` after the anchor edge, before the final `log`/`return`:

```typescript
  await proposeCrossLinks(req, rootId, existing, ctx, push);
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/expand.test.ts lib/agents/shared/schemas.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/agents/shared/schemas.ts lib/agents/tako/prompts.ts lib/agents/tako/expand.ts lib/agents/tako/expand.test.ts
git commit -m "feat(tako): LLM cross-links from new research trees to related existing nodes"
```

---

## Task 7: Dispatch RESEARCH from the agent

**Files:**
- Modify: `lib/agents/tako/agent.ts`
- Test: `lib/agents/tako/agent.test.ts` (extend)

**Interfaces:**
- Consumes: `runTakoExpand` (Task 5).

- [ ] **Step 1: Write the failing test**

In `lib/agents/tako/agent.test.ts`, add a mock for the expand lane near the other lane mocks:

```typescript
const runTakoExpand = vi.fn(async (..._args: unknown[]) => ({ ...emptyResult(), sideReply: null, trace: {} }));
vi.mock("./expand", () => ({ runTakoExpand: (...a: any[]) => runTakoExpand(...a) }));
```

Add tests inside `describe("runTako lane dispatch", …)`:

```typescript
  it("RESEARCH dispatches the expand lane and does NOT clear the board", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "RESEARCH", reason: "dig in" } as any);
    const res = await runTako(req);
    expect(runTakoExpand).toHaveBeenCalledTimes(1);
    expect(runTakoInitial).not.toHaveBeenCalled();
    expect(res.canvasOps.some((o: any) => o.op === "remove_node")).toBe(false);
    expect(res.trace?.action).toBe("RESEARCH");
  });

  it("RESEARCH passes historyText to the expand lane", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "RESEARCH", reason: "dig in" } as any);
    await runTako(req);
    expect(runTakoExpand.mock.calls[0][1]).toBe("HIST");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: FAIL — `runTakoExpand` never called (agent doesn't dispatch RESEARCH yet).

- [ ] **Step 3: Implement — `agent.ts`**

Add the import:
```typescript
import { runTakoExpand } from "./expand";
```

Change the dispatch block (the `removeOps` computation already only fires for `REPLACE`, so RESEARCH is additive automatically):

```typescript
  const result =
    action === "REPLACE" ? await runTakoInitial(req, emit, strategy)
    : action === "RESEARCH" ? await runTakoExpand(req, historyText, emit, strategy)
    : action === "EXPLAIN" ? await runAnswerLane(req, historyText, emit)
    : await runComponentLane(req, action as "AUGMENT" | "GENERATE", historyText, emit, strategy);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/agent.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/tako/agent.ts lib/agents/tako/agent.test.ts
git commit -m "feat(tako): dispatch RESEARCH to the additive expand lane"
```

---

## Task 8: Frontend — focus the newest synthesis node

`app/page.tsx` hard-codes `setFocusNodeId("synth")` and the narration fallback `synthBuf["synth"]`. A new tree's root is `synth_<slug>`, so the camera lands on the wrong (or missing) node. Track the newest synthesis node seen this run.

**Files:**
- Modify: `app/page.tsx`

**Interfaces:** none exported; internal camera behavior.

- [ ] **Step 1: Implement**

In the streaming loop of `app/page.tsx`, declare a mutable holder alongside `synthBuf` (find where `synthBuf` is declared — a `const synthBuf: Record<string, string> = {}` near the top of the run handler). Add next to it:

```typescript
      let lastSynthId = "synth"; // newest synthesis root seen this run (camera + narration fallback)
```

In the `evt.type === "ops"` branch, where research nodes already set focus (the `for (const op of ops)` loop, ~line 163), extend it to also track synthesis roots:

```typescript
              for (const op of ops) {
                if (op.op === "add_node" && op.node.role === "research") setFocusNodeId(op.node.id);
                if ((op.op === "add_node" || op.op === "upsert_node") && op.node.role === "synthesis") lastSynthId = op.node.id;
              }
```

In the `evt.type === "result"` branch, change the narration fallback (~line 190):

```typescript
              const answer = surface === "side_chat"
                ? (evt.sideReply ?? "")
                : (evt.narration || synthBuf[lastSynthId] || "");
```

And the end-of-run camera home (~line 207):

```typescript
      if (surface === "main") setFocusNodeId(lastSynthId);
```

- [ ] **Step 2: Verify the build compiles**

Run: `npx tsc --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add app/page.tsx
git commit -m "feat(canvas): focus the newest synthesis node after a research/expand run"
```

---

## Task 9: Full suite + typecheck gate

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke (optional but recommended)**

Use `/run` to launch the app; on a board with an existing tree, send "research AMD's margins" (expect a NEW tree beside the old one, no wipe), then a plain "why did that rise?" (expect an answer, no new nodes), then "start over with European banks" (expect the board to clear and rebuild).

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "test: full-suite green for additive research trees"
```

---

## Self-Review Notes

- **Spec §1 Routing** → Task 1 (RESEARCH added, REPLACE narrowed, EXPLAIN default). ✓
- **Spec §2 root-id parameterization** → Task 2 (`rootId` on ctx, all `SYNTH_ID` root-path refs). ✓
- **Spec §3 shared runner + lane** → Task 4 (`runResearchTree`) + Task 5 (`runTakoExpand`). ✓
- **Spec §4 cross-links** → Task 5 (anchor edge) + Task 6 (LLM links, validated). ✓
- **Spec §5 scoped context** → Task 3 (`scopedCtxBlock` + `ctxText` on ctx). ✓
- **Spec §6 frontend focus** → Task 8. ✓
- **Error handling** — router→EXPLAIN (existing), expand→degrade (Task 5), cross-link failure→note (Task 6), all edges through `finalizeOps`/`validateGraph` in `agent.ts` (existing). ✓
- **Type consistency** — `synthNode(id, headline, summary)`, `newResearchCtx(…, opts?)`, `runResearchTree(req, ctx, nodeOps, allowedNodeIds, emit?)`, `runTakoExpand(req, historyText, emit?, strategy?)` used identically across tasks. ✓
- **Naming caution:** `finalizeOps` runs in `agent.ts` over the returned `nodeOps`; the anchor + cross-link edges pushed in `expand.ts` are part of `nodeOps`, so they are validated there — no separate validation call needed in the lane.

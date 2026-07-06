# Stage 4 — Comparison Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A toggleable comparison mode that runs the same question on two chosen providers concurrently, renders two side-by-side boards, and shows a scoreboard (latency, cited cards, distinct sources, % grounded, mean confidence) that makes the Tako-vs-baseline contrast unmissable.

**Architecture:** A non-persisted `comparison` slice in the zustand store holds two independent `CanvasState` boards + traces. `ComparisonView` is self-contained: it fires two `streamTurn` calls concurrently (reusing Stage 3's reader), each streaming its own stage text and applying ops to its own board. Scoreboard numbers come from `boardStats` — a pure, unit-tested function over `(CanvasState, TurnTrace)`.

**Tech Stack:** Existing stack; no new dependencies.

**Prerequisite:** Stages 1–3 complete: `streamTurn`, `useCanvasStore`, `FlowCanvas`, `CanvasActionsContext`, `CommandPalette`.

## Global Constraints

- **Each comparison board is its own `CanvasState`** mutated only via `applyOps` (through the store's compare actions). No shared mutable state between panes.
- **Comparison state is ephemeral** — never persisted (`partialize` already excludes anything not listed; keep it that way).
- **Honest contrast:** never massage the numbers — `boardStats` counts only nodes with a real `tako.cardId` as cited; baseline gaps stay visible.
- **Both requests run concurrently** (`Promise.all`), each with an empty starting board and its own `canvasId`.
- **Errors** per pane surface as a toast naming the provider; one pane failing must not break the other.
- **Living docs:** update `CLAUDE.md`/`README.md` when the stage lands.

---

## File Structure

**Create:**
- `lib/compare.ts` — `boardStats` pure function.
- `lib/compare.test.ts` — stats test.
- `components/Scoreboard.tsx` — two-column stats with better-value highlighting.
- `components/ComparisonView.tsx` — dual boards + provider pickers + run bar.

**Modify:**
- `lib/store/canvasStore.ts` — `comparison` slice + actions.
- `app/page.tsx` — Compare toggle + conditional render + palette command.
- `app/globals.css` — comparison/scoreboard classes.
- `CLAUDE.md`, `README.md`.

---

## Task 1: Board statistics (`lib/compare.ts`)

**Files:**
- Create: `lib/compare.ts`, `lib/compare.test.ts`

**Interfaces:**
- Produces:
  - `BoardStats = { latencyMs: number | null; citedCards: number; distinctSources: number; groundedPct: number; meanConfidence: number }`.
  - `boardStats(state: CanvasState, trace: TurnTrace | null): BoardStats` — over `data_card` + `metric` nodes; `groundedPct` 0–100 rounded; `meanConfidence` 0–1 rounded to 2dp.

- [ ] **Step 1: Write the failing test (`lib/compare.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { boardStats } from "./compare";
import type { CanvasState } from "./schema";
import type { TurnTrace } from "./agents/shared/types";

const state: CanvasState = {
  edges: [],
  nodes: [
    { id: "a", type: "data_card", title: "A", grounding: "tako", confidence: 0.9,
      tako: { cardId: "c1", source: "SEC" } },
    { id: "b", type: "data_card", title: "B", grounding: "tako", confidence: 0.9,
      tako: { cardId: "c2", source: "SEC" } },
    { id: "c", type: "data_card", title: "C", grounding: "model", confidence: 0.5 },
    { id: "d", type: "data_card", title: "D", grounding: "tako", confidence: 0.7,
      tako: { cardId: "c3", source: "IMF" } },
    { id: "t", type: "text", title: "gap note", grounding: "model", confidence: 1 },
  ],
};

const trace = { ms: 4200 } as TurnTrace;

describe("boardStats", () => {
  it("computes cited cards, sources, grounded %, mean confidence", () => {
    const s = boardStats(state, trace);
    expect(s.latencyMs).toBe(4200);
    expect(s.citedCards).toBe(3);
    expect(s.distinctSources).toBe(2); // SEC, IMF
    expect(s.groundedPct).toBe(75);    // 3 of 4 data nodes (text node excluded)
    expect(s.meanConfidence).toBe(0.75); // (0.9+0.9+0.5+0.7)/4
  });

  it("handles an empty board and a missing trace", () => {
    const s = boardStats({ nodes: [], edges: [] }, null);
    expect(s).toEqual({ latencyMs: null, citedCards: 0, distinctSources: 0, groundedPct: 0, meanConfidence: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/compare.test.ts` → Expected: FAIL, "Cannot find module './compare'".

- [ ] **Step 3: Write `lib/compare.ts`**

```ts
// Pure scoreboard math. Counts only nodes carrying a real tako.cardId as "cited" —
// this is what makes the provider comparison honest.
import type { CanvasState } from "./schema";
import type { TurnTrace } from "./agents/shared/types";

export interface BoardStats {
  latencyMs: number | null;
  citedCards: number;
  distinctSources: number;
  groundedPct: number;    // 0..100, rounded
  meanConfidence: number; // 0..1, 2dp
}

export function boardStats(state: CanvasState, trace: TurnTrace | null): BoardStats {
  const dataNodes = state.nodes.filter((n) => n.type === "data_card" || n.type === "metric");
  const cited = dataNodes.filter((n) => n.grounding === "tako" && n.tako?.cardId);
  const sources = new Set(
    cited.map((n) => n.tako?.source).filter((s): s is string => !!s),
  );
  const groundedPct = dataNodes.length ? Math.round((cited.length / dataNodes.length) * 100) : 0;
  const meanConfidence = dataNodes.length
    ? Math.round((dataNodes.reduce((a, n) => a + (n.confidence ?? 0), 0) / dataNodes.length) * 100) / 100
    : 0;
  return {
    latencyMs: trace?.ms ?? null,
    citedCards: cited.length,
    distinctSources: sources.size,
    groundedPct,
    meanConfidence,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/compare.test.ts` → Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/compare.ts lib/compare.test.ts && git commit -m "feat: pure boardStats scoreboard math" || true
```

---

## Task 2: Comparison slice in the store

**Files:**
- Modify: `lib/store/canvasStore.ts`

**Interfaces:**
- Produces (added to `CanvasStore`):
  - `CompareSide = "left" | "right"`.
  - `CompareBoard = { provider: ProviderId; board: CanvasState; trace: TurnTrace | null; stage: string; running: boolean }`.
  - State: `comparison: { enabled: boolean; left: CompareBoard; right: CompareBoard }` (defaults: left `gpt`, right `tako`).
  - Actions: `toggleComparison()`, `setCompareProvider(side, p)`, `applyToCompare(side, ops)`, `setCompareTrace(side, trace)`, `setCompareStage(side, stage)`, `setCompareRunning(side, running)`, `resetCompareBoards()`.
- NOT persisted: `partialize` stays `{ sessions, activeSessionId }`.

- [ ] **Step 1: Add the types and defaults**

In `lib/store/canvasStore.ts`, below the `Session` interface, add:

```ts
export type CompareSide = "left" | "right";

export interface CompareBoard {
  provider: ProviderId;
  board: CanvasState;
  trace: TurnTrace | null;
  stage: string;
  running: boolean;
}

function emptyCompare(provider: ProviderId): CompareBoard {
  return { provider, board: { nodes: [], edges: [] }, trace: null, stage: "", running: false };
}
```

- [ ] **Step 2: Extend the `CanvasStore` interface**

Add to the `CanvasStore` interface (after `setLoading`):

```ts
  comparison: { enabled: boolean; left: CompareBoard; right: CompareBoard };
  toggleComparison: () => void;
  setCompareProvider: (side: CompareSide, p: ProviderId) => void;
  applyToCompare: (side: CompareSide, ops: CanvasOp[]) => void;
  setCompareTrace: (side: CompareSide, trace: TurnTrace | null) => void;
  setCompareStage: (side: CompareSide, stage: string) => void;
  setCompareRunning: (side: CompareSide, running: boolean) => void;
  resetCompareBoards: () => void;
```

- [ ] **Step 3: Implement the slice**

Inside the `create()` initializer (after `setLoading: ...`), add:

```ts
      comparison: { enabled: false, left: emptyCompare("gpt"), right: emptyCompare("tako") },

      toggleComparison: () => set((s) => ({
        comparison: { ...s.comparison, enabled: !s.comparison.enabled },
      })),

      setCompareProvider: (side, p) => set((s) => ({
        comparison: { ...s.comparison, [side]: { ...s.comparison[side], provider: p } },
      })),

      applyToCompare: (side, ops) => set((s) => ({
        comparison: {
          ...s.comparison,
          [side]: { ...s.comparison[side], board: applyOps(s.comparison[side].board, ops) },
        },
      })),

      setCompareTrace: (side, trace) => set((s) => ({
        comparison: { ...s.comparison, [side]: { ...s.comparison[side], trace } },
      })),

      setCompareStage: (side, stage) => set((s) => ({
        comparison: { ...s.comparison, [side]: { ...s.comparison[side], stage } },
      })),

      setCompareRunning: (side, running) => set((s) => ({
        comparison: { ...s.comparison, [side]: { ...s.comparison[side], running } },
      })),

      resetCompareBoards: () => set((s) => ({
        comparison: {
          ...s.comparison,
          left: emptyCompare(s.comparison.left.provider),
          right: emptyCompare(s.comparison.right.provider),
        },
      })),
```

- [ ] **Step 4: Verify tests still pass + type-check**

Run: `npx vitest run lib/store` → Expected: green (existing tests untouched; `partialize` unchanged so comparison is not persisted).
Run: `npx tsc --noEmit` → Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add lib/store/canvasStore.ts && git commit -m "feat: ephemeral comparison slice in store" || true
```

---

## Task 3: Scoreboard component

**Files:**
- Create: `components/Scoreboard.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `boardStats` (Task 1), `CompareBoard` (Task 2).
- Produces: `Scoreboard({ left, right }: { left: CompareBoard; right: CompareBoard })` — one row per stat; the better side is tinted (lower latency wins; higher wins elsewhere; ties/empty = no tint).

- [ ] **Step 1: Write `components/Scoreboard.tsx`**

```tsx
"use client";
import { boardStats, type BoardStats } from "@/lib/compare";
import type { CompareBoard } from "@/lib/store/canvasStore";

type Row = {
  label: string;
  value: (s: BoardStats) => number | null;
  format: (v: number | null) => string;
  higherWins: boolean;
};

const ROWS: Row[] = [
  { label: "Latency", value: (s) => s.latencyMs, format: (v) => (v == null ? "—" : `${(v / 1000).toFixed(1)}s`), higherWins: false },
  { label: "Cited cards", value: (s) => s.citedCards, format: (v) => String(v ?? 0), higherWins: true },
  { label: "Distinct sources", value: (s) => s.distinctSources, format: (v) => String(v ?? 0), higherWins: true },
  { label: "Grounded", value: (s) => s.groundedPct, format: (v) => `${v ?? 0}%`, higherWins: true },
  { label: "Mean confidence", value: (s) => s.meanConfidence, format: (v) => (v ?? 0).toFixed(2), higherWins: true },
];

function winner(l: number | null, r: number | null, higherWins: boolean): "l" | "r" | null {
  if (l == null || r == null || l === r) return null;
  const lWins = higherWins ? l > r : l < r;
  return lWins ? "l" : "r";
}

export default function Scoreboard({ left, right }: { left: CompareBoard; right: CompareBoard }) {
  const ls = boardStats(left.board, left.trace);
  const rs = boardStats(right.board, right.trace);
  return (
    <div className="scoreboard">
      <div className="scoreboard-row scoreboard-head">
        <span />
        <span>{left.provider}</span>
        <span>{right.provider}</span>
      </div>
      {ROWS.map((row) => {
        const lv = row.value(ls);
        const rv = row.value(rs);
        const w = winner(lv, rv, row.higherWins);
        return (
          <div key={row.label} className="scoreboard-row">
            <span className="scoreboard-label">{row.label}</span>
            <span className={w === "l" ? "win" : ""}>{row.format(lv)}</span>
            <span className={w === "r" ? "win" : ""}>{row.format(rv)}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Append scoreboard/comparison classes to `app/globals.css`**

```css
/* --- comparison mode --- */
.comparison { position: absolute; inset: 0; display: flex; flex-direction: column; }
.comparison-bar { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-bottom: 1px solid var(--border); background: var(--panel-2); z-index: 10; }
.comparison-bar select { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 8px; font-size: 12px; }
.comparison-bar input { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); }
.comparison-bar .run { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; font-size: 12px; }
.comparison-panes { flex: 1; display: grid; grid-template-columns: 1fr 1fr; min-height: 0; }
.comparison-pane { position: relative; border-right: 1px solid var(--border); min-width: 0; }
.comparison-pane:last-child { border-right: 0; }
.pane-stage { position: absolute; top: 8px; left: 8px; z-index: 10; font-size: 11px; color: var(--muted); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 3px 8px; }
.scoreboard { display: flex; flex-direction: column; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--panel); font-size: 12px; }
.scoreboard-row { display: grid; grid-template-columns: 140px 1fr 1fr; gap: 8px; padding: 2px 0; }
.scoreboard-head { color: var(--muted); text-transform: uppercase; font-size: 10px; letter-spacing: 0.06em; }
.scoreboard-label { color: var(--muted); }
.scoreboard .win { color: var(--tako); font-weight: 600; }
```

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/Scoreboard.tsx app/globals.css && git commit -m "feat: comparison scoreboard" || true
```

---

## Task 4: `ComparisonView` — dual boards, concurrent runs

**Files:**
- Create: `components/ComparisonView.tsx`

**Interfaces:**
- Consumes: `streamTurn` (Stage 3), store compare actions (Task 2), `FlowCanvas` + `CanvasActionsContext` (Stage 2), `Scoreboard` (Task 3).
- Produces: `ComparisonView()` — no props; fully store-driven. Each pane gets its own `CanvasActionsContext` whose `dispatchOps` targets that side; `askAbout` is a no-op in comparison mode (side chat is main-board-only).

- [ ] **Step 1: Write `components/ComparisonView.tsx`**

```tsx
"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { ProviderId } from "@/lib/schema";
import { streamTurn } from "@/lib/client/streamTurn";
import { useCanvasStore, type CompareSide } from "@/lib/store/canvasStore";
import FlowCanvas from "./canvas/FlowCanvas";
import { CanvasActionsContext, type CanvasActions } from "./canvas/CanvasActions";
import Scoreboard from "./Scoreboard";

const PROVIDER_IDS: ProviderId[] = ["gpt", "claude", "tako"];

function Pane({ side }: { side: CompareSide }) {
  const cb = useCanvasStore((s) => s.comparison[side]);
  const { applyToCompare } = useCanvasStore.getState();

  const actions: CanvasActions = useMemo(() => ({
    dispatchOps: (ops) => applyToCompare(side, ops),
    askAbout: () => {}, // side chat is main-board only
    setHighlightEntity: () => {},
  }), [applyToCompare, side]);

  return (
    <div className="comparison-pane">
      {cb.running && <div className="pane-stage">⋯ {cb.stage || "thinking"}</div>}
      <CanvasActionsContext.Provider value={actions}>
        <FlowCanvas state={cb.board} selection={[]} highlightEntity={null}
          onSelectionIds={() => {}} dispatchOps={(ops) => applyToCompare(side, ops)} />
      </CanvasActionsContext.Provider>
    </div>
  );
}

export default function ComparisonView() {
  const comparison = useCanvasStore((s) => s.comparison);
  const [q, setQ] = useState("Research the best 5 semiconductor companies to invest in");
  const running = comparison.left.running || comparison.right.running;

  const run = async () => {
    if (!q.trim() || running) return;
    const api = useCanvasStore.getState();
    api.resetCompareBoards();

    const go = (side: CompareSide) => {
      const st = useCanvasStore.getState();
      const provider = st.comparison[side].provider;
      st.setCompareRunning(side, true);
      st.setCompareStage(side, "thinking");
      return streamTurn(
        {
          canvasId: `compare-${side}`, message: q, surface: "main",
          canvasState: { nodes: [], edges: [] },
          selection: { nodeIds: [], nodes: [] },
          providerId: provider, takoAnswerEnabled: true,
        },
        {
          onStage: (stage) => useCanvasStore.getState().setCompareStage(side, stage),
          onError: (err) => toast.error(`${provider}: ${err}`),
          onResult: (r) => {
            const s = useCanvasStore.getState();
            if (r.canvasOps?.length) s.applyToCompare(side, r.canvasOps);
            s.setCompareTrace(side, r.trace);
          },
        },
      )
        .catch((e) => toast.error(`${provider}: ${String(e?.message || e)}`))
        .finally(() => useCanvasStore.getState().setCompareRunning(side, false));
    };

    await Promise.all([go("left"), go("right")]);
  };

  const select = (side: CompareSide) => (
    <select value={comparison[side].provider} disabled={running}
      onChange={(e) => useCanvasStore.getState().setCompareProvider(side, e.target.value as ProviderId)}>
      {PROVIDER_IDS.map((p) => <option key={p} value={p}>{p}</option>)}
    </select>
  );

  return (
    <div className="comparison">
      <div className="comparison-bar">
        {select("left")}
        <span style={{ color: "var(--muted)", fontSize: 12 }}>vs</span>
        {select("right")}
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Run the same question on both boards…" />
        <button className="run" onClick={run} disabled={running}>
          {running ? "Running…" : "Run both"}
        </button>
      </div>
      <Scoreboard left={comparison.left} right={comparison.right} />
      <div className="comparison-panes">
        <Pane side="left" />
        <Pane side="right" />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/ComparisonView.tsx && git commit -m "feat: dual-board comparison view with concurrent runs" || true
```

---

## Task 5: Wire the toggle into `app/page.tsx` + palette + verify

**Files:**
- Modify: `app/page.tsx`
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Import and read the comparison state**

In `app/page.tsx`, add to the imports:

```tsx
import ComparisonView from "@/components/ComparisonView";
```

Below the `loadingStage` store selector line, add:

```tsx
  const comparisonEnabled = useCanvasStore((s) => s.comparison.enabled);
  const { toggleComparison } = useCanvasStore.getState();
```

- [ ] **Step 2: Add the toolbar toggle**

In the provider-buttons toolbar `<div>` (the one at `top: 12, left: 12`), append after the provider buttons:

```tsx
          <button onClick={toggleComparison} style={{
            padding: "6px 10px", borderRadius: 8,
            border: `1px solid ${comparisonEnabled ? "var(--tako)" : "var(--border)"}`,
            background: comparisonEnabled ? "var(--tako)" : "var(--panel)",
            color: comparisonEnabled ? "#fff" : "var(--text)", fontSize: 12,
          }}>⇄ Compare</button>
```

- [ ] **Step 3: Conditionally render the comparison view**

Wrap the canvas column's content: when comparison is on, everything between the toolbar and the side panel is replaced by `<ComparisonView />`. Structure the canvas column as:

```tsx
      {/* Canvas column */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 20, display: "flex", gap: 8, alignItems: "center" }}>
          {/* provider buttons + Compare toggle (unchanged) */}
        </div>

        {comparisonEnabled ? (
          <div style={{ position: "absolute", inset: 0, paddingTop: 48 }}>
            <ComparisonView />
          </div>
        ) : (
          <>
            {/* explainer, FlowCanvas provider block, EmptyState, SkeletonNodes,
                TracePanel, main chat overlay — all unchanged from Stage 3 */}
          </>
        )}
      </div>
```

Concretely: move the existing explainer + `CanvasActionsContext.Provider` + `EmptyState` + `SkeletonNodes` + `TracePanel` + main-chat-overlay JSX inside the `<>…</>` else-branch, unchanged. Bump the toolbar `zIndex` from 10 to 20 so it sits above the comparison bar.

- [ ] **Step 4: Add the palette command**

In the `commands` memo, append:

```tsx
    { id: "compare", label: "Toggle comparison mode", run: () => toggleComparison() },
```

and add `toggleComparison` to the memo's dependency array.

- [ ] **Step 5: Verify build + tests**

Run: `npx tsc --noEmit` → Expected: clean.
Run: `npm test` → Expected: all green (incl. `lib/compare.test.ts`).
Run: `npm run build` → Expected: green.

- [ ] **Step 6: Manual end-to-end check**

Run: `npm run dev`, open http://localhost:3000:
- Click ⇄ Compare → the split view appears with provider selects (`gpt` vs `tako` by default), scoreboard (dashes), two empty panes.
- Run the semiconductor question → both panes stream their own stage text concurrently; the Tako pane fills with cited (green) cards, the baseline pane is thinner and amber.
- The scoreboard populates: latency both sides, cited cards / distinct sources / grounded % / mean confidence, better side tinted green — Tako should visibly win the grounding columns.
- Toggle back → the normal single-board session is intact (comparison never touched it).
- ⌘K → "Toggle comparison mode" works.
- Set an invalid `TAKO_API_KEY` and run → the tako pane toasts `tako: …` while the baseline pane still completes.

- [ ] **Step 7: Update living docs + commit**

Append to `CLAUDE.md`:

```markdown
## Comparison mode (Stage 4)
- Comparison boards are an EPHEMERAL store slice (never in `partialize`) — two independent
  `CanvasState`s, ops applied via `applyToCompare(side, ops)`.
- Both providers run concurrently via `Promise.all` over `streamTurn`; per-pane failures toast
  with the provider name and never break the other pane.
- Scoreboard math is pure (`lib/compare.ts` `boardStats`) — "cited" means a real `tako.cardId`.
```

Update `README.md`: comparison mode + scoreboard description.

```bash
git add -A && git commit -m "feat: comparison mode toggle with dual boards + scoreboard" || true
```

---

## Self-Review

**Spec coverage (Stage 4 scope = spec §10):**
- Toggle splits the canvas into two boards running the same query under two chosen providers → Tasks 2, 4, 5. ✓
- Each board its own `FlowCanvas` reading its own `CanvasState` → Task 4 (`Pane`). ✓
- Scoreboard across the top: latency, # cited cards, # distinct sources, % grounded, mean confidence, computed from trace + nodes → Tasks 1, 3. ✓
- Contrast unmissable / baseline gaps visible → honest `boardStats` (only real `cardId`s count) + amber baseline styling from Stage 2. ✓
- "Synchronized" boards → both run the same query from the same empty start, concurrently; pan/zoom stays per-pane (viewport sync is not in the spec's metric list and is intentionally out of scope). ✓

**Placeholder scan:** all code steps complete. Task 5 Step 3 references Stage 3 JSX as "unchanged" — that is a move-without-modification instruction with the exact wrapper code shown, not a placeholder. ✓

**Type consistency:** `CompareSide`/`CompareBoard` defined once (Task 2), consumed in Tasks 3, 4; `boardStats(state, trace)` matches `BoardStats` rows in Task 3; `streamTurn` signature from Stage 3 reused verbatim; `applyToCompare(side, ops)` consistent Tasks 2, 4. ✓

**Risk notes for the executor:**
- If `useCanvasStore((s) => s.comparison[side])` re-renders too often during streaming, it's still correct — do not "optimize" by caching the board outside the store.
- Two concurrent `/api/agent` requests double LLM/Tako spend per run — expected; the run button guards re-entry while either pane is running.

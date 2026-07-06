# Stage 2 — Canvas Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled pan/zoom canvas with `@xyflow/react`, deterministic fan-in + dagre layout, one polished component per node type (with grounding badges, criteria sliders, a consensus leaderboard with hover-highlight), kind-colored edges with a legend, and derived section containers — while `CanvasState` stays the single source of truth.

**Architecture:** `deriveFlow(canvasState, ui)` is a pure mapping from the canonical scene-graph to React Flow nodes/edges; React Flow never becomes the source of truth. User gestures (drag, slider edits, remove, pin) round-trip through `CanvasOp`s via a `CanvasActions` React context, and `applyOps` remains the only reducer. Layout is deterministic app code: `fanInLayout` (signature entity-column fan-in) for nodes without an explicit `position`, `tidyLayout` (dagre) as an on-demand re-layout that overwrites positions via `move_node` ops.

**Tech Stack:** `@xyflow/react` v12, `dagre` (tidy layout), `recharts` (baseline model-drawn charts), existing Next.js 14.2 / React 18.3 / TypeScript strict, vitest.

**Prerequisite:** Stage 1 (`docs/superpowers/plans/2026-07-06-stage1-agentic-core.md`) is complete: 3 providers, NDJSON streaming route, `applyOps` with wired `recompute_consensus`, `lib/layout.ts` does NOT yet exist.

## Global Constraints

- **Scene-graph is canonical.** `@xyflow/react` renders *from* `CanvasState`; every mutation goes through `applyOps` as `CanvasOp`s. React Flow's internal state is a disposable projection.
- **User-moved node positions persist**: dragging emits `move_node` (sets `position`), and `fanInLayout` respects explicit `position` — agents leave `position` untouched on REPLACE/AUGMENT.
- **No hard-coded iframe heights**: Tako v3 embeds post height via a `tako::resize` postMessage — listen for it.
- **Grounding badge semantics:** `tako` = green + source + as-of; `model` = amber "from memory". Baseline model-drawn `chartSpec` charts render via Recharts with the amber treatment.
- **Pin deps compatible with React 18.3 / Next 14.2.** No UI kit; keep the dark CSS-var token base.
- **Deterministic code owns layout** — `fanInLayout` and `tidyLayout` are pure functions with unit tests.
- **Living docs:** record non-obvious findings in root `CLAUDE.md`; update `README.md` when the stage lands.
- New RF-driven canvas must not delete nodes on keyboard Delete (that would bypass ops): `deleteKeyCode={null}`; users cannot draw edges: `nodesConnectable={false}`.

---

## File Structure

**Create:**
- `lib/layout.ts` — `NODE_W`, `heightGuess`, `fanInLayout`, `tidyLayout` (dagre).
- `lib/layout.test.ts` — determinism + explicit-position tests.
- `components/canvas/CanvasActions.tsx` — React context: `dispatchOps`, `askAbout`, `setHighlightEntity`.
- `components/canvas/deriveFlow.ts` — pure `CanvasState → { nodes, edges }` projection (incl. derived section containers).
- `components/canvas/FlowCanvas.tsx` — React Flow wrapper + minimap + fit/tidy controls.
- `components/canvas/CanvasEdgeC.tsx` — custom edge colored by `kind` + highlight.
- `components/canvas/EdgeLegend.tsx` — edge-kind legend panel.
- `components/nodes/NodeShell.tsx` — shared card chrome: header, hover actions (ask/pin/remove), handles.
- `components/nodes/GroundingBadge.tsx` — tako/model badge.
- `components/nodes/ModelChart.tsx` — Recharts renderer for `chartSpec` (replaces `MiniChart`).
- `components/nodes/useTakoResize.ts` — `tako::resize` postMessage hook.
- `components/nodes/DataCardNode.tsx`, `components/nodes/MetricNode.tsx`, `components/nodes/TextNode.tsx`, `components/nodes/CriteriaNode.tsx`, `components/nodes/ConsensusNode.tsx`, `components/nodes/SectionNode.tsx`.

**Modify:**
- `app/page.tsx` — swap the hand-rolled scene for `FlowCanvas` behind `CanvasActionsContext`.
- `app/globals.css` — node/edge/section/RF-theme classes.
- `package.json` — new deps.
- `CLAUDE.md`, `README.md` — findings + feature notes.

**Delete:**
- `components/NodeCard.tsx`, `components/MiniChart.tsx`.

---

## Task 1: Dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: installed `@xyflow/react`, `dagre` (+types), `recharts` for all later tasks.

- [ ] **Step 1: Install runtime deps**

```bash
npm install @xyflow/react@^12 dagre@^0.8 recharts@^2
```

- [ ] **Step 2: Install dev deps**

```bash
npm install -D @types/dagre@^0.7
```

- [ ] **Step 3: Verify nothing broke**

Run: `npm run build` → Expected: green (no code changed).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json && git commit -m "chore: add xyflow, dagre, recharts" || true
```

---

## Task 2: Deterministic layout (`lib/layout.ts`)

**Files:**
- Create: `lib/layout.ts`, `lib/layout.test.ts`

**Interfaces:**
- Produces:
  - `NODE_W = 280` (moves here from the old `components/NodeCard.tsx`).
  - `heightGuess(n: CanvasNode): number`.
  - `fanInLayout(nodes: CanvasNode[]): Record<string, { x: number; y: number }>` — entity columns fanning into consensus; respects explicit `position`; SKIPS `entity_section` nodes (they render as derived containers in Task 7).
  - `tidyLayout(state: CanvasState): CanvasOp[]` — dagre re-layout, one `move_node` op per non-section node (this is how "tidy" clears manual positions: it overwrites them).
- Consumes: `dagre`.

- [ ] **Step 1: Write the failing test (`lib/layout.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { fanInLayout, tidyLayout } from "./layout";
import type { CanvasState } from "./schema";

const state: CanvasState = {
  edges: [{ id: "f1", from: "c1", to: "cons", kind: "feeds" }],
  nodes: [
    { id: "hdr", type: "entity_section", section: "Nvidia", title: "Nvidia", grounding: "model", confidence: 1 },
    { id: "c1", type: "data_card", section: "Nvidia", title: "Rev", grounding: "tako", confidence: 1 },
    { id: "c2", type: "data_card", section: "Nvidia", title: "Margin", grounding: "tako", confidence: 1 },
    { id: "pinned", type: "data_card", section: "Nvidia", title: "P", grounding: "tako", confidence: 1,
      position: { x: 900, y: 900 } },
    { id: "cons", type: "consensus", title: "V", grounding: "model", confidence: 1 },
  ],
};

describe("fanInLayout", () => {
  it("stacks same-section cards vertically in one column", () => {
    const pos = fanInLayout(state.nodes);
    expect(pos["c1"].x).toBe(pos["c2"].x);
    expect(pos["c2"].y).toBeGreaterThan(pos["c1"].y);
  });

  it("respects explicit positions and skips entity_section headers", () => {
    const pos = fanInLayout(state.nodes);
    expect(pos["pinned"]).toEqual({ x: 900, y: 900 });
    expect(pos["hdr"]).toBeUndefined();
  });

  it("is deterministic", () => {
    expect(fanInLayout(state.nodes)).toEqual(fanInLayout(state.nodes));
  });
});

describe("tidyLayout", () => {
  it("returns a move op for every non-section node and is deterministic", () => {
    const ops = tidyLayout(state);
    expect(ops).toHaveLength(4); // c1, c2, pinned, cons — NOT hdr
    expect(new Set(ops.map((o) => o.op))).toEqual(new Set(["move_node"]));
    expect(tidyLayout(state)).toEqual(ops);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/layout.test.ts` → Expected: FAIL, "Cannot find module './layout'".

- [ ] **Step 3: Write `lib/layout.ts`**

```ts
// Deterministic layout. fanInLayout = the signature entity-column fan-in;
// tidyLayout = on-demand dagre re-layout (overwrites manual positions by design).
import dagre from "dagre";
import type { CanvasNode, CanvasOp, CanvasState } from "./schema";

export const NODE_W = 280;

export function heightGuess(n: CanvasNode): number {
  if (n.type === "data_card") return n.tako ? 320 : 220;
  if (n.type === "consensus") return 220;
  if (n.type === "criteria") return 180;
  if (n.type === "metric") return 110;
  return 100;
}

export function fanInLayout(nodes: CanvasNode[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const sections: string[] = [];
  for (const n of nodes) if (n.section && !sections.includes(n.section)) sections.push(n.section);
  const colW = NODE_W + 64;
  const topY = 60;
  const colY: Record<string, number> = {};
  sections.forEach((s) => (colY[s] = topY));

  for (const n of nodes) {
    if (n.type === "entity_section") continue; // rendered as a derived container, not laid out here
    if (n.position) { pos[n.id] = n.position; continue; }
    if (n.type === "consensus" || n.role === "consensus" || n.type === "criteria" || !n.section) continue;
    const col = sections.indexOf(n.section);
    pos[n.id] = { x: 60 + col * colW, y: colY[n.section] };
    colY[n.section] += heightGuess(n) + 28;
  }

  const maxColY = Math.max(topY, ...Object.values(colY).concat(topY));
  const critX = 60 + Math.max(sections.length, 1) * colW;
  let critY = topY;
  for (const n of nodes) {
    if (!n.position && n.type === "criteria") { pos[n.id] = { x: critX, y: critY }; critY += heightGuess(n) + 40; }
  }
  const centerX = 60 + (Math.max(sections.length - 1, 0) * colW) / 2;
  for (const n of nodes) {
    if (!n.position && (n.type === "consensus" || n.role === "consensus")) {
      pos[n.id] = { x: centerX, y: maxColY + 60 };
    }
  }
  let ny = maxColY + 320;
  for (const n of nodes) {
    if (pos[n.id] || n.type === "entity_section") continue;
    pos[n.id] = { x: 60, y: ny };
    ny += 140;
  }
  return pos;
}

export function tidyLayout(state: CanvasState): CanvasOp[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 48, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));
  const laidOut = state.nodes.filter((n) => n.type !== "entity_section");
  for (const n of laidOut) g.setNode(n.id, { width: NODE_W, height: heightGuess(n) });
  const ids = new Set(laidOut.map((n) => n.id));
  for (const e of state.edges) if (ids.has(e.from) && ids.has(e.to)) g.setEdge(e.from, e.to);
  dagre.layout(g);
  return laidOut.map((n) => {
    const p = g.node(n.id); // dagre positions are centers — convert to top-left
    return { op: "move_node" as const, id: n.id, position: { x: p.x - NODE_W / 2, y: p.y - heightGuess(n) / 2 } };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/layout.test.ts` → Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/layout.ts lib/layout.test.ts && git commit -m "feat: deterministic fan-in layout + dagre tidy layout" || true
```

---

## Task 3: Node building blocks — badge, resize hook, Recharts chart

**Files:**
- Create: `components/nodes/GroundingBadge.tsx`, `components/nodes/useTakoResize.ts`, `components/nodes/ModelChart.tsx`

**Interfaces:**
- Produces:
  - `GroundingBadge({ node }: { node: CanvasNode })` — colored badge + confidence %.
  - `useTakoResize(defaultHeight?: number): { ref: RefObject<HTMLIFrameElement>; height: number }`.
  - `ModelChart({ spec }: { spec: ChartSpec })` — multi-series bar/line via Recharts.

- [ ] **Step 1: Write `components/nodes/GroundingBadge.tsx`**

```tsx
"use client";
import type { CanvasNode } from "@/lib/schema";

export default function GroundingBadge({ node }: { node: CanvasNode }) {
  const tako = node.grounding === "tako";
  return (
    <span className={`badge ${tako ? "badge-tako" : "badge-model"}`}
      title={tako ? "Grounded in a live Tako data card" : "From model memory — unverified"}>
      {tako ? "tako" : "from memory"} · {Math.round((node.confidence ?? 0) * 100)}%
    </span>
  );
}
```

- [ ] **Step 2: Write `components/nodes/useTakoResize.ts`**

```ts
"use client";
// Tako v3 embeds post their rendered height via a `tako::resize` postMessage.
// Never hard-code iframe heights — match the event to THIS iframe via event.source.
import { useEffect, useRef, useState } from "react";

function parseData(data: unknown): Record<string, unknown> | null {
  if (typeof data === "string") {
    try { return JSON.parse(data); } catch { return null; }
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

export function useTakoResize(defaultHeight = 200) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(defaultHeight);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const d = parseData(e.data);
      if (!d) return;
      const type = String(d.type ?? d.event ?? "");
      if (!type.includes("tako") || !type.includes("resize")) return;
      const payload = (d.payload && typeof d.payload === "object" ? d.payload : d) as Record<string, unknown>;
      const h = Number(payload.height);
      if (Number.isFinite(h) && h > 40) setHeight(Math.min(h, 640));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return { ref, height };
}
```

- [ ] **Step 3: Write `components/nodes/ModelChart.tsx`**

```tsx
"use client";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import type { ChartSpec } from "@/lib/schema";

const SERIES_COLORS = ["#d0891f", "#8b83e8", "#22b183", "#e0603a", "#7fb02e"];

export default function ModelChart({ spec }: { spec: ChartSpec }) {
  const labels = spec.series.map((s) => s.label);
  const xs = Array.from(new Set(spec.series.flatMap((s) => s.points.map((p) => String(p.x)))));
  const rows = xs.map((x) => {
    const row: Record<string, string | number> = { x };
    for (const s of spec.series) {
      const p = s.points.find((pt) => String(pt.x) === x);
      if (p) row[s.label] = p.y;
    }
    return row;
  });

  const axisTick = { fontSize: 10, fill: "var(--muted)" };
  const tooltipStyle = { background: "var(--panel-2)", border: "1px solid var(--border)", fontSize: 11 };
  const margin = { top: 4, right: 4, bottom: 0, left: -18 };

  return (
    <div style={{ width: "100%", height: 150 }}>
      <ResponsiveContainer>
        {spec.kind === "line" ? (
          <LineChart data={rows} margin={margin}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="x" tick={axisTick} />
            <YAxis tick={axisTick} />
            <Tooltip contentStyle={tooltipStyle} />
            {labels.map((l, i) => (
              <Line key={l} dataKey={l} stroke={SERIES_COLORS[i % SERIES_COLORS.length]} dot={false} strokeWidth={1.5} />
            ))}
          </LineChart>
        ) : (
          <BarChart data={rows} margin={margin}>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
            <XAxis dataKey="x" tick={axisTick} />
            <YAxis tick={axisTick} />
            <Tooltip contentStyle={tooltipStyle} />
            {labels.map((l, i) => (
              <Bar key={l} dataKey={l} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
      {spec.unit && <div className="node-meta">{spec.unit}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: the three new files clean (`.badge*` CSS classes arrive in Task 4).

```bash
git add components/nodes/GroundingBadge.tsx components/nodes/useTakoResize.ts components/nodes/ModelChart.tsx
git commit -m "feat: grounding badge, tako resize hook, recharts model chart" || true
```

---

## Task 4: Canvas actions context + NodeShell + CSS

**Files:**
- Create: `components/canvas/CanvasActions.tsx`, `components/nodes/NodeShell.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Produces:
  - `CanvasActions = { dispatchOps(ops: CanvasOp[]): void; askAbout(node: CanvasNode): void; setHighlightEntity(entity: string | null): void }`, `CanvasActionsContext`, `useCanvasActions()`.
  - `NodeShell({ node, selected, x?, y?, headerRight?, width?, children })` — card chrome with hover actions (ask-about-this / pin / remove) + hidden top/bottom RF handles.
- Consumes: `NODE_W` (Task 2).

- [ ] **Step 1: Write `components/canvas/CanvasActions.tsx`**

```tsx
"use client";
import { createContext, useContext } from "react";
import type { CanvasNode, CanvasOp } from "@/lib/schema";

export interface CanvasActions {
  dispatchOps: (ops: CanvasOp[]) => void;
  askAbout: (node: CanvasNode) => void;
  setHighlightEntity: (entity: string | null) => void;
}

export const CanvasActionsContext = createContext<CanvasActions>({
  dispatchOps: () => {},
  askAbout: () => {},
  setHighlightEntity: () => {},
});

export const useCanvasActions = () => useContext(CanvasActionsContext);
```

- [ ] **Step 2: Write `components/nodes/NodeShell.tsx`**

```tsx
"use client";
import type { ReactNode } from "react";
import { Handle, Position } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";
import { NODE_W } from "@/lib/layout";
import { useCanvasActions } from "../canvas/CanvasActions";

export default function NodeShell({
  node, selected, x, y, headerRight, width = NODE_W, children,
}: {
  node: CanvasNode;
  selected: boolean;
  x?: number;
  y?: number;
  headerRight?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  const { dispatchOps, askAbout } = useCanvasActions();
  const pinned = node.position != null;

  return (
    <div className={`node-shell${selected ? " selected" : ""}`} style={{ width }}>
      <Handle type="target" position={Position.Top} className="port" />
      <div className="node-header">
        <div className="node-title">{node.title}</div>
        {headerRight}
      </div>
      <div className="node-actions">
        <button title="Ask about this node"
          onClick={(e) => { e.stopPropagation(); askAbout(node); }}>💬</button>
        <button title={pinned ? "Unpin (return to auto-layout)" : "Pin current position"}
          onClick={(e) => {
            e.stopPropagation();
            if (pinned) dispatchOps([{ op: "update_node", id: node.id, patch: { position: null } }]);
            else if (x != null && y != null) dispatchOps([{ op: "move_node", id: node.id, position: { x, y } }]);
          }}>{pinned ? "📍" : "📌"}</button>
        <button title="Remove node"
          onClick={(e) => { e.stopPropagation(); dispatchOps([{ op: "remove_node", id: node.id, cascade: true }]); }}>✕</button>
      </div>
      <div className="node-body">{children}</div>
      <Handle type="source" position={Position.Bottom} className="port" />
    </div>
  );
}
```

- [ ] **Step 3: Append the canvas classes to `app/globals.css`**

```css
/* --- canvas nodes --- */
.node-shell { position: relative; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; }
.node-shell.selected { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.node-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); }
.node-title { font-size: 13px; font-weight: 500; }
.node-body { padding: 10px; }
.node-meta { font-size: 10px; color: var(--muted); margin-top: 6px; }
.node-meta.model { color: var(--model); }
.node-meta a { color: var(--tako); }
.node-summary { font-size: 12px; color: var(--muted); margin-top: 6px; }
.node-actions { position: absolute; top: -30px; right: 0; display: none; gap: 4px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 2px 4px; z-index: 5; }
.node-shell:hover .node-actions { display: flex; }
.node-actions button { border: 0; background: transparent; font-size: 12px; padding: 2px 4px; }
.linkish { border: 0; background: none; color: var(--tako); padding: 0; font-size: 10px; text-decoration: underline; cursor: pointer; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; white-space: nowrap; }
.badge-tako { background: rgba(29, 158, 117, 0.15); color: var(--tako); border: 1px solid var(--tako); }
.badge-model { background: rgba(186, 117, 23, 0.15); color: var(--model); border: 1px solid var(--model); }
.port { opacity: 0; pointer-events: none; }
.weight-row { display: grid; grid-template-columns: 1fr 110px 40px; gap: 6px; align-items: center; font-size: 12px; padding: 3px 0; }
.consensus-row { display: flex; gap: 8px; align-items: center; padding: 4px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
.consensus-row .rank { color: var(--accent); width: 18px; font-weight: 600; }
.consensus-row .entity { flex: 1; }
.consensus-row:hover { background: rgba(127, 119, 221, 0.08); }
.section-box { border: 1px dashed var(--border); background: rgba(127, 119, 221, 0.05); border-radius: 16px; position: relative; width: 100%; height: 100%; }
.section-label { position: absolute; top: 10px; left: 14px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

/* --- react flow theming --- */
.react-flow { background: var(--bg); }
.ct-minimap { background: var(--panel) !important; border: 1px solid var(--border); border-radius: 8px; }
.ct-controls { display: flex; gap: 6px; }
.ct-controls button { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--text); font-size: 12px; }
.ct-legend { display: flex; gap: 10px; padding: 6px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; font-size: 11px; color: var(--muted); }
.ct-legend .swatch { display: inline-block; width: 14px; height: 2px; margin-right: 4px; vertical-align: middle; }
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/canvas/CanvasActions.tsx components/nodes/NodeShell.tsx app/globals.css
git commit -m "feat: canvas actions context, node shell with hover actions" || true
```

---

## Task 5: Leaf node components — data card, metric, text

**Files:**
- Create: `components/nodes/DataCardNode.tsx`, `components/nodes/MetricNode.tsx`, `components/nodes/TextNode.tsx`

**Interfaces:**
- Consumes: `NodeShell`, `GroundingBadge`, `ModelChart`, `useTakoResize` (Tasks 3–4).
- Produces: memoized RF node components, each typed `NodeProps<Node<{ node: CanvasNode }>>`. `data.node` carries the canonical `CanvasNode` (set by `deriveFlow`, Task 7).

- [ ] **Step 1: Write `components/nodes/DataCardNode.tsx`**

```tsx
"use client";
import { memo, useState } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";
import NodeShell from "./NodeShell";
import GroundingBadge from "./GroundingBadge";
import ModelChart from "./ModelChart";
import { useTakoResize } from "./useTakoResize";

type RFNode = Node<{ node: CanvasNode }>;

function DataCardNode(props: NodeProps<RFNode>) {
  const n = props.data.node;
  const [expanded, setExpanded] = useState(false);
  const { ref, height } = useTakoResize(200);

  return (
    <NodeShell node={n} selected={!!props.selected}
      x={props.positionAbsoluteX} y={props.positionAbsoluteY}
      headerRight={<GroundingBadge node={n} />}>
      {n.tako?.embedUrl ? (
        <div>
          <iframe ref={ref} src={n.tako.embedUrl} title={n.title}
            style={{ width: "100%", height: expanded ? Math.max(height, 380) : height, border: 0, borderRadius: 8, background: "#fff" }} />
          <div className="node-meta">
            {n.tako.source}{n.tako.asOf ? ` · as of ${n.tako.asOf}` : ""} ·{" "}
            <a href={n.tako.webpageUrl} target="_blank" rel="noreferrer">open in Tako</a> ·{" "}
            <button className="linkish" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}>
              {expanded ? "collapse" : "expand"}
            </button>
          </div>
        </div>
      ) : n.chartSpec ? (
        <div>
          <ModelChart spec={n.chartSpec} />
          <div className="node-meta model">model-drawn · no source · numbers may be stale</div>
        </div>
      ) : (
        <div className="node-meta">no structured data available</div>
      )}
      {n.summary && <div className="node-summary">{n.summary}</div>}
    </NodeShell>
  );
}

export default memo(DataCardNode);
```

- [ ] **Step 2: Write `components/nodes/MetricNode.tsx`**

```tsx
"use client";
import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";
import NodeShell from "./NodeShell";
import GroundingBadge from "./GroundingBadge";

type RFNode = Node<{ node: CanvasNode }>;

function MetricNode(props: NodeProps<RFNode>) {
  const n = props.data.node;
  return (
    <NodeShell node={n} selected={!!props.selected}
      x={props.positionAbsoluteX} y={props.positionAbsoluteY}
      headerRight={<GroundingBadge node={n} />}>
      {n.metric && (
        <div>
          <div style={{ fontSize: 22, fontWeight: 500 }}>{n.metric.value}</div>
          <div className="node-meta">{n.metric.label}{n.metric.delta ? ` · ${n.metric.delta}` : ""}</div>
        </div>
      )}
      {n.summary && <div className="node-summary">{n.summary}</div>}
    </NodeShell>
  );
}

export default memo(MetricNode);
```

- [ ] **Step 3: Write `components/nodes/TextNode.tsx`**

```tsx
"use client";
import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";
import NodeShell from "./NodeShell";

type RFNode = Node<{ node: CanvasNode }>;

function TextNode(props: NodeProps<RFNode>) {
  const n = props.data.node;
  return (
    <NodeShell node={n} selected={!!props.selected}
      x={props.positionAbsoluteX} y={props.positionAbsoluteY}>
      <div style={{ fontSize: 12, color: "var(--text)" }}>{n.summary || n.title}</div>
    </NodeShell>
  );
}

export default memo(TextNode);
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/nodes/DataCardNode.tsx components/nodes/MetricNode.tsx components/nodes/TextNode.tsx
git commit -m "feat: data card, metric, text node components" || true
```

---

## Task 6: Interactive nodes — criteria sliders, consensus leaderboard, section container

**Files:**
- Create: `components/nodes/CriteriaNode.tsx`, `components/nodes/ConsensusNode.tsx`, `components/nodes/SectionNode.tsx`

**Interfaces:**
- Consumes: `useCanvasActions` (Task 4).
- Produces:
  - `CriteriaNode` — weight sliders; each change dispatches `update_node` with the new weights (the page's `dispatchOps` auto-appends `recompute_consensus`, Task 9 — this is the deterministic REFRAME path).
  - `ConsensusNode` — hero leaderboard; hovering a row calls `setHighlightEntity(entity)` (edges touching that entity's section get emphasized via `deriveFlow`).
  - `SectionNode` — translucent container; sized by `deriveFlow` via node `style`.

- [ ] **Step 1: Write `components/nodes/CriteriaNode.tsx`**

```tsx
"use client";
import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";
import NodeShell from "./NodeShell";
import { useCanvasActions } from "../canvas/CanvasActions";

type RFNode = Node<{ node: CanvasNode }>;

function CriteriaNode(props: NodeProps<RFNode>) {
  const n = props.data.node;
  const { dispatchOps } = useCanvasActions();
  const weights = n.criteria?.weights ?? {};

  const setWeight = (key: string, value: number) =>
    dispatchOps([{ op: "update_node", id: n.id, patch: { criteria: { weights: { ...weights, [key]: value } } } }]);

  return (
    <NodeShell node={n} selected={!!props.selected}
      x={props.positionAbsoluteX} y={props.positionAbsoluteY}>
      {Object.entries(weights).map(([key, value]) => (
        <div key={key} className="weight-row">
          <span>{key}</span>
          {/* className="nodrag" stops React Flow from starting a node drag on the slider */}
          <input type="range" min={0} max={1} step={0.05} value={value} className="nodrag"
            onChange={(e) => setWeight(key, Number(e.target.value))}
            onPointerDown={(e) => e.stopPropagation()} />
          <span className="mono" style={{ color: "var(--muted)" }}>{value.toFixed(2)}</span>
        </div>
      ))}
      {Object.keys(weights).length === 0 && <div className="node-meta">no criteria yet</div>}
    </NodeShell>
  );
}

export default memo(CriteriaNode);
```

- [ ] **Step 2: Write `components/nodes/ConsensusNode.tsx`**

```tsx
"use client";
import { memo } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";
import NodeShell from "./NodeShell";
import { useCanvasActions } from "../canvas/CanvasActions";

type RFNode = Node<{ node: CanvasNode }>;

function ConsensusNode(props: NodeProps<RFNode>) {
  const n = props.data.node;
  const { setHighlightEntity } = useCanvasActions();
  const rows = [...(n.consensusRows ?? [])].sort((a, b) => a.rank - b.rank);

  return (
    <NodeShell node={n} selected={!!props.selected} width={340}
      x={props.positionAbsoluteX} y={props.positionAbsoluteY}>
      {rows.map((r) => (
        <div key={r.entity} className="consensus-row"
          onMouseEnter={() => setHighlightEntity(r.entity)}
          onMouseLeave={() => setHighlightEntity(null)}>
          <span className="rank">{r.rank}</span>
          <span className="entity">{r.entity}</span>
          {r.score != null && <span className="mono" style={{ color: "var(--muted)" }}>{r.score}</span>}
        </div>
      ))}
      {rows.length === 0 && <div className="node-meta">consensus pending…</div>}
      {n.summary && <div className="node-summary">{n.summary}</div>}
    </NodeShell>
  );
}

export default memo(ConsensusNode);
```

- [ ] **Step 3: Write `components/nodes/SectionNode.tsx`**

```tsx
"use client";
import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CanvasNode } from "@/lib/schema";

type RFNode = Node<{ node: CanvasNode }>;

// Translucent container behind an entity column. Width/height come from the
// RF node `style` computed in deriveFlow; not draggable or selectable.
function SectionNode(props: NodeProps<RFNode>) {
  const n = props.data.node;
  return (
    <div className="section-box">
      <Handle type="target" position={Position.Top} className="port" />
      <div className="section-label">{n.title || n.section}</div>
      <Handle type="source" position={Position.Bottom} className="port" />
    </div>
  );
}

export default memo(SectionNode);
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/nodes/CriteriaNode.tsx components/nodes/ConsensusNode.tsx components/nodes/SectionNode.tsx
git commit -m "feat: criteria sliders, consensus leaderboard, section container" || true
```

---

## Task 7: Edge component, legend, and `deriveFlow`

**Files:**
- Create: `components/canvas/CanvasEdgeC.tsx`, `components/canvas/EdgeLegend.tsx`, `components/canvas/deriveFlow.ts`

**Interfaces:**
- Consumes: `fanInLayout`, `heightGuess`, `NODE_W` (Task 2).
- Produces:
  - `CanvasEdgeC` — bezier edge, stroke by `data.kind`, emphasized when `data.highlight`.
  - `EdgeLegend` — RF `Panel` listing kinds/colors.
  - `deriveFlow(state: CanvasState, ui: { selection: string[]; highlightEntity: string | null }): { nodes: RFNode[]; edges: RFEdge[] }` — pure; `entity_section` nodes become `section` containers sized to their members' bounds; all other nodes map to their typed component with `data: { node }`.

- [ ] **Step 1: Write `components/canvas/CanvasEdgeC.tsx`**

```tsx
"use client";
import { memo } from "react";
import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";

const KIND_COLOR: Record<string, string> = {
  feeds: "var(--feeds)",
  supports: "var(--supports)",
  contradicts: "var(--contradicts)",
  derived_from: "var(--accent)",
  sibling: "var(--muted)",
};

function CanvasEdgeC(props: EdgeProps) {
  const [path] = getBezierPath({
    sourceX: props.sourceX, sourceY: props.sourceY, sourcePosition: props.sourcePosition,
    targetX: props.targetX, targetY: props.targetY, targetPosition: props.targetPosition,
  });
  const kind = String(props.data?.kind ?? "feeds");
  const highlight = !!props.data?.highlight;
  return (
    <BaseEdge id={props.id} path={path} className="canvas-edge"
      style={{
        stroke: KIND_COLOR[kind] || "var(--muted)",
        strokeWidth: highlight ? 2.5 : 1.5,
        opacity: highlight ? 1 : 0.75,
      }} />
  );
}

export default memo(CanvasEdgeC);
```

- [ ] **Step 2: Write `components/canvas/EdgeLegend.tsx`**

```tsx
"use client";
import { Panel } from "@xyflow/react";

const KINDS = [
  { kind: "feeds", color: "var(--feeds)" },
  { kind: "supports", color: "var(--supports)" },
  { kind: "contradicts", color: "var(--contradicts)" },
  { kind: "derived_from", color: "var(--accent)" },
  { kind: "sibling", color: "var(--muted)" },
];

export default function EdgeLegend() {
  return (
    <Panel position="bottom-left">
      <div className="ct-legend">
        {KINDS.map((k) => (
          <span key={k.kind}>
            <span className="swatch" style={{ background: k.color }} />
            {k.kind}
          </span>
        ))}
      </div>
    </Panel>
  );
}
```

- [ ] **Step 3: Write `components/canvas/deriveFlow.ts`**

```ts
// Pure projection: canonical CanvasState -> React Flow nodes/edges.
// React Flow is a renderer here, never the source of truth.
import type { Edge, Node } from "@xyflow/react";
import type { CanvasEdge, CanvasNode, CanvasState } from "@/lib/schema";
import { fanInLayout, heightGuess, NODE_W } from "@/lib/layout";

const RF_TYPE: Record<CanvasNode["type"], string> = {
  entity_section: "section",
  data_card: "dataCard",
  metric: "metric",
  criteria: "criteria",
  consensus: "consensus",
  text: "textNote",
};

export interface FlowUi {
  selection: string[];
  highlightEntity: string | null;
}

export function deriveFlow(state: CanvasState, ui: FlowUi): { nodes: Node[]; edges: Edge[] } {
  const pos = fanInLayout(state.nodes);
  const selected = new Set(ui.selection);
  const nodes: Node[] = [];

  // entity_section headers become translucent containers sized to member bounds
  for (const header of state.nodes) {
    if (header.type !== "entity_section") continue;
    const members = state.nodes.filter((m) => m.section === header.section && m.type !== "entity_section");
    if (members.length === 0) {
      nodes.push({
        id: header.id, type: "section",
        position: header.position ?? { x: 60, y: 60 },
        data: { node: header }, style: { width: NODE_W + 32, height: 64 },
        draggable: false, selectable: false, zIndex: -1,
      });
      continue;
    }
    const ps = members.map((m) => m.position ?? pos[m.id] ?? { x: 0, y: 0 });
    const minX = Math.min(...ps.map((p) => p.x));
    const minY = Math.min(...ps.map((p) => p.y));
    const maxY = Math.max(...members.map((m, i) => ps[i].y + heightGuess(m)));
    nodes.push({
      id: header.id, type: "section",
      position: { x: minX - 16, y: minY - 44 },
      data: { node: header },
      style: { width: NODE_W + 32, height: maxY - minY + 60 + 44 },
      draggable: false, selectable: false, zIndex: -1,
    });
  }

  for (const n of state.nodes) {
    if (n.type === "entity_section") continue;
    const p = n.position ?? pos[n.id] ?? { x: 60, y: 60 };
    nodes.push({
      id: n.id,
      type: RF_TYPE[n.type],
      position: p,
      data: { node: n },
      selected: selected.has(n.id),
    });
  }

  const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
  const touchesEntity = (e: CanvasEdge, entity: string) =>
    nodeById.get(e.from)?.section === entity || nodeById.get(e.to)?.section === entity;

  const edges: Edge[] = state.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    type: "canvasEdge",
    data: {
      kind: e.kind,
      label: e.label,
      highlight: !!ui.highlightEntity && touchesEntity(e, ui.highlightEntity),
    },
  }));

  return { nodes, edges };
}
```

- [ ] **Step 4: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/canvas/CanvasEdgeC.tsx components/canvas/EdgeLegend.tsx components/canvas/deriveFlow.ts
git commit -m "feat: kind-colored edges, legend, deriveFlow projection" || true
```

---

## Task 8: `FlowCanvas` — the React Flow wrapper

**Files:**
- Create: `components/canvas/FlowCanvas.tsx`

**Interfaces:**
- Consumes: `deriveFlow` (Task 7), all node/edge components (Tasks 5–7), `tidyLayout` (Task 2).
- Produces: `FlowCanvas({ state, selection, highlightEntity, onSelectionIds, dispatchOps })` — pan, zoom-to-cursor, minimap, fit, tidy, Shift-marquee multi-select; drag-stop emits `move_node`.
- Sync pattern: RF holds a working copy via `useNodesState`/`useEdgesState` (so drags render live); a `useEffect` re-derives it from `CanvasState` whenever canonical state or UI flags change. Drag-stop commits the final position as an op, so the re-derive is a no-op visually.

- [ ] **Step 1: Write `components/canvas/FlowCanvas.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useMemo } from "react";
import {
  Background, BackgroundVariant, MiniMap, Panel, ReactFlow, ReactFlowProvider,
  useEdgesState, useNodesState, useReactFlow,
  type Node, type OnSelectionChangeParams,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { CanvasOp, CanvasState } from "@/lib/schema";
import { tidyLayout } from "@/lib/layout";
import { deriveFlow } from "./deriveFlow";
import CanvasEdgeC from "./CanvasEdgeC";
import EdgeLegend from "./EdgeLegend";
import DataCardNode from "../nodes/DataCardNode";
import MetricNode from "../nodes/MetricNode";
import TextNode from "../nodes/TextNode";
import CriteriaNode from "../nodes/CriteriaNode";
import ConsensusNode from "../nodes/ConsensusNode";
import SectionNode from "../nodes/SectionNode";

const NODE_TYPES = {
  dataCard: DataCardNode, metric: MetricNode, textNote: TextNode,
  criteria: CriteriaNode, consensus: ConsensusNode, section: SectionNode,
};
const EDGE_TYPES = { canvasEdge: CanvasEdgeC };

export interface FlowCanvasProps {
  state: CanvasState;
  selection: string[];
  highlightEntity: string | null;
  onSelectionIds: (ids: string[]) => void;
  dispatchOps: (ops: CanvasOp[]) => void;
}

function FlowInner({ state, selection, highlightEntity, onSelectionIds, dispatchOps }: FlowCanvasProps) {
  const derived = useMemo(
    () => deriveFlow(state, { selection, highlightEntity }),
    [state, selection, highlightEntity],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(derived.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(derived.edges);
  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(derived.nodes);
    setEdges(derived.edges);
  }, [derived, setNodes, setEdges]);

  const onNodeDragStop = useCallback((_: unknown, n: Node) => {
    if (n.type === "section") return;
    dispatchOps([{ op: "move_node", id: n.id, position: { x: n.position.x, y: n.position.y } }]);
  }, [dispatchOps]);

  const onSelectionChange = useCallback(({ nodes: sel }: OnSelectionChangeParams) => {
    onSelectionIds(sel.map((n) => n.id));
  }, [onSelectionIds]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
      onNodeDragStop={onNodeDragStop} onSelectionChange={onSelectionChange}
      fitView minZoom={0.25} maxZoom={2}
      selectionKeyCode="Shift"
      nodesConnectable={false}
      deleteKeyCode={null}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#252a38" />
      <MiniMap pannable zoomable className="ct-minimap" />
      <Panel position="top-right" className="ct-controls">
        <button onClick={() => fitView({ padding: 0.2, duration: 300 })}>Fit</button>
        <button title="Deterministic dagre re-layout (overwrites manual positions)"
          onClick={() => dispatchOps(tidyLayout(state))}>Tidy</button>
      </Panel>
      <EdgeLegend />
    </ReactFlow>
  );
}

export default function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowInner {...props} />
    </ReactFlowProvider>
  );
}
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/canvas/FlowCanvas.tsx && git commit -m "feat: FlowCanvas react-flow wrapper with minimap, fit, tidy" || true
```

---

## Task 9: Rewire `app/page.tsx`, delete old components, verify end-to-end

**Files:**
- Modify: `app/page.tsx`
- Delete: `components/NodeCard.tsx`, `components/MiniChart.tsx`
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: `FlowCanvas` (Task 8), `CanvasActionsContext` (Task 4), Stage 1's NDJSON stream protocol.
- Produces: `dispatchOps(ops)` — applies ops via `applyOps`; when an op touches `criteria`, auto-appends `{ op: "recompute_consensus", target: <consensus node id> }` (the deterministic slider-REFRAME path). `askAbout(node)` selects the node and focuses the side-chat input.

- [ ] **Step 1: Replace the entire contents of `app/page.tsx`**

```tsx
"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CanvasNode, CanvasOp, CanvasState, ProviderId } from "@/lib/schema";
import { applyOps } from "@/lib/schema";
import FlowCanvas from "@/components/canvas/FlowCanvas";
import { CanvasActionsContext, type CanvasActions } from "@/components/canvas/CanvasActions";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "tako", label: "LLM + Tako" },
  { id: "gpt", label: "GPT" },
  { id: "claude", label: "Claude" },
];

export default function Page() {
  const [provider, setProvider] = useState<ProviderId>("tako");
  const [state, setState] = useState<CanvasState>({ nodes: [], edges: [] });
  const [selection, setSelection] = useState<string[]>([]);
  const [highlightEntity, setHighlightEntity] = useState<string | null>(null);
  const [mainLog, setMainLog] = useState<{ role: string; text: string }[]>([]);
  const [sideLog, setSideLog] = useState<{ role: string; text: string }[]>([]);
  const [input, setInput] = useState("Research the best 5 semiconductor companies to invest in");
  const [sideInput, setSideInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastTrace, setLastTrace] = useState<unknown>(null);
  const sideInputRef = useRef<HTMLInputElement>(null);

  const nodeById = useMemo(() => Object.fromEntries(state.nodes.map((n) => [n.id, n])), [state.nodes]);

  const dispatchOps = useCallback((ops: CanvasOp[]) => {
    setState((s) => {
      let all = ops;
      const touchesCriteria = ops.some(
        (o) => (o.op === "update_node" && o.patch.criteria) ||
          ((o.op === "add_node" || o.op === "upsert_node") && o.node.criteria),
      );
      if (touchesCriteria) {
        const cons = s.nodes.find((n) => n.type === "consensus");
        if (cons) all = [...ops, { op: "recompute_consensus", target: cons.id }];
      }
      return applyOps(s, all);
    });
  }, []);

  const askAbout = useCallback((node: CanvasNode) => {
    setSelection([node.id]);
    sideInputRef.current?.focus();
  }, []);

  const actions: CanvasActions = useMemo(
    () => ({ dispatchOps, askAbout, setHighlightEntity }),
    [dispatchOps, askAbout],
  );

  const onSelectionIds = useCallback((ids: string[]) => {
    setSelection((prev) =>
      prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids);
  }, []);

  const send = useCallback(async (surface: "main" | "side_chat", text: string) => {
    if (!text.trim() || loading) return;
    setLoading(true); setError(null); setLoadingStage("thinking");
    (surface === "main" ? setMainLog : setSideLog)((l) => [...l, { role: "user", text }]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canvasId: "default", message: text, surface, canvasState: state,
          selection: { nodeIds: selection, nodes: selection.map((id) => nodeById[id]).filter(Boolean) },
          providerId: provider, takoAnswerEnabled: true,
        }),
      });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        const evt = JSON.parse(line);
        if (evt.type === "trace") setLoadingStage(evt.stage);
        else if (evt.type === "error") setError(evt.error);
        else if (evt.type === "result") {
          if (evt.canvasOps?.length) setState((s) => applyOps(s, evt.canvasOps));
          if (surface === "main" && evt.narration) setMainLog((l) => [...l, { role: "agent", text: evt.narration }]);
          if (evt.sideReply) setSideLog((l) => [...l, { role: "agent", text: evt.sideReply }]);
          setLastTrace(evt.trace);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        lines.forEach(handleLine);
      }
      if (buf.trim()) handleLine(buf);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false); setLoadingStage("");
    }
  }, [state, selection, nodeById, provider, loading]);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", height: "100vh" }}>
      {/* Canvas */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 10, display: "flex", gap: 8, alignItems: "center" }}>
          {PROVIDERS.map((p) => (
            <button key={p.id} onClick={() => setProvider(p.id)} style={{
              padding: "6px 10px", borderRadius: 8,
              border: `1px solid ${provider === p.id ? "var(--accent)" : "var(--border)"}`,
              background: provider === p.id ? "var(--accent)" : "var(--panel)",
              color: provider === p.id ? "#fff" : "var(--text)", fontSize: 12,
            }}>{p.label}</button>
          ))}
        </div>

        <CanvasActionsContext.Provider value={actions}>
          <FlowCanvas state={state} selection={selection} highlightEntity={highlightEntity}
            onSelectionIds={onSelectionIds} dispatchOps={dispatchOps} />
        </CanvasActionsContext.Provider>

        {/* Main chat overlay */}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10, padding: 12, background: "linear-gradient(transparent, var(--bg) 40%)" }}>
          {error && <div style={{ color: "var(--contradicts)", fontSize: 12, marginBottom: 6 }}>{error}</div>}
          {loading && loadingStage && (
            <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>⋯ {loadingStage}</div>
          )}
          <div style={{ maxHeight: 120, overflowY: "auto", marginBottom: 8 }}>
            {mainLog.slice(-4).map((m, i) => (
              <div key={i} style={{ fontSize: 12, color: m.role === "user" ? "var(--text)" : "var(--muted)", margin: "2px 0" }}>
                <b>{m.role === "user" ? "you" : "canvas"}:</b> {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (send("main", input), setInput(""))}
              placeholder="Ask the canvas…"
              style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
            <button onClick={() => { send("main", input); setInput(""); }} disabled={loading}
              style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff" }}>
              {loading ? "…" : "Send"}
            </button>
          </div>
        </div>
      </div>

      {/* Side panel: selection-scoped chat */}
      <div style={{ borderLeft: "1px solid var(--border)", background: "var(--panel-2)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 500 }}>Selection chat</div>
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--muted)" }}>
          {selection.length
            ? selection.map((id) => nodeById[id]?.title || id).join(", ")
            : "Select nodes on the canvas (click, or Shift-drag) to ask about them."}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {sideLog.map((m, i) => (
            <div key={i} style={{ fontSize: 13, margin: "6px 0", color: m.role === "user" ? "var(--text)" : "var(--muted)" }}>
              <b>{m.role === "user" ? "you" : "assistant"}:</b> {m.text}
            </div>
          ))}
        </div>
        <div style={{ padding: 12, display: "flex", gap: 8, borderTop: "1px solid var(--border)" }}>
          <input ref={sideInputRef} value={sideInput} onChange={(e) => setSideInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (send("side_chat", sideInput), setSideInput(""))}
            placeholder="Ask about the selection…"
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
          <button onClick={() => { send("side_chat", sideInput); setSideInput(""); }} disabled={loading || !selection.length}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>Ask</button>
        </div>
      </div>
    </div>
  );
}
```

(`lastTrace` is intentionally unused in the UI this stage; the Trace panel arrives in Stage 3. Keep the state so the stream handler stays complete.)

- [ ] **Step 2: Delete the superseded components**

```bash
rm components/NodeCard.tsx components/MiniChart.tsx
```

- [ ] **Step 3: Verify build + tests**

Run: `npx tsc --noEmit` → Expected: clean (nothing imports NodeCard/MiniChart anymore).
Run: `npm test` → Expected: all suites green (layout, sanitize, consensus, relate, tako).
Run: `npm run build` → Expected: green.

- [ ] **Step 4: Manual end-to-end check**

Run: `npm run dev`, open http://localhost:3000, send the seeded semiconductor prompt with provider `tako`:
- Board renders in React Flow: entity columns inside translucent section containers, criteria + consensus nodes, colored edges + legend, minimap bottom-right.
- Scroll zooms to cursor; drag pans; drag a node → it stays put after the turn (position persisted via `move_node`).
- Shift-drag marquee selects multiple nodes; the side panel lists them.
- Drag a criteria slider → the consensus leaderboard re-ranks immediately (deterministic).
- Hover a consensus row → that entity's edges brighten.
- Hover a node → 💬/📌/✕ actions appear; ✕ removes node + edges; 💬 selects it and focuses the side chat.
- Click Tidy → dagre re-layout; click Fit → viewport fits the board.
- A Tako embed grows to its posted height (no fixed 200px clipping) if the embed sends `tako::resize`.

- [ ] **Step 5: Update living docs**

Append to `CLAUDE.md` under a `## Canvas (Stage 2)` heading:

```markdown
## Canvas (Stage 2)
- `CanvasState` is canonical; React Flow is a projection. Sync pattern: `useNodesState` working copy
  + `useEffect` re-derive from `deriveFlow(state, ui)`; drag-stop commits `move_node` ops.
- React Flow v12: import styles from `@xyflow/react/dist/style.css`; `deleteKeyCode={null}` so RF never
  deletes nodes behind `applyOps`; `nodesConnectable={false}`; put `className="nodrag"` on inputs inside
  nodes (sliders) or RF starts a node drag.
- dagre returns CENTER coordinates — convert to top-left (`x - w/2, y - h/2`).
- Tako embed heights: listen for a `tako::resize` postMessage and match `event.source` to the iframe's
  `contentWindow`; never hard-code iframe heights.
- `entity_section` nodes are not laid out by `fanInLayout`; `deriveFlow` renders them as containers
  sized to their members' bounding box.
```

Update `README.md` features section: React Flow canvas (pan/zoom-to-cursor/minimap/fit/tidy/marquee), criteria weight sliders → deterministic re-rank, consensus hover-highlight, Recharts baseline charts.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: react-flow canvas substrate, node/edge redesign, sliders + leaderboard" || true
```

---

## Self-Review

**Spec coverage (Stage 2 scope = spec §7 + §8):**
- `@xyflow/react` wraps the canvas, `deriveFlow` memoized, `onNodeDragStop` → `move_node`, CanvasState canonical → Tasks 7, 8, 9. ✓
- Pan / zoom-to-cursor / minimap / fitView / marquee / focus rings → Task 8 (RF built-ins + `selectionKeyCode="Shift"`, `.node-shell.selected`). ✓
- Custom Controls: fit + tidy → Task 8; tidy = dagre in `lib/layout.ts` → Task 2. ✓
- Fan-in column auto-layout respecting explicit `position` → Task 2. ✓
- Node types per `NodeType` + custom kind-colored edge + legend → Tasks 5, 6, 7. (Edge draw-in animation is Stage 5 per staged delivery.) ✓
- Section containers with entity name → Tasks 6 (SectionNode), 7 (derived bounds). ✓
- Grounding badge (tako green + source/as-of; model amber "from memory") → Tasks 3, 5. ✓
- Hover actions: ask-about-this / expand / pin / remove → Tasks 4 (shell: ask/pin/remove), 5 (expand on data card). ✓
- Consensus hero leaderboard + row hover highlights supporting edges → Tasks 6, 7 (`highlightEntity` plumbed via context + deriveFlow). ✓
- Criteria sliders → REFRAME + deterministic recompute → Tasks 6, 9 (auto-append `recompute_consensus`). ✓
- `tako::resize` listener, no hard-coded heights → Tasks 3, 5. ✓
- Recharts replaces MiniChart, multi-series bar/line, amber treatment → Task 3; MiniChart deleted → Task 9. ✓

**Placeholder scan:** every code step contains complete code; no TBDs. ✓

**Type consistency:** `dispatchOps(ops: CanvasOp[]) => void` identical in Tasks 4, 8, 9; `deriveFlow(state, { selection, highlightEntity })` matches Task 8's call; `NodeProps<Node<{ node: CanvasNode }>>` pattern uniform across node components; `fanInLayout`/`tidyLayout`/`heightGuess`/`NODE_W` names consistent Tasks 2, 7. ✓

**Risk notes for the executor:**
- If `@xyflow/react`'s `NodeProps` generic differs in the installed minor version (e.g. `positionAbsoluteX` missing), read the node's absolute position from `useReactFlow().getNode(id)?.position` instead — confine the fix to `NodeShell` callers.
- Recharts `ResponsiveContainer` needs a sized parent — the fixed-height wrapper div in `ModelChart` provides it; don't remove it.

"use client";
import { useMemo } from "react";
import type { CanvasNode, CanvasEdge } from "@/lib/schema";
import { nodeWidth, nodeHeight, EDGE_COLOR, type Band, LAYOUT_LABEL_X } from "@/lib/layout";
import NodeCard from "./NodeCard";

type Pos = Record<string, { x: number; y: number }>;

type Side = "t" | "b" | "l" | "r";
type Rect = { x: number; y: number; w: number; h: number };

// Pick the pair of edge-midpoint anchors that face each other, so the line always
// leaves the source box and enters the target box on the correct side.
function anchorPair(a: Rect, b: Rect): [{ x: number; y: number; s: Side }, { x: number; y: number; s: Side }] {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  const dx = bcx - acx, dy = bcy - acy;
  if (Math.abs(dy) >= Math.abs(dx)) {
    return dy >= 0
      ? [{ x: acx, y: a.y + a.h, s: "b" }, { x: bcx, y: b.y, s: "t" }]
      : [{ x: acx, y: a.y, s: "t" }, { x: bcx, y: b.y + b.h, s: "b" }];
  }
  return dx >= 0
    ? [{ x: a.x + a.w, y: acy, s: "r" }, { x: b.x, y: bcy, s: "l" }]
    : [{ x: a.x, y: acy, s: "l" }, { x: b.x + b.w, y: bcy, s: "r" }];
}

function ctrl(p: { x: number; y: number; s: Side }, off: number) {
  if (p.s === "t") return `${p.x},${p.y - off}`;
  if (p.s === "b") return `${p.x},${p.y + off}`;
  if (p.s === "l") return `${p.x - off},${p.y}`;
  return `${p.x + off},${p.y}`;
}

export default function CanvasScene({
  nodes, edges, pos, sceneRef, draggingId, bands, selection, collapsed, heights,
  onSelect, onDragStart, onToggleCollapse, onMeasure, nodeById,
}: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  pos: Pos;
  sceneRef: React.RefObject<HTMLDivElement>;
  draggingId: string | null;
  bands: Band[];
  selection: string[];
  collapsed: Record<string, boolean>;
  heights: Record<string, number>;
  onSelect: (id: string) => (e: React.MouseEvent) => void;
  onDragStart: (id: string) => (e: React.PointerEvent) => void;
  onToggleCollapse: (id: string) => (e: React.MouseEvent) => void;
  onMeasure: (id: string, height: number) => void;
  nodeById: Record<string, CanvasNode>;
}) {
  // Live box rect for a node — real rendered height when known, estimate before mount.
  const rectOf = (n: CanvasNode, p: { x: number; y: number }): Rect => ({
    x: p.x, y: p.y, w: nodeWidth(n), h: heights[n.id] ?? nodeHeight(n),
  });
  // Incoming `feeds` edges per node — surfaced as "grounded in N sources" on the synthesis block.
  const feedsInto = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of edges) if (e.kind === "feeds") m[e.to] = (m[e.to] ?? 0) + 1;
    return m;
  }, [edges]);

  // Click a node → light up every edge touching it and the nodes on the other end.
  const { active, litEdges, litNodes } = useMemo(() => {
    const sel = new Set(selection);
    const litEdges = new Set<string>();
    const litNodes = new Set<string>(selection);
    if (sel.size) {
      for (const e of edges)
        if (sel.has(e.from) || sel.has(e.to)) {
          litEdges.add(e.id);
          litNodes.add(e.from);
          litNodes.add(e.to);
        }
    }
    return { active: sel.size > 0, litEdges, litNodes };
  }, [selection, edges]);

  // Draw dimmed edges first, lit edges last (on top).
  const orderedEdges = useMemo(
    () => (active ? [...edges].sort((a, b) => Number(litEdges.has(a.id)) - Number(litEdges.has(b.id))) : edges),
    [edges, active, litEdges],
  );

  return (
    <div className="scene" ref={sceneRef}>
      <svg className="edges">
        {orderedEdges.map((edge) => {
          const a = pos[edge.from], b = pos[edge.to];
          const na = nodeById[edge.from], nb = nodeById[edge.to];
          if (!a || !b || !na || !nb) return null;
          const [s, t] = anchorPair(rectOf(na, a), rectOf(nb, b));
          const dist = Math.hypot(t.x - s.x, t.y - s.y);
          const off = Math.max(36, Math.min(dist * 0.42, 150));
          const lit = litEdges.has(edge.id);
          const color = EDGE_COLOR[edge.kind] || "var(--line-strong)";
          const w = active ? (lit ? 2.4 : 1.2) : 1.6;
          // A dragged node's edges are stale (paths recompute on drop) — fade them so the
          // transient detachment reads as intentional rather than broken.
          const touchesDrag = !!draggingId && (edge.from === draggingId || edge.to === draggingId);
          const op = touchesDrag ? 0.1 : active ? (lit ? 1 : 0.08) : 0.7;
          return (
            <g key={edge.id} style={{ transition: "opacity .2s", opacity: op }}>
              <path
                d={`M${s.x},${s.y} C${ctrl(s, off)} ${ctrl(t, off)} ${t.x},${t.y}`}
                fill="none" stroke={color} strokeWidth={w} strokeLinecap="round"
                style={{ transition: "stroke-width .15s" }}
              />
              {/* connection ports where the line meets each box */}
              <circle cx={s.x} cy={s.y} r={lit ? 4 : 3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
              <circle cx={t.x} cy={t.y} r={lit ? 4 : 3} fill={color} stroke="var(--surface)" strokeWidth={1.5} />
            </g>
          );
        })}
      </svg>

      {/* Band labels on the left rail */}
      {bands.map((band) => (
        <div
          key={band.label}
          className="band-label"
          style={{ left: LAYOUT_LABEL_X - 6, top: band.y - 30 }}
        >
          {band.label}
        </div>
      ))}

      {nodes.map((n) => {
        const dim = active && !litNodes.has(n.id);
        const dragging = draggingId === n.id;
        return (
          <div
            key={n.id}
            data-node-id={n.id}
            onPointerDown={onDragStart(n.id)}
            onClick={onSelect(n.id)}
            style={{
              position: "absolute",
              left: pos[n.id]?.x ?? 0,
              top: pos[n.id]?.y ?? 0,
              opacity: dim ? 0.28 : 1,
              filter: dim ? "saturate(0.6)" : "none",
              zIndex: dragging ? 10 : undefined,
              // The dragged wrapper is moved imperatively via style.transform; don't ease it.
              transition: dragging ? "none" : "opacity .22s var(--ease), filter .22s var(--ease)",
              cursor: dragging ? "grabbing" : "grab",
              touchAction: "none",
            }}
          >
            <NodeCard
              node={n}
              selected={selection.includes(n.id)}
              connected={active && litNodes.has(n.id) && !selection.includes(n.id)}
              sources={feedsInto[n.id]}
              onMeasure={onMeasure}
              collapsed={!!collapsed[n.id]}
              onToggleCollapse={onToggleCollapse(n.id)}
            />
          </div>
        );
      })}
    </div>
  );
}

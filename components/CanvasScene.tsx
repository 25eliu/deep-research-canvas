"use client";
import { useMemo } from "react";
import type { CanvasNode, CanvasEdge } from "@/lib/schema";
import { nodeWidth, nodeHeight, EDGE_COLOR } from "@/lib/layout";
import { getAncestors, getDescendants } from "@/lib/lineage";
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
  nodes, edges, pos, sceneRef, draggingId, selection, collapsed, heights,
  onSelect, onDragStart, onToggleCollapse, onMeasure, nodeById,
}: {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  pos: Pos;
  sceneRef: React.RefObject<HTMLDivElement>;
  draggingId: string | null;
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

  // Click a node → light up its whole lineage: every ancestor up to the root, its full
  // descendant subtree, and the edges whose both ends are in that lit set.
  const { active, litEdges, litNodes } = useMemo(() => {
    const litNodes = new Set<string>(selection);
    for (const id of selection) {
      for (const a of getAncestors(id, edges)) litNodes.add(a);
      for (const d of getDescendants(id, edges)) litNodes.add(d);
    }
    const litEdges = new Set<string>();
    if (selection.length)
      for (const e of edges)
        if (litNodes.has(e.from) && litNodes.has(e.to)) litEdges.add(e.id);
    return { active: selection.length > 0, litEdges, litNodes };
  }, [selection, edges]);

  // The dragged node moves with its whole subtree — treat every member as "dragging" so
  // their transitions pause and their stale edges fade together.
  const movingIds = useMemo(() => {
    if (!draggingId) return null;
    const s = getDescendants(draggingId, edges);
    s.add(draggingId);
    return s;
  }, [draggingId, edges]);

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
          const touchesDrag = !!movingIds && (movingIds.has(edge.from) || movingIds.has(edge.to));
          const op = touchesDrag ? 0.1 : active ? (lit ? 1 : 0.08) : 0.7;
          const d = `M${s.x},${s.y} C${ctrl(s, off)} ${ctrl(t, off)} ${t.x},${t.y}`;
          // Cards glide to their slot when the layout reflows (see the node wrappers below);
          // ease the edge geometry on the same clock so lines stay attached to their boxes.
          // CSS `d`/`cx`/`cy` transitions cover evergreen browsers; the attributes remain
          // the functional fallback (edges just snap where unsupported).
          const glide = draggingId ? "none" : undefined;
          return (
            <g key={edge.id} style={{ transition: "opacity .2s", opacity: op }}>
              <path
                d={d}
                fill="none" stroke={color} strokeWidth={w} strokeLinecap="round"
                style={{ d: `path("${d}")`, transition: glide ?? "d .32s var(--ease), stroke-width .15s" }}
              />
              {/* connection ports where the line meets each box */}
              <circle cx={s.x} cy={s.y} r={lit ? 4 : 3} fill={color} stroke="var(--surface)" strokeWidth={1.5}
                style={{ transition: glide ?? "cx .32s var(--ease), cy .32s var(--ease)" }} />
              <circle cx={t.x} cy={t.y} r={lit ? 4 : 3} fill={color} stroke="var(--surface)" strokeWidth={1.5}
                style={{ transition: glide ?? "cx .32s var(--ease), cy .32s var(--ease)" }} />
            </g>
          );
        })}
      </svg>

      {nodes.map((n) => {
        const dim = active && !litNodes.has(n.id);
        const dragging = !!movingIds?.has(n.id);
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
              // Everyone else GLIDES to their slot when the layout reflows (new cards
              // streaming in, embed heights settling) instead of teleporting.
              transition: dragging
                ? "none"
                : "left .32s var(--ease), top .32s var(--ease), opacity .22s var(--ease), filter .22s var(--ease)",
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

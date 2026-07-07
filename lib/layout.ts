// Deterministic top-down band layout for the canvas.
// Every turn's nodes are placed into fixed horizontal bands with generous gaps —
// synthesis on top, then source columns (header above its card), then explanations —
// so the board always reads as a clean fan-out instead of a clump. The backend still
// emits whatever positions it likes; we ignore them here (user-dragged cards are the
// only exception, handled in the page) and impose our own structure.
import type { CanvasNode, CanvasEdge } from "./schema";

export const EDGE_COLOR: Record<string, string> = {
  supports: "var(--supports)",
  contradicts: "var(--contradicts)",
  feeds: "var(--feeds)",
  derived_from: "var(--accent)",
  sibling: "var(--line-strong)",
};

const COL_PITCH = 486;   // horizontal stride per source column (tight around a 460px card)
const ROW_GAP = 66;      // vertical gap between bands
const PAIR_GAP = 14;     // gap between a header and its source card
const STACK_GAP = 22;    // gap between stacked source cards in one column
const FLOW_GAP = 30;     // gap between items in a fanned-out flow band
const WRAP_COLS = 4;     // source columns per row before wrapping to the next row
const MAX_ROW_W = 1950;  // max width of a fan-out row before it wraps
const ORIGIN_X = 1200;   // layout is centered on this x (kept positive for the edge <svg>)
const ORIGIN_Y = 56;
const LABEL_X = 150;     // left rail where band labels sit

export function nodeWidth(n: CanvasNode): number {
  if (n.role === "synthesis") return 600;
  if (n.role === "research") return 420;
  if (n.role === "source") return 280;
  if (n.type === "data_card" && n.tako?.embedUrl) return 460;
  if (n.type === "data_card") return 300;
  if (n.type === "consensus") return 360;
  if (n.type === "metric") return 220;
  if (n.type === "criteria") return 260;
  if (n.type === "entity_section") return 190;
  return 260;
}

export function nodeHeight(n: CanvasNode): number {
  // Tako cards are sized to their real aspect at render time (up to ~1.7×460 + chrome);
  // reserve room for the tallest so stacked source columns never collide.
  if (n.role === "synthesis") return 320; // pre-mount estimate; real height self-reports
  if (n.role === "research") return 200; // pre-mount estimate; real height self-reports
  if (n.role === "source") return 120; // compact clickable link card
  if (n.type === "data_card") return n.tako?.embedUrl ? 760 : 250;
  if (n.type === "consensus") return 220;
  if (n.type === "criteria") return 200;
  if (n.type === "entity_section") return 128;
  if (n.type === "metric") return 128;
  return 160;
}

export type Pos = { x: number; y: number };
export interface Band { label: string; y: number }
export interface LayoutResult {
  positions: Record<string, Pos>;
  bands: Band[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

function chunk<T>(a: T[], n: number): T[][] {
  const r: T[][] = [];
  for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n));
  return r;
}

const isSynth = (n: CanvasNode) => n.type === "consensus" || n.role === "consensus" || n.role === "synthesis";
const isHeader = (n: CanvasNode) => n.type === "entity_section" || n.role === "header";
const isSource = (n: CanvasNode) => n.type === "data_card";
const isExplain = (n: CanvasNode) => !isSynth(n) && !isHeader(n) && !isSource(n);

export function computeStructuredLayout(
  nodes: CanvasNode[],
  heights: Record<string, number> = {},
  edges: CanvasEdge[] = [],
): LayoutResult {
  // A recursive research tree is laid out hierarchically (depth rows, children
  // under parents); the baseline/atomic board keeps the kind-based bands.
  if (nodes.some((n) => n.role === "research")) return treeLayout(nodes, edges, heights);

  const positions: Record<string, Pos> = {};
  const bands: Band[] = [];
  // Prefer the real rendered height (measured once the card mounts) so bands pack
  // tightly to actual card sizes instead of a worst-case estimate.
  const H = (n: CanvasNode) => heights[n.id] ?? nodeHeight(n);

  const synth = nodes.filter(isSynth);
  const headers = nodes.filter(isHeader);
  const sources = nodes.filter(isSource);
  const explain = nodes.filter(isExplain);

  let y = ORIGIN_Y;

  // Centered fan-out band with wrapping (variable-width items).
  const placeFlow = (items: CanvasNode[]) => {
    const rows: CanvasNode[][] = [];
    let cur: CanvasNode[] = [], w = 0;
    for (const n of items) {
      const nw = nodeWidth(n) + FLOW_GAP;
      if (cur.length && w + nw > MAX_ROW_W) { rows.push(cur); cur = []; w = 0; }
      cur.push(n); w += nw;
    }
    if (cur.length) rows.push(cur);
    for (const row of rows) {
      const totalW = row.reduce((s, n) => s + nodeWidth(n), 0) + FLOW_GAP * (row.length - 1);
      let x = ORIGIN_X - totalW / 2;
      let rowH = 0;
      for (const n of row) {
        positions[n.id] = { x: Math.round(x), y };
        x += nodeWidth(n) + FLOW_GAP;
        rowH = Math.max(rowH, H(n));
      }
      y += rowH + ROW_GAP;
    }
  };

  // 1) Synthesis band (the answer) on top.
  if (synth.length) { bands.push({ label: "Synthesis", y }); placeFlow(synth); }

  // 2) Source columns: one column per entity/section (its header on top, its source
  //    cards stacked beneath), fanned across the row and wrapped past WRAP_COLS.
  const headerById: Record<string, CanvasNode> = {};
  for (const h of headers) headerById[h.id] = h;

  type Col = { header?: CanvasNode; sources: CanvasNode[] };
  const order: string[] = [];
  const bySection: Record<string, CanvasNode[]> = {};
  const columns: Col[] = [];
  for (const src of sources) {
    const key = src.section;
    if (!key) { columns.push({ sources: [src] }); continue; } // ungrouped source → own column
    if (!bySection[key]) { bySection[key] = []; order.push(key); }
    bySection[key].push(src);
  }
  const grouped = order.map((key) => ({ header: headerById[key], sources: bySection[key] }));
  for (const h of headers) if (!bySection[h.id]) grouped.push({ header: h, sources: [] });
  columns.unshift(...grouped);

  if (columns.length) {
    bands.push({ label: "Sources", y });
    for (const row of chunk(columns, WRAP_COLS)) {
      const totalW = row.length * COL_PITCH;
      const startX = ORIGIN_X - totalW / 2;
      const cellX = (i: number, w: number) => Math.round(startX + i * COL_PITCH + (COL_PITCH - w) / 2);

      let hdrH = 0;
      if (row.some((c) => c.header)) {
        row.forEach((c, i) => {
          if (!c.header) return;
          positions[c.header.id] = { x: cellX(i, nodeWidth(c.header)), y };
          hdrH = Math.max(hdrH, H(c.header));
        });
        y += hdrH + PAIR_GAP;
      }
      let colH = 0;
      row.forEach((c, i) => {
        let cy = y;
        for (const src of c.sources) {
          positions[src.id] = { x: cellX(i, nodeWidth(src)), y: cy };
          cy += H(src) + STACK_GAP;
        }
        colH = Math.max(colH, cy - STACK_GAP - y);
      });
      y += Math.max(colH, hdrH ? 0 : 40) + ROW_GAP;
    }
  }

  // 3) Explanations band (criteria, metrics, notes) at the bottom.
  if (explain.length) { bands.push({ label: "Explanations", y }); placeFlow(explain); }

  // Bounds (include the left label rail so fit-to-view keeps labels on-screen).
  let minX = LABEL_X, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const p = positions[n.id];
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x + nodeWidth(n));
    maxY = Math.max(maxY, p.y + H(n));
  }
  if (!isFinite(minY)) { minY = 0; maxX = 0; maxY = 0; }

  return { positions, bands, bounds: { minX, minY, maxX, maxY }, };
}

export const LAYOUT_LABEL_X = LABEL_X;

const SUBTREE_GAP = 70; // horizontal gap between sibling subtrees
const DEPTH_LABELS = ["Answer", "Research", "Detail"];

// Hierarchical layout for the recursive research tree: the synthesis (root) on
// top, research nodes in depth rows with children centered under their parent,
// and each leaf's finding cards in a ≤2-col grid beneath it.
function treeLayout(nodes: CanvasNode[], edges: CanvasEdge[], heights: Record<string, number>): LayoutResult {
  const positions: Record<string, Pos> = {};
  const H = (n: CanvasNode) => heights[n.id] ?? nodeHeight(n);
  const byId: Record<string, CanvasNode> = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const idx: Record<string, number> = Object.fromEntries(nodes.map((n, i) => [n.id, i]));

  const treeIds = new Set(nodes.filter((n) => n.role === "synthesis" || n.role === "research").map((n) => n.id));
  const rootId = nodes.find((n) => n.role === "synthesis")?.id ?? null;

  // parent (from derived_from), findings (from feeds). Edges may be partial mid-stream.
  const parentOf: Record<string, string> = {};
  const feedsUnder: Record<string, string[]> = {};
  for (const e of edges) {
    if (e.kind === "derived_from" && treeIds.has(e.from) && treeIds.has(e.to)) parentOf[e.from] = e.to;
    if (e.kind === "feeds" && treeIds.has(e.to) && byId[e.from]) (feedsUnder[e.to] ||= []).push(e.from);
  }

  // A research node with no wired parent yet falls under the root so it still renders.
  const effParent = (id: string): string | null => {
    const p = parentOf[id];
    if (p && treeIds.has(p) && p !== id) return p;
    return rootId && id !== rootId ? rootId : null;
  };
  const childrenOf: Record<string, string[]> = {};
  const roots: string[] = [];
  for (const id of treeIds) {
    const p = effParent(id);
    if (p === null) roots.push(id);
    else (childrenOf[p] ||= []).push(id);
  }
  const byIndex = (a: string, b: string) => idx[a] - idx[b];
  for (const k in childrenOf) childrenOf[k].sort(byIndex);
  roots.sort(byIndex);

  // subtree extents (post-order): a node's slot is as wide as the wider of its own
  // box (incl. its finding grid) and its children laid side by side.
  const gridCols = (id: string) => { const k = feedsUnder[id]?.length ?? 0; return k ? Math.min(k, 2) : 0; };
  const ownW = (id: string) => Math.max(nodeWidth(byId[id]), gridCols(id) * COL_PITCH);
  const ext: Record<string, number> = {};
  const computeExt = (id: string): number => {
    const kids = childrenOf[id] || [];
    if (!kids.length) return (ext[id] = ownW(id));
    const span = kids.reduce((s, c) => s + computeExt(c), 0) + SUBTREE_GAP * (kids.length - 1);
    return (ext[id] = Math.max(ownW(id), span));
  };
  for (const r of roots) computeExt(r);

  // x placement (pre-order): center each node over its children's group.
  const cx: Record<string, number> = {};
  const depthOf: Record<string, number> = {};
  const place = (id: string, left: number, depth: number) => {
    depthOf[id] = depth;
    const kids = childrenOf[id] || [];
    if (!kids.length) { cx[id] = left + ext[id] / 2; return; }
    const span = kids.reduce((s, c) => s + ext[c], 0) + SUBTREE_GAP * (kids.length - 1);
    let cl = left + (ext[id] - span) / 2;
    for (const c of kids) { place(c, cl, depth + 1); cl += ext[c] + SUBTREE_GAP; }
    cx[id] = (cx[kids[0]] + cx[kids[kids.length - 1]]) / 2;
  };
  let leftCursor = 0;
  for (const r of roots) { place(r, leftCursor, 0); leftCursor += ext[r] + SUBTREE_GAP; }

  // Height of a node's finding grid (≤2 cols) — so a node that carries its own
  // findings (e.g. the root's broad cards) reserves room above the next depth row.
  const gridHeight = (id: string): number => {
    const cards = feedsUnder[id];
    if (!cards?.length) return 0;
    const ordered = [...cards].sort(byIndex);
    const cols = Math.min(ordered.length, 2);
    const rows = Math.ceil(ordered.length / cols);
    let h = 0;
    for (let r = 0; r < rows; r++) {
      let rh = 0;
      for (let c = 0; c < cols; c++) { const fi = r * cols + c; if (fi >= ordered.length) break; rh = Math.max(rh, H(byId[ordered[fi]])); }
      h += rh + (r < rows - 1 ? STACK_GAP : 0);
    }
    return h;
  };

  // y per depth: the tallest (node + its own finding grid) on the previous row.
  const maxDepth = Math.max(0, ...Object.values(depthOf));
  const rowH: number[] = [];
  for (const id of treeIds) {
    const block = H(byId[id]) + (feedsUnder[id]?.length ? PAIR_GAP + gridHeight(id) : 0);
    rowH[depthOf[id]] = Math.max(rowH[depthOf[id]] ?? 0, block);
  }
  const rowY: number[] = [ORIGIN_Y];
  for (let d = 1; d <= maxDepth; d++) rowY[d] = rowY[d - 1] + (rowH[d - 1] ?? 160) + ROW_GAP;

  for (const id of treeIds) {
    positions[id] = { x: Math.round(cx[id] - nodeWidth(byId[id]) / 2), y: rowY[depthOf[id]] };
  }

  // finding grids beneath their leaf (≤2 cols, centered under the leaf).
  for (const id of treeIds) {
    const cards = feedsUnder[id];
    if (!cards?.length) continue;
    const ordered = [...cards].sort(byIndex);
    const cols = Math.min(ordered.length, 2);
    const startX = cx[id] - (cols * COL_PITCH) / 2;
    let gy = rowY[depthOf[id]] + H(byId[id]) + PAIR_GAP;
    for (let r = 0; r < Math.ceil(ordered.length / cols); r++) {
      let rh = 0;
      for (let c = 0; c < cols; c++) {
        const fi = r * cols + c;
        if (fi >= ordered.length) break;
        const card = byId[ordered[fi]];
        positions[card.id] = { x: Math.round(startX + c * COL_PITCH + (COL_PITCH - nodeWidth(card)) / 2), y: Math.round(gy) };
        rh = Math.max(rh, H(card));
      }
      gy += rh + STACK_GAP;
    }
  }

  // recenter horizontally on ORIGIN_X and clamp so nothing crosses the label rail.
  let minX = Infinity, maxX = -Infinity;
  for (const id in positions) {
    const n = byId[id]; if (!n) continue;
    minX = Math.min(minX, positions[id].x);
    maxX = Math.max(maxX, positions[id].x + nodeWidth(n));
  }
  if (isFinite(minX)) {
    let dx = ORIGIN_X - (minX + maxX) / 2;
    if (minX + dx < LABEL_X + 40) dx = LABEL_X + 40 - minX;
    for (const id in positions) positions[id] = { x: positions[id].x + dx, y: positions[id].y };
  }

  // Left "Web sources" column: stack role:"source" nodes to the left of the tree.
  // Placed AFTER the recenter so they aren't shifted; before bounds so fit-to-view frames them.
  const sourceNodes = nodes.filter((n) => n.role === "source").sort((a, b) => idx[a.id] - idx[b.id]);
  if (sourceNodes.length) {
    let treeMinX = Infinity;
    for (const id in positions) treeMinX = Math.min(treeMinX, positions[id].x);
    if (!isFinite(treeMinX)) treeMinX = ORIGIN_X;
    const colW = nodeWidth(sourceNodes[0]);
    const colX = Math.round(treeMinX - colW - 140);
    let sy = ORIGIN_Y;
    for (const n of sourceNodes) {
      positions[n.id] = { x: colX, y: Math.round(sy) };
      sy += H(n) + STACK_GAP;
    }
  }

  const bands: Band[] = [];
  const depthsPresent = new Set(Object.values(depthOf));
  for (let d = 0; d <= maxDepth; d++) if (depthsPresent.has(d)) bands.push({ label: DEPTH_LABELS[d] ?? `Level ${d}`, y: rowY[d] });

  let bMinX = LABEL_X, bMinY = Infinity, bMaxX = -Infinity, bMaxY = -Infinity;
  for (const n of nodes) {
    const p = positions[n.id]; if (!p) continue;
    bMinX = Math.min(bMinX, p.x); bMinY = Math.min(bMinY, p.y);
    bMaxX = Math.max(bMaxX, p.x + nodeWidth(n)); bMaxY = Math.max(bMaxY, p.y + H(n));
  }
  if (!isFinite(bMinY)) { bMinY = 0; bMaxX = 0; bMaxY = 0; }

  return { positions, bands, bounds: { minX: bMinX, minY: bMinY, maxX: bMaxX, maxY: bMaxY } };
}

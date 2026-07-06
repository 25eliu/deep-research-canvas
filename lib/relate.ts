import Graph from "graphology";
import type { CanvasState, CanvasEdge, CanvasOp } from "./schema";
import { applyOps } from "./schema";

// Deterministic structural edges: evidence -> consensus (feeds),
// same-metric across entities (sibling). Semantic supports/contradicts are LLM-authored.
export function structuralEdges(state: CanvasState): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  const consensus = state.nodes.find((n) => n.type === "consensus");
  if (consensus) {
    for (const n of state.nodes) {
      if (n.role === "evidence" || (n.type === "data_card" && n.section)) {
        edges.push({ id: `feeds:${n.id}->${consensus.id}`, from: n.id, to: consensus.id, kind: "feeds" });
      }
    }
  }
  // sibling: same metric label across sections
  const metrics = state.nodes.filter((n) => n.type === "metric" && n.metric?.label);
  const byLabel: Record<string, string[]> = {};
  for (const m of metrics) {
    const key = (m.metric!.label).toLowerCase();
    (byLabel[key] ||= []).push(m.id);
  }
  for (const ids of Object.values(byLabel)) {
    const sorted = [...ids].sort();
    for (let i = 0; i + 1 < sorted.length; i++) {
      edges.push({ id: `sibling:${sorted[i]}~${sorted[i + 1]}`, from: sorted[i], to: sorted[i + 1], kind: "sibling" });
    }
  }
  return edges;
}

// Returns true if `target` is reachable from `source` by following directed
// edges already present in `g` (i.e. adding source->target would close a cycle).
function isReachable(g: Graph, source: string, target: string): boolean {
  if (source === target) return true;
  const visited = new Set<string>([source]);
  const stack = [source];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const next of g.outboundNeighbors(current)) {
      if (next === target) return true;
      if (!visited.has(next)) {
        visited.add(next);
        stack.push(next);
      }
    }
  }
  return false;
}

// Dedupe by id, drop edges to/from missing nodes, drop self-loops, cap fan-in per
// target (anti-hairball), and reject edges that would close a directed cycle.
// graphology is the working graph: edges are added to it as they're accepted, and
// both in-degree and cycle checks are queried from it.
export function validateGraph(state: CanvasState, opts: { maxDegree?: number } = {}): CanvasState {
  const maxDegree = opts.maxDegree ?? 12;
  const g = new Graph({ multi: false, type: "directed", allowSelfLoops: false });
  const nodeIds = new Set(state.nodes.map((n) => n.id));
  for (const id of nodeIds) g.addNode(id);

  const seen = new Set<string>();
  const kept: CanvasEdge[] = [];
  for (const e of state.edges) {
    if (seen.has(e.id)) continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    if (e.from === e.to) continue;
    if (g.inDegree(e.to) >= maxDegree) continue;
    if (isReachable(g, e.to, e.from)) continue; // would close a cycle
    seen.add(e.id);
    g.addEdge(e.from, e.to);
    kept.push(e);
  }
  return { nodes: state.nodes, edges: kept };
}

// Post-process an agent's ops: preview the resulting board, append the structural
// edges the model didn't emit, then drop any add_edge the validation rejects.
// Deterministic — code owns structure; the model only owns semantic edges.
export function finalizeOps(state: CanvasState, ops: CanvasOp[]): CanvasOp[] {
  const preview = applyOps(state, ops);
  const existing = new Set(preview.edges.map((e) => e.id));
  const structural = structuralEdges(preview).filter((e) => !existing.has(e.id));
  const withStructural: CanvasOp[] = [
    ...ops,
    ...structural.map((edge) => ({ op: "add_edge" as const, edge })),
  ];
  const validated = validateGraph(applyOps(state, withStructural));
  const keptEdges = new Set(validated.edges.map((e) => e.id));
  return withStructural.filter((o) => o.op !== "add_edge" || keptEdges.has(o.edge.id));
}

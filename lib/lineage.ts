import type { CanvasEdge } from "./schema";

// Hierarchy lives entirely in the edges array (nodes carry no parentId), matching
// treeLayout in lib/layout.ts:
//   derived_from: child → parent (e.from is the child)
//   feeds:        finding card → the research node it belongs under (e.from is the card)
// supports/contradicts/sibling are lateral relations, not hierarchy.
const HIERARCHY_KINDS = new Set(["derived_from", "feeds"]);

function walk(start: string, adjacency: Map<string, string[]>): Set<string> {
  const out = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of adjacency.get(id) ?? []) {
      if (next === start || out.has(next)) continue; // visited set guards cycles
      out.add(next);
      stack.push(next);
    }
  }
  return out;
}

/** All descendants of `nodeId` (children and their subtrees, plus finding cards). Excludes `nodeId`. */
export function getDescendants(nodeId: string, edges: CanvasEdge[]): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!HIERARCHY_KINDS.has(e.kind)) continue;
    const kids = childrenOf.get(e.to);
    if (kids) kids.push(e.from);
    else childrenOf.set(e.to, [e.from]);
  }
  return walk(nodeId, childrenOf);
}

/** All ancestors of `nodeId` (parent chain up to the root). Excludes `nodeId`. */
export function getAncestors(nodeId: string, edges: CanvasEdge[]): Set<string> {
  const parentsOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!HIERARCHY_KINDS.has(e.kind)) continue;
    const parents = parentsOf.get(e.from);
    if (parents) parents.push(e.to);
    else parentsOf.set(e.from, [e.to]);
  }
  return walk(nodeId, parentsOf);
}

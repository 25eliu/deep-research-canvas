import type { AgentRequest, CanvasNode } from "../../schema";
import { retrieveNodes, nodeContentBlock } from "./retrieval";
import { getAncestors, getDescendants } from "../../lineage";

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

// Front-facing one-liner: id, type/role, title, section, summary — NO chart points,
// CSV, consensus rows, or report bodies. The light map the RESEARCH planner reasons over.
function frontFacing(n: CanvasNode): string {
  const head = `[#${n.id} · ${n.type}${n.role ? `/${n.role}` : ""}] ${n.title}`;
  const bits = [head];
  if (n.section) bits.push(`section: ${n.section}`);
  if (n.summary) bits.push(n.summary);
  return bits.join("\n");
}

// Context for the RESEARCH (additive-tree) planner — deliberately lighter than
// ctxBlock so a full board never floods the prompt.
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
    // The selection's WHOLE tree(s): walk up to each root (topmost ancestor), then
    // take every descendant of that root — so siblings and cousins are included, not
    // just the selected node's own ancestors/descendants.
    const scope = new Set<string>(ids);
    for (const id of ids) {
      const ancestors = getAncestors(id, edges);
      const roots = [id, ...ancestors].filter((a) => getAncestors(a, edges).size === 0);
      for (const root of roots) {
        scope.add(root);
        for (const d of getDescendants(root, edges)) scope.add(d);
      }
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

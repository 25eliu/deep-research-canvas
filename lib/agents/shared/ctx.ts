import type { AgentRequest } from "../../schema";
import { retrieveNodes, nodeContentBlock } from "./retrieval";

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

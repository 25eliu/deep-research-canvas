import type { AgentRequest } from "../../schema";

export function ctxBlock(req: AgentRequest): string {
  const nodes = req.canvasState.nodes.map((n) => ({
    id: n.id, type: n.type, section: n.section, role: n.role, title: n.title, grounding: n.grounding,
  }));
  return [
    `MESSAGE: ${req.message}`,
    `SURFACE: ${req.surface}`,
    `SELECTION: ${JSON.stringify(req.selection?.nodeIds || [])}`,
    `CURRENT_NODES: ${JSON.stringify(nodes)}`,
    `CURRENT_EDGES: ${JSON.stringify(req.canvasState.edges)}`,
  ].join("\n");
}

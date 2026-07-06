// Shared scene-graph contract. Backend emits ops; frontend applies them.

import { z } from "zod";

export const zGrounding = z.enum(["tako", "model", "web"]);
export const zNodeType = z.enum([
  "entity_section", "data_card", "metric", "criteria", "consensus", "text",
]);
export const zEdgeKind = z.enum([
  "feeds", "supports", "contradicts", "derived_from", "sibling",
]);

export const zChartSpec = z.object({
  kind: z.enum(["bar", "line"]),
  unit: z.string().optional(),
  series: z.array(z.object({
    label: z.string(),
    points: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })),
  })),
});

export const zTakoRef = z.object({
  cardId: z.string(),
  embedUrl: z.string().optional(),
  imageUrl: z.string().optional(),
  webpageUrl: z.string().optional(),
  source: z.string().optional(),
  asOf: z.string().optional(),
});

export const zConsensusRow = z.object({
  rank: z.number(),
  entity: z.string(),
  score: z.number().optional(),
  note: z.string().optional(),
});

export const zCanvasNode = z.object({
  id: z.string(),
  type: zNodeType,
  section: z.string().optional(),
  role: z.enum(["header", "evidence", "criteria", "consensus", "note"]).optional(),
  rank: z.number().nullable().optional(),
  title: z.string(),
  summary: z.string().optional(),
  tako: zTakoRef.optional(),
  chartSpec: zChartSpec.optional(),
  metric: z.object({ value: z.string(), label: z.string(), delta: z.string().optional() }).optional(),
  criteria: z.object({ weights: z.record(z.number()) }).optional(),
  consensusRows: z.array(zConsensusRow).optional(),
  grounding: zGrounding,
  confidence: z.number(),
  position: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});

export const zCanvasEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: zEdgeKind,
  label: z.string().optional(),
});

export const zCanvasOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: zCanvasNode }),
  z.object({ op: z.literal("upsert_node"), node: zCanvasNode }),
  z.object({ op: z.literal("update_node"), id: z.string(), patch: zCanvasNode.partial() }),
  z.object({ op: z.literal("remove_node"), id: z.string(), cascade: z.boolean().optional() }),
  z.object({ op: z.literal("add_edge"), edge: zCanvasEdge }),
  z.object({ op: z.literal("move_node"), id: z.string(), position: z.object({ x: z.number(), y: z.number() }) }),
  z.object({ op: z.literal("recompute_consensus"), target: z.string() }),
]);
export const zCanvasOps = z.array(zCanvasOp);

export type Grounding = z.infer<typeof zGrounding>;
export type NodeType = z.infer<typeof zNodeType>;
export type EdgeKind = z.infer<typeof zEdgeKind>;
export type ChartSpec = z.infer<typeof zChartSpec>;
export type TakoRef = z.infer<typeof zTakoRef>;
export type ConsensusRow = z.infer<typeof zConsensusRow>;
export type CanvasNode = z.infer<typeof zCanvasNode>;
export type CanvasEdge = z.infer<typeof zCanvasEdge>;
export type CanvasOp = z.infer<typeof zCanvasOp>;

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type ProviderId = "gpt" | "claude" | "tako";

export interface AgentRequest {
  canvasId: string;
  message: string;
  surface: "main" | "side_chat";
  canvasState: CanvasState;
  selection?: { nodeIds: string[]; nodes: Partial<CanvasNode>[] };
  providerId: ProviderId;
  takoAnswerEnabled?: boolean;
}

// TurnTrace is defined in lib/agents/shared/types.ts to keep this file dependency-free.
export interface AgentResponse {
  canvasOps: CanvasOp[];
  narration: string;
  sideReply: string | null;
  // TODO: replace with TurnTrace once agents/shared/types exists (Task 9)
  trace?: unknown;
  debug?: unknown;
}

// Apply ops to a state immutably (used client-side).
export function applyOps(state: CanvasState, ops: CanvasOp[]): CanvasState {
  let nodes = [...state.nodes];
  let edges = [...state.edges];
  for (const op of ops) {
    switch (op.op) {
      case "add_node":
      case "upsert_node": {
        const i = nodes.findIndex((n) => n.id === op.node.id);
        if (i >= 0) nodes[i] = { ...nodes[i], ...op.node };
        else nodes.push(op.node);
        break;
      }
      case "update_node": {
        const i = nodes.findIndex((n) => n.id === op.id);
        if (i >= 0) nodes[i] = { ...nodes[i], ...op.patch };
        break;
      }
      case "remove_node": {
        nodes = nodes.filter((n) => n.id !== op.id);
        if (op.cascade) edges = edges.filter((e) => e.from !== op.id && e.to !== op.id);
        break;
      }
      case "move_node": {
        const i = nodes.findIndex((n) => n.id === op.id);
        if (i >= 0) nodes[i] = { ...nodes[i], position: op.position };
        break;
      }
      case "add_edge": {
        if (!edges.some((e) => e.id === op.edge.id)) edges.push(op.edge);
        break;
      }
      case "recompute_consensus":
        // Deterministic recompute is a frontend/app concern; left as a no-op hook.
        break;
    }
  }
  return { nodes, edges };
}

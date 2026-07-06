// Shared scene-graph contract. Backend emits ops; frontend applies them.

export type NodeType =
  | "entity_section"
  | "data_card"
  | "metric"
  | "criteria"
  | "consensus"
  | "text";

export type Grounding = "tako" | "model" | "web";

export interface ChartSpec {
  kind: "bar" | "line";
  unit?: string;
  series: { label: string; points: { x: string | number; y: number }[] }[];
}

export interface TakoRef {
  cardId: string;
  embedUrl?: string;
  imageUrl?: string;
  webpageUrl?: string;
  source?: string;
  asOf?: string;
}

export interface ConsensusRow {
  rank: number;
  entity: string;
  score?: number;
  note?: string;
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  section?: string;
  role?: "header" | "evidence" | "criteria" | "consensus" | "note";
  rank?: number | null;
  title: string;
  summary?: string;
  tako?: TakoRef;               // present only for grounding === "tako"
  chartSpec?: ChartSpec;        // model-drawn chart (baselines)
  metric?: { value: string; label: string; delta?: string };
  criteria?: { weights: Record<string, number> };
  consensusRows?: ConsensusRow[];
  grounding: Grounding;
  confidence: number;           // 0..1
  position?: { x: number; y: number } | null;
}

export type EdgeKind = "feeds" | "supports" | "contradicts" | "derived_from" | "sibling";

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  label?: string;
}

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type CanvasOp =
  | { op: "add_node"; node: CanvasNode }
  | { op: "upsert_node"; node: CanvasNode }
  | { op: "update_node"; id: string; patch: Partial<CanvasNode> }
  | { op: "remove_node"; id: string; cascade?: boolean }
  | { op: "add_edge"; edge: CanvasEdge }
  | { op: "move_node"; id: string; position: { x: number; y: number } }
  | { op: "recompute_consensus"; target: string };

export interface AgentRequest {
  canvasId: string;
  message: string;
  surface: "main" | "side_chat";
  canvasState: CanvasState;
  selection?: { nodeIds: string[]; nodes: Partial<CanvasNode>[] };
  providerId: "gpt" | "claude" | "gpt_tako" | "claude_tako";
  takoAnswerEnabled?: boolean;
}

export interface AgentResponse {
  canvasOps: CanvasOp[];
  narration: string;
  sideReply: string | null;
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

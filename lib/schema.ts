// Shared scene-graph contract. Backend emits ops; frontend applies them.

import { z } from "zod";
import { computeConsensusRows } from "./consensus";

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

// Graphy hero chart. `config` is the exact shape @graphysdk/core's GraphProvider
// consumes: first column = x/category axis, remaining columns = series. Emitted by
// a dedicated post-compose LLM call (lib/agents/tako/graphy.ts) — NEVER by the
// report composer (see zAnswerReportEmit below). Numbers are enforced traceable to
// this turn's fetched Tako card CSVs before this reaches the client.
export const zGraphyColumn = z.object({ key: z.string(), label: z.string() });
export const zGraphyConfig = z.object({
  type: z.enum(["bar", "column", "line", "area", "pie", "donut", "scatter"]),
  data: z.object({
    columns: z.array(zGraphyColumn).min(2),
    rows: z.array(z.record(z.union([z.string(), z.number()]))).min(1).max(60),
  }),
});
export const zGraphyBlock = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  config: zGraphyConfig,
});

export const zTakoRef = z.object({
  cardId: z.string(),
  embedUrl: z.string().optional(),
  imageUrl: z.string().optional(),
  webpageUrl: z.string().optional(),
  source: z.string().optional(),
  asOf: z.string().optional(),
});

// A citation attached to a data-bearing node. For baseline (gpt/claude) cards these
// are the live web-search results the figures came from; sanitize guarantees every
// url here was actually retrieved this turn (no model-invented URLs).
export const zNodeSource = z.object({
  url: z.string(),
  title: z.string().optional(),
});

export const zConsensusRow = z.object({
  rank: z.number(),
  entity: z.string(),
  score: z.number().optional(),
  note: z.string().optional(),
});

// The composed final-answer "report": an ordered list of representation blocks
// (prose / comparison table / chart / stat tiles) chosen by the final layer.
// Attached to the synthesis node as `report`. Numbers are validated against real
// gathered figures before this is emitted (see lib/agents/tako/compose.ts).
export const zAnswerBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prose"), md: z.string() }),
  z.object({ kind: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ kind: z.literal("chart"), title: z.string().optional(), chartSpec: zChartSpec }),
  z.object({ kind: z.literal("tiles"), tiles: z.array(z.object({ label: z.string(), value: z.string(), delta: z.string().optional() })) }),
  // Multi-entity comparison built from REAL card CSVs (composer fetches via get_card_contents).
  z.object({
    kind: z.literal("comparison"),
    title: z.string().optional(),
    unit: z.string().optional(),
    series: z.array(z.object({
      label: z.string(),
      entity: z.string(),
      points: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })),
    })).min(1),
    insight: z.string().optional(),
  }),
  // Ranked entities for "top XYZ" questions; detail = expandable row body.
  z.object({
    kind: z.literal("leaderboard"),
    title: z.string().optional(),
    metricLabel: z.string(),
    rows: z.array(z.object({
      rank: z.number(),
      entity: z.string(),
      value: z.string(),
      delta: z.string().optional(),
      detail: z.object({
        md: z.string(),
        stats: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      }).optional(),
    })).min(1),
  }),
  // One titled section per factor/driver for "what's affecting X" questions.
  z.object({
    kind: z.literal("sections"),
    sections: z.array(z.object({
      title: z.string(),
      md: z.string(),
      figure: z.object({ label: z.string(), value: z.string(), delta: z.string().optional() }).optional(),
      chartSpec: zChartSpec.optional(),
    })).min(1),
  }),
  // Dated milestones for "how did X evolve" questions.
  z.object({
    kind: z.literal("timeline"),
    events: z.array(z.object({
      date: z.string(),
      title: z.string(),
      md: z.string().optional(),
      value: z.string().optional(),
    })).min(1),
  }),
]);
// Emit schema (what the report-composer LLM is allowed to produce) vs full report
// (what the synthesis node carries). `graphy` is attached server-side AFTER
// composition by composeGraphyHero — keeping it out of the emit schema means the
// composer model can never invent a graphy block on its own.
export const zAnswerReportEmit = z.object({ verdict: z.string(), blocks: z.array(zAnswerBlock) });
export const zAnswerReport = zAnswerReportEmit.extend({ graphy: zGraphyBlock.optional() });

export const zCanvasNode = z.object({
  id: z.string(),
  type: zNodeType,
  section: z.string().optional(),
  role: z.enum(["header", "evidence", "criteria", "consensus", "note", "synthesis", "research", "source"]).optional(),
  rank: z.number().nullable().optional(),
  title: z.string(),
  summary: z.string().optional(),
  tako: zTakoRef.optional(),
  sources: z.array(zNodeSource).optional(),
  searches: z.array(z.string()).optional(), // Tako search queries this research/synthesis node ran
  chartSpec: zChartSpec.optional(),
  metric: z.object({ value: z.string(), label: z.string(), delta: z.string().optional() }).optional(),
  criteria: z.object({ weights: z.record(z.number()) }).optional(),
  consensusRows: z.array(zConsensusRow).optional(),
  report: zAnswerReport.optional(), // composed multi-block final answer (synthesis node)
  gapFill: z.boolean().optional(), // research node minted by the post-tree gap-fill round
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
export type NodeSource = z.infer<typeof zNodeSource>;
export type ConsensusRow = z.infer<typeof zConsensusRow>;
export type AnswerBlock = z.infer<typeof zAnswerBlock>;
export type AnswerReport = z.infer<typeof zAnswerReport>;
export type GraphyConfig = z.infer<typeof zGraphyConfig>;
export type GraphyBlock = z.infer<typeof zGraphyBlock>;
export type CanvasNode = z.infer<typeof zCanvasNode>;
export type CanvasEdge = z.infer<typeof zCanvasEdge>;
export type CanvasOp = z.infer<typeof zCanvasOp>;

export interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export type ProviderId = "gpt" | "claude" | "tako" | "tako-search";

export interface ChatTurn {
  id: string;
  role: "user" | "agent";
  text: string;
  surface: "main" | "side_chat";
  focus?: string[];
}

export interface AgentRequest {
  canvasId: string;
  message: string;
  surface: "main" | "side_chat";
  canvasState: CanvasState;
  selection?: { nodeIds: string[]; nodes: Partial<CanvasNode>[] };
  providerId: ProviderId;
  takoAnswerEnabled?: boolean;
  graphyEnabled?: boolean; // per-turn "graphy chart" toggle → hero Graphy chart on the report
  history?: ChatTurn[];
  historySummary?: string;
}

// TurnTrace is defined in lib/agents/shared/types.ts to keep this file dependency-free.
export interface AgentResponse {
  canvasOps: CanvasOp[];
  narration: string;
  sideReply: string | null;
  trace?: import("./agents/shared/types").TurnTrace;
  memory?: { summary?: string; summarizedThrough?: string };
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
      case "recompute_consensus": {
        const rows = computeConsensusRows({ nodes, edges }, op.target);
        const i = nodes.findIndex((n) => n.id === op.target);
        if (i >= 0) nodes[i] = { ...nodes[i], consensusRows: rows };
        break;
      }
    }
  }
  return { nodes, edges };
}

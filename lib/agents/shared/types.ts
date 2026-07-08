import type { ProviderId, CanvasOp } from "../../schema";

export type RouteAction = "NEW_BOARD" | "REPLACE" | "AUGMENT" | "REFRAME" | "EXPLAIN";

// Per-stage wall-clock (ms). Every field optional so partial runs still record.
// In the recursive pipeline, graph/search/stream are parallel maxima, not sums.
export interface Timings {
  breakdown?: number;
  decompose?: number;
  graph?: number;
  search?: number;
  structure?: number;
  stream?: number;
  finalize?: number;
  total: number;
}

// One individually-traceable Tako HTTP call. Recorded on the research node that
// issued it (so the query → cards → node linkage survives) and mirrored live via
// a "tako_call" event. callId = `${nodeId}:${seq}` — stable within a turn; JS is
// single-threaded so the seq counter is race-free even under Promise.allSettled.
export interface TakoCallRecord {
  callId: string;
  nodeId: string;
  query: string;
  endpoint: "/v3/search" | "/v1/answer" | "/v1/contents";
  effort: "fast" | "instant";
  web?: boolean;
  ms: number;
  cards: { id: string; title: string; source?: string; url?: string }[];
  error?: string; // present instead of cards when the call failed
}

// One raw Tako GRAPH API call (search or related), captured verbatim for the trace's
// drill-down: the exact request params as sent and the (compacted) response items.
export interface GraphCallRecord {
  endpoint: "graph/search" | "graph/related";
  params: { q?: string; types?: string; subtype?: string; node_id?: string; relation_type?: string; limit?: number };
  ms: number;
  results: { id?: string; name: string; type?: string; subtype?: string; aliases?: string[]; description?: string }[];
  error?: string; // present (with results []) when the call failed
}

// One node of the research tree, for trace/debug visibility.
export interface TraceTreeNode {
  nodeId: string;
  depth: number;
  question: string;
  kind: "branch" | "leaf";
  findingCount: number;
  children: string[];
  queries?: string[]; // Tako search queries this node ran
  rationale?: string; // LLM reasoning that produced this node's plan
  entities?: string[]; // entities this (sub)question was decomposed to (drive the queries)
  metrics?: string[]; // metrics this (sub)question targets
  // What the Tako graph actually resolved for this node: each entity → the related
  // metric names the graph has for it (from graphSearch + graphRelated), plus an
  // optional kind:"metric" row for standalone series the metric-typed search found.
  graph?: { entity: string; related: string[]; kind?: "entity" | "metric" }[];
  calls?: TakoCallRecord[]; // every Tako call this node issued (query→cards linkage)
  graphCalls?: GraphCallRecord[]; // every raw graph API call this node issued (params + response)
  graphMs?: number; // wall-clock ms of this node's whole graph phase (search + related + discovery)
  gapFill?: boolean; // minted by the gap-fill round (renders with a badge)
}

export interface TurnTrace {
  action: RouteAction;
  provider: ProviderId;
  graph?: { resolved: { query: string; node: string }[]; related: { node: string; items: string[] }[] };
  queries: string[];
  answerUsed?: boolean;
  cards: { id: string; title: string; url: string }[];
  opsApplied: number;
  notes: string[];
  ms: number;
  timings?: Timings;
  tree?: TraceTreeNode[];
  // Flat authoritative views derived from the tree (the tree-less followup path
  // fills these directly, since it has no research tree).
  calls?: TakoCallRecord[];
  reasoning?: { nodeId: string; question: string; rationale: string }[];
  // Which board nodes / Tako grounding actually fed this turn's answer.
  groundedIn?: {
    nodes: { id: string; title: string }[];
    takoAnswerUsed: boolean;
    cards: { id: string; title: string; url: string }[];
  };
}

// What a Tako sub-pipeline (initial / followup) returns to the agent. Node ops
// have already been streamed via emit; the agent finalizes them (structural
// edges) and returns the authoritative full set in the result.
export interface PipelineResult {
  nodeOps: import("../../schema").CanvasOp[];
  narration: string;
  sideReply: string | null;
  validCardIds: Set<string>; // real Tako cardIds fetched this turn
  allowedNodeIds: Set<string>; // provenance: every node id that may exist (sections + findings)
  trace: Partial<TurnTrace>;
}

// Events the pipeline streams up to the route as it runs.
export type AgentEvent =
  | { type: "trace"; stage: string; note?: string }
  | { type: "ops"; ops: CanvasOp[] }
  // nodeId present → the token streams into that canvas node's summary (the
  // Synthesis block); absent → the token grows a chat message (follow-ups).
  | { type: "token"; text: string; nodeId?: string }
  // A live LLM reasoning step, fired once per research node after the
  // branch-vs-atomic decision is made.
  | {
      type: "reasoning";
      nodeId: string;
      depth: number;
      question: string;
      kind: "branch" | "leaf" | "gap";
      rationale?: string;
      entities?: string[]; // entities this (sub)question decomposed to
      metrics?: string[]; // metrics it targets
      subQuestions?: string[]; // present when branching
    }
  // A per-sub-query Tako call, individually traceable, keyed by nodeId.
  | { type: "tako_call"; call: TakoCallRecord }
  // A raw graph API call (search/related), streamed live so the trace shows graph
  // activity per node while the run is in flight (the tree copy lands post-run).
  | { type: "graph_call"; nodeId: string; call: GraphCallRecord }
  // Synthesis brackets — which findings/children feed a node's answer.
  | {
      type: "synthesis";
      phase: "start" | "end";
      nodeId: string;
      kind: "root" | "branch" | "leaf";
      inputs?: { fromNodeIds?: string[]; findingTitles?: string[] }; // start only
    };

export type EmitFn = (e: AgentEvent) => void;

// Back-compat: a trace-only callback. Prefer EmitFn in new code.
export type TraceFn = (step: { stage: string; note?: string; data?: unknown }) => void;

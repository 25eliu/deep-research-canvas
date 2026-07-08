// Client-side trace view model + helpers. Single home for the types the chat
// trace UI renders, plus the transforms that (a) turn the flat authoritative
// wire trace into a nested render tree, (b) build a live render list from
// streamed steps, and (c) slim a trace for localStorage persistence.
//
// Depends only on the shared wire types (pure interfaces — safe in the client
// bundle). sessions.ts imports FROM here; this file imports nothing from there,
// so there is no import cycle.
import type { TurnTrace, TraceTreeNode, TakoCallRecord, GraphCallRecord } from "./agents/shared/types";

export type { TurnTrace, TraceTreeNode, TakoCallRecord, GraphCallRecord };

export type Grounding = "tako" | "model" | "web";

// A card as shown in the trace (subset of a TakoCallRecord card).
export interface TraceCard {
  id: string;
  title: string;
  source?: string;
  url?: string;
}

// A nested research-tree node for rendering. Built from the flat wire tree
// (whose `children` are id refs) or, live, one-per-reasoning-step (children []).
export interface TraceNodeView {
  nodeId: string;
  depth: number;
  question: string;
  kind: "branch" | "leaf" | "gap";
  rationale?: string;
  entities: string[]; // what this (sub)question decomposed to
  metrics: string[];
  graph: { entity: string; related: string[]; kind?: "entity" | "metric" }[]; // what the Tako graph actually resolved
  findingCount: number;
  queries: string[];
  calls: TakoCallRecord[];
  graphCalls: GraphCallRecord[]; // raw graph API calls (params + response) for drill-down
  graphMs?: number; // wall-clock of the node's graph phase
  children: TraceNodeView[];
  synthesizing?: boolean; // live only: synthesis in progress for this node
  gapFill?: boolean;
}

// Live steps accumulated from streamed events before the authoritative trace lands.
export type LiveStep =
  | { t: "reasoning"; nodeId: string; depth: number; question: string; kind: "branch" | "leaf" | "gap"; rationale?: string; entities?: string[]; metrics?: string[]; subQuestions?: string[] }
  | { t: "tako"; call: TakoCallRecord }
  | { t: "synth"; nodeId: string; phase: "start" | "end" };

// Classify where a card came from, for the grounding dot. Trace cards always come
// from a Tako call; a card with a real source reads as Tako-grounded (emerald),
// one without as web-grounded (slate). Model-drawn cards never appear in a trace.
export function groundingOf(card: TraceCard): Grounding {
  return card.source ? "tako" : "web";
}

// Normalized provenance for the "Grounded in" trace block. Always well-formed so
// the UI can render unconditionally.
export function groundedInOf(trace: TurnTrace | undefined): {
  nodes: { id: string; title: string }[];
  takoAnswerUsed: boolean;
  cards: TraceCard[];
} {
  const g = trace?.groundedIn;
  return {
    nodes: g?.nodes ?? [],
    takoAnswerUsed: g?.takoAnswerUsed ?? false,
    cards: g?.cards ?? [],
  };
}

// Nest the flat authoritative tree (children = id refs) into render roots.
// Roots are nodes no other node lists as a child (the synth node, depth 0).
export function buildTree(flat: TraceTreeNode[] | undefined): TraceNodeView[] {
  if (!flat?.length) return [];
  const byId = new Map<string, TraceTreeNode>();
  for (const n of flat) byId.set(n.nodeId, n);
  const childIds = new Set<string>();
  for (const n of flat) for (const c of n.children) childIds.add(c);

  const toView = (n: TraceTreeNode): TraceNodeView => ({
    nodeId: n.nodeId,
    depth: n.depth,
    question: n.question,
    kind: n.kind,
    rationale: n.rationale,
    entities: n.entities ?? [],
    metrics: n.metrics ?? [],
    graph: n.graph ?? [],
    findingCount: n.findingCount,
    queries: n.queries ?? [],
    calls: n.calls ?? [],
    graphCalls: n.graphCalls ?? [],
    graphMs: n.graphMs,
    children: n.children.map((id) => byId.get(id)).filter(Boolean).map((c) => toView(c!)),
    gapFill: n.gapFill,
  });

  return flat.filter((n) => !childIds.has(n.nodeId)).map(toView);
}

// Build a flat, arrival-ordered render list from live steps. Each reasoning step
// mints a node; tako/synth steps attach to the matching node by nodeId. Rendered
// depth-indented (children stay [] — the nested tree only exists once finalized).
export function stepsToDisplay(steps: LiveStep[] | undefined): TraceNodeView[] {
  if (!steps?.length) return [];
  const order: string[] = [];
  const byId = new Map<string, TraceNodeView>();

  const ensure = (nodeId: string, seed?: Partial<TraceNodeView>): TraceNodeView => {
    let v = byId.get(nodeId);
    if (!v) {
      v = {
        nodeId, depth: seed?.depth ?? 0, question: seed?.question ?? "", kind: seed?.kind ?? "leaf",
        rationale: seed?.rationale, entities: [], metrics: [], graph: [], findingCount: 0, queries: [], calls: [], graphCalls: [], children: [],
      };
      byId.set(nodeId, v);
      order.push(nodeId);
    }
    return v;
  };

  for (const s of steps) {
    if (s.t === "reasoning") {
      const v = ensure(s.nodeId, s);
      v.depth = s.depth; v.question = s.question; v.kind = s.kind; v.rationale = s.rationale;
      if (s.entities?.length) v.entities = s.entities;
      if (s.metrics?.length) v.metrics = s.metrics;
    } else if (s.t === "tako") {
      const v = ensure(s.call.nodeId);
      // idempotent by callId (a call may be observed once; guard anyway)
      if (!v.calls.some((c) => c.callId === s.call.callId)) v.calls.push(s.call);
      v.findingCount = v.calls.reduce((sum, c) => sum + c.cards.length, 0);
      for (const q of [s.call.query]) if (!v.queries.includes(q)) v.queries.push(q);
    } else if (s.t === "synth") {
      const v = ensure(s.nodeId);
      v.synthesizing = s.phase === "start";
    }
  }

  return order.map((id) => byId.get(id)!);
}

// The render tree for an authoritative trace: the nested tree when present, else
// a flat synthesis from the flat calls/reasoning lists (e.g. a zero-finding turn
// whose tree nodes were all pruned — its calls still deserve to be shown).
export function traceToDisplay(trace: TurnTrace): TraceNodeView[] {
  const nested = buildTree(trace.tree);
  if (nested.length) return nested;
  const steps: LiveStep[] = [];
  for (const r of trace.reasoning ?? []) steps.push({ t: "reasoning", nodeId: r.nodeId, depth: 0, question: r.question, kind: "leaf", rationale: r.rationale });
  for (const c of trace.calls ?? []) steps.push({ t: "tako", call: c });
  return stepsToDisplay(steps);
}

// Count every Tako call across a (possibly nested) trace for the header/footer.
export function countCalls(trace: TurnTrace | undefined): number {
  if (!trace) return 0;
  if (trace.calls?.length) return trace.calls.length;
  return (trace.tree ?? []).reduce((n, node) => n + (node.calls?.length ?? 0), 0);
}

// Slim a trace for persistence: keep the tree + flat calls (each call's query /
// endpoint / effort / ms and every card's title/source/url are retained — the
// guaranteed minimum) and reasoning, but drop bulky prose (notes) and the
// related-graph item lists. Cards embedded in calls are already compact.
export function slimTrace(trace: TurnTrace): TurnTrace {
  return {
    ...trace,
    notes: [],
    graph: trace.graph ? { resolved: trace.graph.resolved, related: [] } : undefined,
  };
}

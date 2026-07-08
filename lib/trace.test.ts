import { describe, it, expect } from "vitest";
import { buildTree, stepsToDisplay, traceToDisplay, slimTrace, groundingOf, countCalls, groundedInOf, type LiveStep } from "./trace";
import type { TurnTrace, TakoCallRecord } from "./agents/shared/types";

const call = (nodeId: string, seq: number, cardId: string): TakoCallRecord => ({
  callId: `${nodeId}:${seq}`, nodeId, query: `q ${cardId}`, endpoint: "/v3/search",
  effort: "fast", web: true, ms: 12, cards: [{ id: cardId, title: cardId.toUpperCase(), source: "Tako", url: `https://w/${cardId}` }],
});

const trace: TurnTrace = {
  action: "NEW_BOARD", provider: "tako", queries: ["q nvda", "q amd"], cards: [], opsApplied: 0,
  notes: ["some note", "another"], ms: 1840,
  graph: { resolved: [{ query: "Nvidia", node: "NVIDIA" }], related: [{ node: "NVIDIA", items: ["a", "b", "c"] }] },
  tree: [
    { nodeId: "synth", depth: 0, question: "compare", kind: "branch", findingCount: 1, children: ["rq_nvda", "rq_amd"], queries: ["broad"], rationale: "split", calls: [call("synth", 0, "broad1")] },
    { nodeId: "rq_nvda", depth: 1, question: "nvidia revenue", kind: "leaf", findingCount: 1, children: [], queries: ["q nvda"], calls: [call("rq_nvda", 0, "nvda")] },
    { nodeId: "rq_amd", depth: 1, question: "amd revenue", kind: "leaf", findingCount: 1, children: [], queries: ["q amd"], calls: [call("rq_amd", 0, "amd")] },
  ],
  calls: [call("synth", 0, "broad1"), call("rq_nvda", 0, "nvda"), call("rq_amd", 0, "amd")],
  reasoning: [{ nodeId: "synth", question: "compare", rationale: "split" }],
};

describe("buildTree", () => {
  it("nests the flat wire tree by child id refs, rooted at the synth node", () => {
    const roots = buildTree(trace.tree);
    expect(roots).toHaveLength(1);
    expect(roots[0].nodeId).toBe("synth");
    expect(roots[0].children.map((c) => c.nodeId)).toEqual(["rq_nvda", "rq_amd"]);
    // per-node calls survive with their card linkage
    expect(roots[0].children[0].calls[0].cards[0].id).toBe("nvda");
  });

  it("returns [] for an empty/undefined tree", () => {
    expect(buildTree(undefined)).toEqual([]);
    expect(buildTree([])).toEqual([]);
  });
});

describe("stepsToDisplay", () => {
  it("groups live steps by nodeId, attaching calls + synth state", () => {
    const steps: LiveStep[] = [
      { t: "reasoning", nodeId: "synth", depth: 0, question: "compare", kind: "branch", rationale: "split", subQuestions: ["nvidia revenue", "amd revenue"] },
      { t: "reasoning", nodeId: "rq_nvda", depth: 1, question: "nvidia revenue", kind: "leaf" },
      { t: "tako", call: call("rq_nvda", 0, "nvda") },
      { t: "synth", nodeId: "rq_nvda", phase: "start" },
    ];
    const views = stepsToDisplay(steps);
    expect(views.map((v) => v.nodeId)).toEqual(["synth", "rq_nvda"]);
    const nvda = views.find((v) => v.nodeId === "rq_nvda")!;
    expect(nvda.calls[0].cards[0].id).toBe("nvda");
    expect(nvda.findingCount).toBe(1);
    expect(nvda.synthesizing).toBe(true);
    expect(nvda.depth).toBe(1);
  });

  it("is idempotent on repeated callId", () => {
    const steps: LiveStep[] = [
      { t: "tako", call: call("n", 0, "x") },
      { t: "tako", call: call("n", 0, "x") },
    ];
    expect(stepsToDisplay(steps)[0].calls).toHaveLength(1);
  });
});

describe("traceToDisplay", () => {
  it("uses the nested tree when present", () => {
    const roots = traceToDisplay(trace);
    expect(roots).toHaveLength(1);
    expect(roots[0].nodeId).toBe("synth");
  });

  it("falls back to flat calls + reasoning when the tree is empty (all pruned)", () => {
    const pruned = {
      ...trace, tree: [],
      reasoning: [{ nodeId: "synth", question: "compare", rationale: "direct comparison" }],
      calls: [call("synth", 0, "nvda"), call("synth", 1, "amd")],
    };
    const roots = traceToDisplay(pruned);
    expect(roots).toHaveLength(1);
    expect(roots[0].nodeId).toBe("synth");
    expect(roots[0].rationale).toBe("direct comparison");
    expect(roots[0].calls).toHaveLength(2); // the calls survive even with no tree
  });
});

describe("slimTrace", () => {
  it("retains every call record + card fields and drops notes / related items", () => {
    const slim = slimTrace(trace);
    expect(slim.calls).toHaveLength(3);
    expect(slim.calls![1].cards[0].url).toBe("https://w/nvda"); // card provenance retained
    expect(slim.tree![1].calls![0].query).toBe("q nvda"); // per-node calls retained
    expect(slim.notes).toEqual([]); // bulky prose dropped
    expect(slim.graph!.resolved).toHaveLength(1); // resolved kept
    expect(slim.graph!.related).toEqual([]); // related item lists dropped
    expect(slim.reasoning).toHaveLength(1);
  });
});

describe("groundingOf / countCalls", () => {
  it("classifies grounding by source presence", () => {
    expect(groundingOf({ id: "a", title: "A", source: "SEC" })).toBe("tako");
    expect(groundingOf({ id: "b", title: "B" })).toBe("web");
  });
  it("counts calls from the flat list or the tree", () => {
    expect(countCalls(trace)).toBe(3);
    expect(countCalls({ ...trace, calls: undefined })).toBe(3); // falls back to tree
    expect(countCalls(undefined)).toBe(0);
  });
});

describe("groundedInOf", () => {
  it("returns empty structure when the trace has no groundedIn", () => {
    expect(groundedInOf(undefined)).toEqual({ nodes: [], takoAnswerUsed: false, cards: [] });
    expect(groundedInOf({} as any)).toEqual({ nodes: [], takoAnswerUsed: false, cards: [] });
  });

  it("passes through nodes/cards and the tako flag", () => {
    const g = groundedInOf({
      groundedIn: {
        nodes: [{ id: "nvda", title: "Nvidia revenue" }],
        takoAnswerUsed: true,
        cards: [{ id: "c1", title: "Card", url: "https://x" }],
      },
    } as any);
    expect(g.nodes[0].id).toBe("nvda");
    expect(g.takoAnswerUsed).toBe(true);
    expect(g.cards[0].id).toBe("c1");
  });
});

describe("gap-fill trace plumbing", () => {
  it("buildTree carries gapFill onto the view node", () => {
    const flat = [
      { nodeId: "synth", depth: 0, question: "q", kind: "branch" as const, findingCount: 0, children: ["rq_gap"] },
      { nodeId: "rq_gap", depth: 1, question: "amd revenue", kind: "leaf" as const, findingCount: 1, children: [], gapFill: true },
    ];
    const roots = buildTree(flat);
    expect(roots[0].children[0].gapFill).toBe(true);
  });
  it("stepsToDisplay accepts a kind:'gap' reasoning step", () => {
    const views = stepsToDisplay([
      { t: "reasoning", nodeId: "rq_gap", depth: 1, question: "amd revenue", kind: "gap", rationale: "missing half" },
    ]);
    expect(views[0].kind).toBe("gap");
  });
});

// Live graph visibility: graph search/related calls must attach to their node in the
// LIVE view too, not only in the authoritative post-run tree.
describe("live graph calls", () => {
  it("stepsToDisplay attaches live graph calls to their node", () => {
    const views = stepsToDisplay([
      { t: "reasoning", nodeId: "rq_x", depth: 1, question: "nvidia revenue", kind: "leaf" },
      { t: "graph", nodeId: "rq_x", call: { endpoint: "graph/search", params: { q: "NVIDIA Corporation", types: "entity" }, ms: 40, results: [{ name: "NVIDIA Corporation" }] } },
      { t: "graph", nodeId: "rq_x", call: { endpoint: "graph/related", params: { node_id: "nv-1", relation_type: "metric", q: "revenue" }, ms: 55, results: [{ name: "Total Revenue" }] } },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].graphCalls).toHaveLength(2);
    expect(views[0].graphCalls[0].endpoint).toBe("graph/search");
    expect(views[0].graphCalls[1].results[0].name).toBe("Total Revenue");
  });
});

import { describe, it, expect } from "vitest";
import { structuralEdges, validateGraph, finalizeOps } from "./relate";
import type { CanvasState } from "./schema";

const base: CanvasState = {
  edges: [],
  nodes: [
    { id: "cons", type: "consensus", role: "consensus", title: "V", grounding: "model", confidence: 1 },
    { id: "e-a", type: "data_card", section: "A", role: "evidence", title: "A", grounding: "tako", confidence: 1 },
    { id: "e-b", type: "data_card", section: "B", role: "evidence", title: "B", grounding: "tako", confidence: 1 },
  ],
};

describe("relate", () => {
  it("feeds every evidence node into the consensus node", () => {
    const edges = structuralEdges(base);
    const feeds = edges.filter((e) => e.kind === "feeds" && e.to === "cons");
    expect(feeds.map((e) => e.from).sort()).toEqual(["e-a", "e-b"]);
  });

  it("dedupes edges and drops edges to missing nodes", () => {
    const dirty: CanvasState = {
      nodes: base.nodes,
      edges: [
        { id: "x", from: "e-a", to: "cons", kind: "feeds" },
        { id: "x", from: "e-a", to: "cons", kind: "feeds" },
        { id: "y", from: "e-a", to: "GHOST", kind: "feeds" },
      ],
    };
    const out = validateGraph(dirty);
    expect(out.edges.map((e) => e.id)).toEqual(["x"]);
  });

  it("finalizeOps appends feeds edges for evidence added by ops", () => {
    const start: CanvasState = { nodes: [base.nodes[0]], edges: [] }; // consensus only
    const ops = [{ op: "add_node" as const, node: base.nodes[1] }]; // add evidence e-a
    const out = finalizeOps(start, ops);
    const edgeOps = out.filter((o) => o.op === "add_edge") as Extract<typeof out[number], { op: "add_edge" }>[];
    expect(edgeOps.map((o) => o.edge.kind)).toContain("feeds");
    expect(out[0]).toEqual(ops[0]); // agent ops preserved, in order
  });
});

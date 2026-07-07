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

  it("drops an edge that would close a cycle", () => {
    const cyclic: CanvasState = {
      nodes: [
        { id: "a", type: "data_card", role: "evidence", title: "A", grounding: "tako", confidence: 1 },
        { id: "b", type: "data_card", role: "evidence", title: "B", grounding: "tako", confidence: 1 },
        { id: "c", type: "data_card", role: "evidence", title: "C", grounding: "tako", confidence: 1 },
      ],
      edges: [
        { id: "a->b", from: "a", to: "b", kind: "feeds" },
        { id: "b->c", from: "b", to: "c", kind: "feeds" },
        { id: "c->a", from: "c", to: "a", kind: "feeds" },
      ],
    };
    const out = validateGraph(cyclic);
    expect(out.edges.map((e) => e.id)).toEqual(["a->b", "b->c"]);
  });

  it("fans every finding into a synthesis hub, including ungrouped web cards", () => {
    const board: CanvasState = {
      edges: [],
      nodes: [
        { id: "synth", type: "text", role: "synthesis", title: "Answer", grounding: "tako", confidence: 0.9 },
        { id: "d-a", type: "data_card", section: "A", title: "A", grounding: "tako", confidence: 1 }, // no evidence role
        { id: "w", type: "text", role: "evidence", title: "web fact", grounding: "web", confidence: 0.7 }, // no section
        { id: "d-web", type: "data_card", title: "answer chart", grounding: "tako", confidence: 1 }, // data_card, no section
      ],
    };
    const feeds = structuralEdges(board).filter((e) => e.kind === "feeds" && e.to === "synth");
    // all three findings connect — the section requirement is dropped for a synthesis hub
    expect(feeds.map((e) => e.from).sort()).toEqual(["d-a", "d-web", "w"]);
  });

  it("does not cap fan-in into the synthesis hub past maxDegree", () => {
    const nodes = [
      { id: "synth", type: "text" as const, role: "synthesis" as const, title: "Answer", grounding: "tako" as const, confidence: 0.9 },
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `c${i}`, type: "data_card" as const, section: "S", role: "evidence" as const,
        title: `c${i}`, grounding: "tako" as const, confidence: 1,
      })),
    ];
    const edges = nodes.slice(1).map((n) => ({ id: `${n.id}->synth`, from: n.id, to: "synth", kind: "feeds" as const }));
    const out = validateGraph({ nodes, edges });
    expect(out.edges.filter((e) => e.to === "synth").length).toBe(15); // all kept, not capped at 12
  });

  it("skips the single-hub fan-in when a research tree owns its edges", () => {
    const tree: CanvasState = {
      edges: [],
      nodes: [
        { id: "synth", type: "text", role: "synthesis", title: "A", grounding: "tako", confidence: 1 },
        { id: "rq", type: "text", role: "research", section: "rq", title: "Q", grounding: "tako", confidence: 1 },
        { id: "card", type: "data_card", section: "rq", title: "c", grounding: "tako", confidence: 1 },
      ],
    };
    const feeds = structuralEdges(tree).filter((e) => e.kind === "feeds");
    expect(feeds.length).toBe(0); // pipeline owns feeds/derived_from; no auto card→synth fan-in
  });

  it("does not cap fan-in into a research node past maxDegree", () => {
    const nodes = [
      { id: "rq", type: "text" as const, role: "research" as const, section: "rq", title: "Q", grounding: "tako" as const, confidence: 1 },
      ...Array.from({ length: 15 }, (_, i) => ({
        id: `c${i}`, type: "data_card" as const, section: "rq", title: `c${i}`, grounding: "tako" as const, confidence: 1,
      })),
    ];
    const edges = nodes.slice(1).map((n) => ({ id: `${n.id}->rq`, from: n.id, to: "rq", kind: "feeds" as const }));
    const out = validateGraph({ nodes, edges });
    expect(out.edges.filter((e) => e.to === "rq").length).toBe(15); // all kept
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

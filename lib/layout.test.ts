import { describe, it, expect } from "vitest";
import { computeStructuredLayout } from "./layout";
import type { CanvasNode, CanvasEdge } from "./schema";

const N = (id: string, over: Partial<CanvasNode> = {}): CanvasNode => ({
  id, type: "text", title: id, grounding: "tako", confidence: 1, ...over,
});

describe("computeStructuredLayout — tree mode", () => {
  // synth ← rq1, rq2 (research); each leaf has one finding card
  const nodes: CanvasNode[] = [
    N("synth", { role: "synthesis" }),
    N("rq1", { role: "research", section: "rq1" }),
    N("rq2", { role: "research", section: "rq2" }),
    N("c1", { type: "data_card", section: "rq1", tako: { cardId: "c1", embedUrl: "https://e/1" } }),
    N("c2", { type: "data_card", section: "rq2", tako: { cardId: "c2", embedUrl: "https://e/2" } }),
  ];
  const edges: CanvasEdge[] = [
    { id: "d1", from: "rq1", to: "synth", kind: "derived_from" },
    { id: "d2", from: "rq2", to: "synth", kind: "derived_from" },
    { id: "f1", from: "c1", to: "rq1", kind: "feeds" },
    { id: "f2", from: "c2", to: "rq2", kind: "feeds" },
  ];

  it("stacks depth rows: synth above research above findings", () => {
    const { positions } = computeStructuredLayout(nodes, {}, edges);
    expect(positions.synth.y).toBeLessThan(positions.rq1.y);
    expect(positions.rq1.y).toBeLessThan(positions.c1.y); // finding under its leaf
    expect(positions.rq1.y).toBe(positions.rq2.y); // siblings share a row
  });

  it("centers the parent over its two children", () => {
    const { positions } = computeStructuredLayout(nodes, {}, edges);
    const cx = (id: string, w: number) => positions[id].x + w / 2;
    const synthCx = cx("synth", 600);
    const mid = (cx("rq1", 420) + cx("rq2", 420)) / 2;
    expect(Math.abs(synthCx - mid)).toBeLessThan(2);
  });

  it("labels bands by depth", () => {
    const { bands } = computeStructuredLayout(nodes, {}, edges);
    expect(bands.map((b) => b.label)).toEqual(["Answer", "Research"]);
  });

  it("pushes the research row below the root's own broad findings", () => {
    // synth has its own broad card (bc) AND two research children
    const withBroad: CanvasNode[] = [
      ...nodes,
      N("bc", { type: "data_card", section: "synth", tako: { cardId: "bc", embedUrl: "https://e/bc" } }),
    ];
    const withBroadEdges: CanvasEdge[] = [...edges, { id: "fb", from: "bc", to: "synth", kind: "feeds" }];
    const { positions } = computeStructuredLayout(withBroad, {}, withBroadEdges);
    // the broad card sits below the synth and above the research row
    expect(positions.bc.y).toBeGreaterThan(positions.synth.y);
    expect(positions.rq1.y).toBeGreaterThan(positions.bc.y);
  });

  it("places web-source nodes in a left column, left of the tree and inside bounds", () => {
    const withSrc: CanvasNode[] = [...nodes, N("src1", { role: "source" }), N("src2", { role: "source" })];
    const withSrcEdges: CanvasEdge[] = [
      ...edges,
      { id: "s1", from: "src1", to: "synth", kind: "supports" },
      { id: "s2", from: "src2", to: "rq1", kind: "supports" },
    ];
    const { positions, bounds } = computeStructuredLayout(withSrc, {}, withSrcEdges);
    const treeMinX = Math.min(positions.synth.x, positions.rq1.x, positions.rq2.x);
    expect(positions.src1.x).toBeLessThan(treeMinX); // left of the tree
    expect(positions.src1.x).toBe(positions.src2.x); // same column
    expect(positions.src2.y).toBeGreaterThan(positions.src1.y); // stacked
    expect(bounds.minX).toBeLessThanOrEqual(positions.src1.x); // framed by fit-to-view
  });

  it("falls back to the band layout when no research nodes exist", () => {
    const flat: CanvasNode[] = [N("s", { role: "synthesis" }), N("d", { type: "data_card", section: "x" })];
    const { bands } = computeStructuredLayout(flat, {}, []);
    expect(bands[0].label).toBe("Synthesis");
  });
});

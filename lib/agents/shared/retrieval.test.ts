import { describe, it, expect } from "vitest";
import { retrieveNodes, nodeContentBlock } from "./retrieval";
import type { CanvasNode, CanvasState } from "../../schema";

const node = (over: Partial<CanvasNode>): CanvasNode => ({
  id: "n", type: "data_card", title: "t", grounding: "tako", confidence: 0.9, ...over,
});

const state: CanvasState = {
  nodes: [
    node({ id: "nvda", title: "Nvidia data-center revenue", summary: "grew fast" }),
    node({ id: "amd", title: "AMD gross margin", summary: "steady" }),
    node({ id: "sec", type: "entity_section", role: "header", title: "United States" }),
  ],
  edges: [],
};

describe("retrieveNodes", () => {
  it("returns exactly the selection, in order, when present", () => {
    const r = retrieveNodes(state, { nodeIds: ["amd", "nvda"] }, "anything");
    expect(r.map((n) => n.id)).toEqual(["amd", "nvda"]);
  });

  it("ranks by keyword overlap when there is no selection", () => {
    const r = retrieveNodes(state, undefined, "how did Nvidia data-center revenue do?");
    expect(r[0].id).toBe("nvda");
  });

  it("skips entity_section / header nodes", () => {
    const r = retrieveNodes(state, undefined, "united states");
    expect(r.some((n) => n.id === "sec")).toBe(false);
  });

  it("caps at k and falls back to most-recent on no match", () => {
    const many: CanvasState = { nodes: Array.from({ length: 10 }, (_, i) => node({ id: `x${i}`, title: `zzz${i}` })), edges: [] };
    const r = retrieveNodes(many, undefined, "unrelated query terms", 3);
    expect(r).toHaveLength(3);
    expect(r.map((n) => n.id)).toEqual(["x7", "x8", "x9"]); // recency fallback = last k
  });

  it("breaks a keyword tie in favor of the Tako-grounded node", () => {
    // Both titles carry the SAME single query-matching token ("inflation") and
    // nothing else, so keyword overlap is identical. The tako node is placed
    // FIRST so that, absent the grounding boost, the index-descending tie-break
    // would rank the model node ahead — the +0.05 tako boost is the only thing
    // that flips it back. (If the boost term is deleted, this asserts "model".)
    const tie: CanvasState = {
      nodes: [
        node({ id: "tk", title: "inflation", grounding: "tako" }),
        node({ id: "md", title: "inflation", grounding: "model" }),
      ],
      edges: [],
    };
    const r = retrieveNodes(tie, undefined, "inflation");
    expect(r[0].id).toBe("tk");
  });
});

describe("nodeContentBlock", () => {
  it("serializes metric, chart, consensus, and sources", () => {
    const out = nodeContentBlock([
      node({ id: "m", title: "Rev", metric: { value: "$26B", label: "Q2 revenue", delta: "+88%" } }),
      node({ id: "c", title: "Trend", chartSpec: { kind: "line", unit: "USD", series: [{ label: "NVDA", points: [{ x: "Q1", y: 1 }, { x: "Q2", y: 2 }] }] } }),
      node({ id: "k", title: "Ranking", consensusRows: [{ rank: 1, entity: "NVDA", score: 0.9 }] }),
      node({ id: "s", title: "Article", sources: [{ url: "https://ex.com/a" }] }),
    ]);
    expect(out).toContain("$26B");
    expect(out).toContain("Q2 revenue");
    expect(out).toContain("chart(line USD) NVDA: Q1:1, Q2:2");
    expect(out).toContain("1. NVDA (0.9)");
    expect(out).toContain("https://ex.com/a");
    expect(out).toContain("[#m");
  });

  it("returns a sentinel when empty", () => {
    expect(nodeContentBlock([])).toBe("(no matching board nodes)");
  });
});

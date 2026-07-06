import { describe, it, expect } from "vitest";
import { normalize, computeConsensusRows } from "./consensus";
import type { CanvasState } from "./schema";

const state: CanvasState = {
  edges: [],
  nodes: [
    { id: "s-a", type: "entity_section", section: "A", title: "A", grounding: "tako", confidence: 1 },
    { id: "s-b", type: "entity_section", section: "B", title: "B", grounding: "tako", confidence: 1 },
    { id: "m-a", type: "metric", section: "A", title: "Rev A", grounding: "tako", confidence: 1,
      metric: { value: "100", label: "Revenue" } },
    { id: "m-b", type: "metric", section: "B", title: "Rev B", grounding: "tako", confidence: 1,
      metric: { value: "50", label: "Revenue" } },
    { id: "crit", type: "criteria", title: "Criteria", grounding: "model", confidence: 1,
      criteria: { weights: { Revenue: 1 } } },
    { id: "cons", type: "consensus", title: "Verdict", grounding: "model", confidence: 1, consensusRows: [] },
  ],
};

describe("consensus", () => {
  it("normalize maps min→0 and max→1", () => {
    expect(normalize([50, 100])).toEqual([0, 1]);
    expect(normalize([7, 7])).toEqual([1, 1]);
  });

  it("ranks entities deterministically by weighted normalized score", () => {
    const rows = computeConsensusRows(state, "cons");
    expect(rows.map((r) => r.entity)).toEqual(["A", "B"]);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
  });

  it("is stable across repeated runs", () => {
    expect(computeConsensusRows(state, "cons")).toEqual(computeConsensusRows(state, "cons"));
  });
});

import { describe, it, expect } from "vitest";
import { buildTree, stepsToDisplay } from "./trace";

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

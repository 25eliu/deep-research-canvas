import { describe, it, expect } from "vitest";
import { zResearchPlan, zAnswerBlock, zGapPlan } from "./schemas";

// Every research question is a LOOKUP PAIR: exactly one entity term (entity-namespace
// graph search) + one metric term (metric-namespace graph search). The schema is the
// enforcement point — a plan missing either half must fail validation so generateObject
// retries the LLM call instead of silently proceeding with a half-grounded question.
describe("zResearchPlan — validated entity/metric pair", () => {
  const sub = { question: "nvidia revenue", entity: "NVIDIA Corporation", metric: "Revenue" };
  const base = { atomic: true, rationale: "direct", entity: "Apple Inc.", metric: "Income Statement" };

  it("accepts a well-formed pair, top-level and per sub-question", () => {
    expect(zResearchPlan.safeParse(base).success).toBe(true);
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [sub, sub] }).success).toBe(true);
  });

  it("rejects a plan missing either half of the pair", () => {
    const { entity: _e, ...noEntity } = base;
    const { metric: _m, ...noMetric } = base;
    expect(zResearchPlan.safeParse(noEntity).success).toBe(false);
    expect(zResearchPlan.safeParse(noMetric).success).toBe(false);
  });

  it("rejects empty-string halves", () => {
    expect(zResearchPlan.safeParse({ ...base, entity: "" }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, metric: "" }).success).toBe(false);
  });

  it("rejects a sub-question missing its pair", () => {
    const { metric: _m, ...subNoMetric } = sub;
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [sub, subNoMetric] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [{ ...sub, entity: "" }] }).success).toBe(false);
  });

  it("rejects the old plural entities/metrics shape", () => {
    const plural = { atomic: true, rationale: "r", entities: ["Apple Inc."], metrics: ["Revenue"] };
    expect(zResearchPlan.safeParse(plural).success).toBe(false);
  });
});

describe("zAnswerBlock — new question-shaped kinds", () => {
  it("accepts a comparison block", () => {
    const b = {
      kind: "comparison", title: "Revenue", unit: "USD",
      series: [
        { label: "Nvidia", entity: "Nvidia", points: [{ x: "2023", y: 27 }, { x: "2024", y: 61 }] },
        { label: "AMD", entity: "AMD", points: [{ x: "2023", y: 23 }, { x: "2024", y: 26 }] },
      ],
      insight: "Nvidia pulled away in 2024.",
    };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("accepts a leaderboard block with optional expandable detail", () => {
    const b = {
      kind: "leaderboard", metricLabel: "Market cap",
      rows: [
        { rank: 1, entity: "Nvidia", value: "$3.4T", delta: "+12%",
          detail: { md: "Dominates AI accelerators.", stats: [{ label: "Revenue", value: "$75.2B" }] } },
        { rank: 2, entity: "AMD", value: "$0.3T" },
      ],
    };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("accepts a sections block", () => {
    const b = {
      kind: "sections",
      sections: [{ title: "Rates", md: "Higher for longer.", figure: { label: "Fed funds", value: "5.5%" } }],
    };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("accepts a timeline block", () => {
    const b = { kind: "timeline", events: [{ date: "2024-03", title: "Blackwell announced", value: "$30B" }] };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("rejects empty series/rows/sections/events", () => {
    expect(zAnswerBlock.safeParse({ kind: "comparison", series: [] }).success).toBe(false);
    expect(zAnswerBlock.safeParse({ kind: "leaderboard", metricLabel: "x", rows: [] }).success).toBe(false);
    expect(zAnswerBlock.safeParse({ kind: "sections", sections: [] }).success).toBe(false);
    expect(zAnswerBlock.safeParse({ kind: "timeline", events: [] }).success).toBe(false);
  });
});

describe("zGapPlan — gap-analysis output", () => {
  const gap = { question: "amd revenue", entity: "AMD", metric: "Revenue", why: "missing comparison half" };
  it("accepts sufficient with empty gaps, and a gap list", () => {
    expect(zGapPlan.safeParse({ sufficient: true, rationale: "covered", gaps: [] }).success).toBe(true);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "one side missing", gaps: [gap] }).success).toBe(true);
  });
  it("rejects a gap missing its entity/metric pair or with empty strings", () => {
    const { metric: _m, ...noMetric } = gap;
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [noMetric] }).success).toBe(false);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [{ ...gap, entity: "" }] }).success).toBe(false);
  });
});

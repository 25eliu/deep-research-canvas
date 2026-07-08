import { describe, it, expect } from "vitest";
import { zResearchPlan } from "./schemas";

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

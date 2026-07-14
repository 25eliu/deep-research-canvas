import { describe, it, expect } from "vitest";
import { zResearchPlan, zAnswerBlock, zGapPlan } from "./schemas";
import { GRAPH_LABELS, GRAPH_LABELS_LINE } from "./graph-labels";

// Every research question is an entity-first LOOKUP: 1-3 candidate NAMES for one
// subject (entity-namespace graph search), an OPTIONAL NER label (must be one of the
// fixed graph labels — z.enum is the enforcement point — a ranking boost, not a filter),
// and 1-3 short metricFilters (substring filters for the related-metrics fetch). A plan
// missing names or filters must fail validation so generateObject retries the LLM call
// instead of silently proceeding half-grounded.
describe("zResearchPlan — entity-first lookup (entities + label + metricFilters)", () => {
  const sub = { question: "nvidia revenue", entities: ["NVIDIA Corporation"], metricFilters: ["revenue"] };
  const base = { atomic: true, rationale: "direct", entities: ["Apple Inc."], metricFilters: ["income"] };

  it("accepts a well-formed lookup, top-level and per sub-question", () => {
    expect(zResearchPlan.safeParse(base).success).toBe(true);
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [sub, sub] }).success).toBe(true);
  });

  it("accepts 1-3 candidate names and 1-5 metric filters, rejects 0 and over-caps", () => {
    expect(zResearchPlan.safeParse({ ...base, entities: ["Google", "Alphabet", "Alphabet Inc."] }).success).toBe(true);
    // Filters go up to 5 — a LIST of name-fragment variants covers recall misses.
    expect(zResearchPlan.safeParse({ ...base, metricFilters: ["revenue", "sales", "income", "margin", "profit"] }).success).toBe(true);
    expect(zResearchPlan.safeParse({ ...base, entities: [] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, entities: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, metricFilters: [] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, metricFilters: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });

  it("accepts a valid label enum value, null, and absent", () => {
    expect(zResearchPlan.safeParse({ ...base, label: "ORG" }).success).toBe(true);
    expect(zResearchPlan.safeParse({ ...base, label: "GPE" }).success).toBe(true);
    expect(zResearchPlan.safeParse({ ...base, label: null }).success).toBe(true);
    expect(zResearchPlan.safeParse(base).success).toBe(true);
  });

  it("rejects a label outside the fixed enum", () => {
    expect(zResearchPlan.safeParse({ ...base, label: "Companies" }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, label: "org" }).success).toBe(false);
  });

  it("rejects a plan missing either half of the lookup", () => {
    const { entities: _e, ...noEntities } = base;
    const { metricFilters: _m, ...noFilters } = base;
    expect(zResearchPlan.safeParse(noEntities).success).toBe(false);
    expect(zResearchPlan.safeParse(noFilters).success).toBe(false);
  });

  it("rejects empty-string members", () => {
    expect(zResearchPlan.safeParse({ ...base, entities: [""] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, metricFilters: [""] }).success).toBe(false);
  });

  it("rejects a sub-question missing its lookup or with a bad label", () => {
    const { metricFilters: _m, ...subNoFilters } = sub;
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [sub, subNoFilters] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [{ ...sub, entities: [] }] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [{ ...sub, label: "Company" }] }).success).toBe(false);
    expect(zResearchPlan.safeParse({ ...base, atomic: false, subQuestions: [{ ...sub, label: "GPE" }] }).success).toBe(true);
  });

  it("rejects the old singular entity/metric shape", () => {
    const singular = { atomic: true, rationale: "r", entity: "Apple Inc.", metric: "Revenue" };
    expect(zResearchPlan.safeParse(singular).success).toBe(false);
  });
});

describe("GRAPH_LABELS — the fixed Tako graph NER label list", () => {
  it("has all 11 documented labels, spot-checked", () => {
    expect(GRAPH_LABELS).toHaveLength(11);
    expect(GRAPH_LABELS[0]).toBe("PERSON");
    expect(GRAPH_LABELS).toContain("ORG");
    expect(GRAPH_LABELS).toContain("GPE");
    expect(GRAPH_LABELS).toContain("METRIC");
    expect(GRAPH_LABELS[GRAPH_LABELS.length - 1]).toBe("WEBSITE");
  });
  it("contains no duplicates", () => {
    expect(new Set(GRAPH_LABELS).size).toBe(GRAPH_LABELS.length);
  });
  it("GRAPH_LABELS_LINE joins every label for prompt interpolation", () => {
    expect(GRAPH_LABELS_LINE).toContain("ORG");
    expect(GRAPH_LABELS_LINE).toContain("STOCK_TICKER");
    expect(GRAPH_LABELS_LINE.split(", ")).toHaveLength(11);
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
  const gap = { question: "amd revenue", entities: ["Advanced Micro Devices"], metricFilters: ["revenue"], why: "missing comparison half" };
  it("accepts sufficient with empty gaps, and a gap list (with optional label)", () => {
    expect(zGapPlan.safeParse({ sufficient: true, rationale: "covered", gaps: [] }).success).toBe(true);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "one side missing", gaps: [gap] }).success).toBe(true);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [{ ...gap, label: "ORG" }] }).success).toBe(true);
  });
  it("rejects a gap missing its lookup, with empty members, or a non-enum label", () => {
    const { metricFilters: _m, ...noFilters } = gap;
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [noFilters] }).success).toBe(false);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [{ ...gap, entities: [""] }] }).success).toBe(false);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [{ ...gap, label: "Company" }] }).success).toBe(false);
  });
});

import { zCanvasNode } from "../../schema";

describe("zCanvasNode.gapFill", () => {
  it("accepts a research node flagged as gap-fill", () => {
    const n = { id: "rq_x", type: "text", role: "research", title: "amd revenue", grounding: "tako", confidence: 0.85, gapFill: true };
    expect(zCanvasNode.safeParse(n).success).toBe(true);
  });
});

import { zCohortMembers } from "./schemas";

// Cohort-grounded decomposition: a class-of-entities question ("emerging infrastructure
// startups") first resolves REAL members via tako answer; the plan signals it via `cohort`.
describe("cohort resolution schemas", () => {
  const base = { atomic: false, rationale: "class question", entities: ["Infrastructure startups"], metricFilters: ["funding"] };
  it("zResearchPlan accepts an optional cohort class phrase (and remains valid without it)", () => {
    expect(zResearchPlan.safeParse({ ...base, cohort: "emerging infrastructure startups" }).success).toBe(true);
    expect(zResearchPlan.safeParse(base).success).toBe(true);
  });
  it("zCohortMembers requires at least one non-empty member name", () => {
    expect(zCohortMembers.safeParse({ entities: ["Stategraph", "Runplane"], rationale: "named in the grounded answer" }).success).toBe(true);
    expect(zCohortMembers.safeParse({ entities: [], rationale: "r" }).success).toBe(false);
    expect(zCohortMembers.safeParse({ entities: [""], rationale: "r" }).success).toBe(false);
  });
});

import { zComponentPlan } from "./schemas";

describe("zComponentPlan", () => {
  it("accepts a full plan", () => {
    const plan = zComponentPlan.parse({
      question: "AMD data-center revenue", rationale: "user asked for a chart",
      entities: ["Advanced Micro Devices", "AMD"], label: "ORG", metricFilters: ["revenue", "data center"],
    });
    expect(plan.question).toBe("AMD data-center revenue");
  });
  it("rejects a plan without entities or metricFilters", () => {
    expect(() => zComponentPlan.parse({ question: "q", rationale: "r", entities: [], metricFilters: ["x"] })).toThrow();
    expect(() => zComponentPlan.parse({ question: "q", rationale: "r", entities: ["A"], metricFilters: [] })).toThrow();
  });
});

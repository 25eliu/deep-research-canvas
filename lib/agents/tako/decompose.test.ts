import { describe, it, expect } from "vitest";
import { depthLean } from "./research";
import {
  COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, DECOMPOSE_SYSTEM,
  SEARCH_LEAF_COMPOSE_SYSTEM, SEARCH_BROAD_COMPOSE_SYSTEM,
  COHORT_RESOLVE_SYSTEM,
} from "./prompts";

// The atomic-vs-split lean must decay with depth: the top-level question leans hard toward
// splitting, deeper levels split only while 2+ entities/metrics remain. Guards the tiers.
describe("depthLean", () => {
  it("depth 0 leans toward splitting every comparison/'and'", () => {
    const top = depthLean(0);
    expect(top).toContain("LEAN TOWARD SPLITTING");
    expect(top).toContain(`every "and"`);
    expect(top).toContain("ONE entity + ONE metric");
  });

  it("deeper levels go atomic only once one pair remains", () => {
    for (const depth of [1, 2]) {
      const deep = depthLean(depth);
      expect(deep).toContain("2+ entities or 2+ metrics");
      expect(deep).toContain("exactly one entity + one metric");
      expect(deep).not.toContain("LEAN TOWARD SPLITTING");
    }
  });
});

// Tako /v3/search handles multi-entity questions poorly, so every query composer must
// carry the ONE-entity-per-query rule, and the decomposer must emit a validated PAIR
// (one entity term + one metric term) per question, splitting on any comparison/"and".
describe("lookup-pair rules in prompts", () => {
  it("every compose prompt forbids multi-entity queries", () => {
    for (const p of [COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, SEARCH_LEAF_COMPOSE_SYSTEM, SEARCH_BROAD_COMPOSE_SYSTEM]) {
      expect(p).toContain("ONE entity");
    }
  });

  // Regression: when the graph resolves only keyword near-misses ("AI inference market" →
  // "Infer, Inc."), the composer was forced into 1-3 queries and cited the junk menu
  // ("Infer, Inc.'s Aggregate Value Raised"). An empty list must be a legal, correct answer.
  it("compose may return ZERO queries when RESOLVED is irrelevant, instead of forcing junk", () => {
    expect(COMPOSE_SYSTEM).toContain("0 to 3");
    expect(COMPOSE_SYSTEM).toContain("EMPTY list");
    expect(COMPOSE_SYSTEM).toContain("keyword near-miss");
  });

  // Same regression at the ROOT: the broad composer forced 1-2 queries even when the graph
  // resolved junk ("Emerging infrastructure startups" → "for Startups, Inc." / "Startup, WA"
  // → "Startup, WA: Median Sales Price"). Zero broad queries must be legal too.
  it("broad compose may return ZERO queries when RESOLVED is irrelevant", () => {
    expect(BROAD_COMPOSE_SYSTEM).toContain("0 to 2");
    expect(BROAD_COMPOSE_SYSTEM).toContain("EMPTY list");
    expect(BROAD_COMPOSE_SYSTEM).toContain("keyword near-miss");
  });

  // Regression: metric-side keyword traps. For a GLP-1 adoption question the metric search
  // confirmed "AI Adoption Rate" (shares the keyword "adoption") and it got queried. The
  // composer must test each metric's TOPIC against the sub-question, not keyword overlap.
  it("compose demands per-metric topical relevance, not keyword overlap", () => {
    expect(COMPOSE_SYSTEM).toContain("sharing a keyword is NOT relevance");
    expect(COMPOSE_SYSTEM).toContain("AI Adoption Rate");
    expect(COMPOSE_SYSTEM).toContain("GLP-1");
  });

  // Cohort-grounded decomposition: class questions ("emerging infrastructure startups")
  // must not decompose into class-wide metric subs ("rank AI companies by employee count");
  // they signal `cohort`, real members get resolved from a grounded tako answer, and the
  // second pass produces ONE-member sub-questions.
  it("decompose treats an entity class as a cohort, never a sub-question subject", () => {
    expect(DECOMPOSE_SYSTEM).toContain("cohort");
    expect(DECOMPOSE_SYSTEM).toContain("CONCRETE, individually nameable");
    expect(DECOMPOSE_SYSTEM).toContain("COHORT_MEMBERS");
    expect(DECOMPOSE_SYSTEM).toContain("never \"rank");
  });

  it("cohort resolver extracts members from the grounded answer only", () => {
    expect(COHORT_RESOLVE_SYSTEM).toContain("GROUNDED_ANSWER");
    expect(COHORT_RESOLVE_SYSTEM).toContain("NEVER invent");
    expect(COHORT_RESOLVE_SYSTEM).toContain("at most 6");
  });

  it("decompose targets one pair per question and splits any versus/and", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ONE entity + ONE metric");
    expect(DECOMPOSE_SYSTEM).toContain(`every "and"`);
    expect(DECOMPOSE_SYSTEM).toContain("entity: string, metric: string"); // singular pair shape
    expect(DECOMPOSE_SYSTEM).not.toContain("NOT a reason to split");
  });

  it("decompose teaches keyword matching and namespace segregation", () => {
    expect(DECOMPOSE_SYSTEM).toContain("names and aliases"); // graph lookup = keyword match, not semantic
    expect(DECOMPOSE_SYSTEM).toContain("ONLY in the graph's ENTITY namespace");
    expect(DECOMPOSE_SYSTEM).toContain("Apple Inc.");
  });

  // Regression: facet sub-questions ("impact of shelter costs on inflation") were all assigned the
  // PARENT's outcome metric ("Inflation Rate"), so every leaf resolved the same general graph menu and
  // searched the overarching question instead of its own facet. The metric side must carry the same
  // outcome-variable ban the entity side has, and siblings may never share a pair.
  it("decompose bans the outcome variable as a sub-question's metric and forbids duplicate sibling pairs", () => {
    expect(DECOMPOSE_SYSTEM).toContain("metric measures the sub-question's OWN subject");
    expect(DECOMPOSE_SYSTEM).toContain("never the outcome/target variable");
    expect(DECOMPOSE_SYSTEM).toContain("Shelter"); // the observed failure, taught as a concrete example
    expect(DECOMPOSE_SYSTEM).toContain("DIFFERENT pair");
  });
});

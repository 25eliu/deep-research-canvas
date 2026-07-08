import { describe, it, expect } from "vitest";
import { depthLean } from "./research";
import {
  COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, DECOMPOSE_SYSTEM,
  SEARCH_LEAF_COMPOSE_SYSTEM, SEARCH_BROAD_COMPOSE_SYSTEM,
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
});

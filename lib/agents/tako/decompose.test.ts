import { describe, it, expect } from "vitest";
import { depthLean } from "./research";
import {
  COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, DECOMPOSE_SYSTEM, GAP_SYSTEM,
  SEARCH_LEAF_COMPOSE_SYSTEM, SEARCH_BROAD_COMPOSE_SYSTEM,
  COHORT_RESOLVE_SYSTEM,
} from "./prompts";

// The atomic-vs-split lean must decay with depth: the top-level question leans hard toward
// splitting, deeper levels split only while 2+ subjects/measures remain. Guards the tiers.
describe("depthLean", () => {
  it("depth 0 leans toward splitting every comparison/'and'", () => {
    const top = depthLean(0);
    expect(top).toContain("LEAN TOWARD SPLITTING");
    expect(top).toContain(`every "and"`);
    expect(top).toContain("ONE subject + ONE measure");
  });

  it("deeper levels go atomic only once one subject+measure remains", () => {
    for (const depth of [1, 2]) {
      const deep = depthLean(depth);
      expect(deep).toContain("2+ subjects or 2+ measures");
      expect(deep).toContain("exactly one subject + one measure");
      expect(deep).not.toContain("LEAN TOWARD SPLITTING");
    }
  });
});

// Tako /v3/search handles multi-entity questions poorly, so every query composer must
// carry the ONE-entity-per-query rule, and the decomposer must emit a validated
// entity-first lookup (1-3 candidate names + optional subtype + 1-3 metric substring
// filters) per question, splitting on any comparison/"and".
describe("lookup rules in prompts", () => {
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

  // Regression: "best sectors to invest in" (a class question) made the model omit
  // entities/metricFilters entirely — the schema requires them, generateObject threw,
  // and the whole turn degraded to an empty board. The cohort signal must still
  // populate the top-level lookup (it seeds the broad view).
  it("cohort plans still populate the top-level lookup", () => {
    expect(DECOMPOSE_SYSTEM).toContain("STILL populate");
  });

  // Regression: "research the sectors healthcare, finance, and software" was flagged
  // as a cohort — but the question ENUMERATES its subjects, so there is nothing to
  // resolve; it must be a normal split, one sub-question per named subject.
  it("a question that names its subjects is a split, never a cohort", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ENUMERATES");
    expect(DECOMPOSE_SYSTEM).toContain("NOT a cohort");
  });

  // Regression: "how do defense contractors maintain competitive advantages" set
  // cohort (which forbids subQuestions) even though its own rationale wanted a
  // facet split — so the node leafed and gap-fill did the real work. Mechanism/
  // driver questions about a class must SPLIT into facets; famous class members
  // may be named directly from domain knowledge; cohort is a last resort for
  // genuinely unknown membership where the answer needs per-member data.
  it("mechanism questions about a class split into facets — cohort is a last resort", () => {
    expect(DECOMPOSE_SYSTEM).toContain("mechanism");
    expect(DECOMPOSE_SYSTEM).toContain("Lockheed Martin"); // famous members nameable directly
    expect(DECOMPOSE_SYSTEM).toContain("LAST RESORT");
  });

  // Every root decompose is grounded by a tako answer first (generalized from the
  // cohort-only fix): the prompt must teach the model to plan FROM that evidence.
  it("decompose treats GROUNDED_ANSWER/CARD_TITLES as real evidence to plan from", () => {
    expect(DECOMPOSE_SYSTEM).toContain("GROUNDED_ANSWER");
    expect(DECOMPOSE_SYSTEM).toContain("CARD_TITLES");
    expect(DECOMPOSE_SYSTEM).toContain("real Tako evidence");
  });

  it("cohort resolver extracts members from the grounded answer only", () => {
    expect(COHORT_RESOLVE_SYSTEM).toContain("GROUNDED_ANSWER");
    expect(COHORT_RESOLVE_SYSTEM).toContain("NEVER invent");
    expect(COHORT_RESOLVE_SYSTEM).toContain("at most 6");
  });

  it("decompose targets one subject per question and splits any versus/and", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ONE subject + ONE measure");
    expect(DECOMPOSE_SYSTEM).toContain(`every "and"`);
    expect(DECOMPOSE_SYSTEM).toContain("entities: string[]"); // entity-first lookup shape
    expect(DECOMPOSE_SYSTEM).toContain("metricFilters: string[]");
    expect(DECOMPOSE_SYSTEM).not.toContain("entity: string, metric: string"); // old singular pair gone
    expect(DECOMPOSE_SYSTEM).not.toContain("NOT a reason to split");
  });

  // `entities` = 1-3 COMPLETELY DIFFERENT names for the SAME subject ("Google", "Alphabet"),
  // never case variants and never two different subjects.
  it("decompose teaches alternate candidate names for one subject", () => {
    expect(DECOMPOSE_SYSTEM).toContain("COMPLETELY DIFFERENT");
    expect(DECOMPOSE_SYSTEM).toContain("Alphabet"); // the canonical example
    expect(DECOMPOSE_SYSTEM).toContain("Apple Inc."); // formal-name rule survives
    expect(DECOMPOSE_SYSTEM).toContain("names and aliases"); // graph lookup = keyword match, not semantic
  });

  // `subtype` filters the entity search to one graph class; the full enum must be IN the
  // prompt (structuredOutputs is off — the model has to see the legal values), interpolated
  // from GRAPH_ENTITY_SUBTYPES so schema and prompt can't drift. Spot-check both ends.
  it("decompose interpolates the full subtype enum and teaches omit-when-unsure", () => {
    expect(DECOMPOSE_SYSTEM).toContain("subtype");
    expect(DECOMPOSE_SYSTEM).toContain("Companies");
    expect(DECOMPOSE_SYSTEM).toContain("Sports Leagues");
    expect(DECOMPOSE_SYSTEM).toContain("verbatim");
    expect(DECOMPOSE_SYSTEM).toContain("unsure");
  });

  // `metricFilters` are case-insensitive SUBSTRING filters against metric NAMES.
  // Regression: the model emitted topic descriptions ("restaurant economics",
  // "restaurant margins") — a filter must be a FRAGMENT of a metric's stored name
  // ("margin"), one word preferred, never carrying the subject/domain (the entity
  // node already scopes the menu) and never a word no metric is named with.
  it("decompose teaches metricFilters as short metric-NAME fragments", () => {
    expect(DECOMPOSE_SYSTEM).toContain("metricFilters");
    expect(DECOMPOSE_SYSTEM).toContain("SUBSTRING");
    expect(DECOMPOSE_SYSTEM).toContain("case-insensitive");
    expect(DECOMPOSE_SYSTEM).toContain("FRAGMENT of a metric");
    expect(DECOMPOSE_SYSTEM).toContain("ONE word");
    expect(DECOMPOSE_SYSTEM).toContain(`"restaurant margins"`); // the observed failure, taught verbatim
    expect(DECOMPOSE_SYSTEM).toContain("economics"); // no metric is NAMED "economics"
    expect(GAP_SYSTEM).toContain("one word each");
  });

  // Breadth: a single filter that misses leaves the node's menu empty — the prompt
  // must encourage a LIST of fragment variants (2-5) so one miss doesn't blank the lookup.
  it("decompose encourages a breadth of filter variants", () => {
    expect(DECOMPOSE_SYSTEM).toContain("2-5");
    expect(DECOMPOSE_SYSTEM).toContain("another chance");
  });

  // Regression: "What's driving inflation this year?" returned atomic:false with a rationale
  // describing the split — but NO subQuestions, so the pipeline silently leafed. The prompt
  // must state that a split plan carries its sub-questions in the same response, and that
  // broad driver questions decompose into canonical components from domain knowledge even
  // when no grounding is present (grounding refines the facet list, never gates it).
  it("decompose requires subQuestions with atomic:false and teaches canonical facets", () => {
    expect(DECOMPOSE_SYSTEM).toContain("atomic:false REQUIRES subQuestions");
    expect(DECOMPOSE_SYSTEM).toContain("canonical components");
    expect(DECOMPOSE_SYSTEM).toContain("wages"); // the inflation example: energy/shelter/food/wages
    expect(DECOMPOSE_SYSTEM).toContain("niche facets"); // grounding gate scoped, not absolute
  });

  // Regression: facet sub-questions ("impact of shelter costs on inflation") were all assigned the
  // PARENT's outcome metric ("Inflation Rate"), so every leaf resolved the same general graph menu and
  // searched the overarching question instead of its own facet. The measure side must carry the same
  // outcome-variable ban the subject side has, and siblings may never share a lookup.
  it("decompose bans the outcome variable as a sub-question's measure and forbids duplicate sibling lookups", () => {
    expect(DECOMPOSE_SYSTEM).toContain("measure the sub-question's OWN subject");
    expect(DECOMPOSE_SYSTEM).toContain("never the outcome/target variable");
    expect(DECOMPOSE_SYSTEM).toContain("shelter"); // the observed failure, taught as a concrete example
    expect(DECOMPOSE_SYSTEM).toContain("DIFFERENT lookup");
  });

  // Gap fills run the same entity-first leaf flow, so the gap prompt must ask for the
  // same lookup shape (and carry the subtype enum too).
  it("gap analysis asks for entity-first lookups", () => {
    expect(GAP_SYSTEM).toContain("entities");
    expect(GAP_SYSTEM).toContain("metricFilters");
    expect(GAP_SYSTEM).toContain("Sports Leagues"); // enum interpolated here too
    expect(GAP_SYSTEM).not.toContain("ONE entity and ONE metric");
  });

  // discoverMetrics is gone: no standalone-series row reaches the composer anymore.
  it("compose prompts no longer mention standalone series", () => {
    expect(COMPOSE_SYSTEM).not.toContain("Standalone series");
    expect(BROAD_COMPOSE_SYSTEM).not.toContain("Standalone series");
  });

  // Regression: compose emitted analytical/causal questions ("How has Costco's GMV
  // affected customer loyalty?") — search COLLECTS data series; analysis happens in
  // synthesis. Queries must be data-retrieval asks (entity + metric + time), and the
  // short noun-phrase form demonstrably retrieves cards the long question form misses
  // ("US shelter CPI this year" → card; the full question → 0 cards).
  it("compose demands data-retrieval queries and bans analytical/causal phrasing", () => {
    for (const p of [COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM]) {
      expect(p).toContain("COLLECT");
      expect(p).toContain("affected"); // the observed failure shape, taught as a NEVER
    }
    expect(COMPOSE_SYSTEM).toContain("US shelter CPI this year"); // the proven-recall noun-phrase example
    expect(COMPOSE_SYSTEM).not.toContain("How has US shelter CPI changed in 2025?"); // old question-style example gone
  });

  // Graph-grounded cohorts: the first pass must name the ANCHOR so the roster
  // lookup has something to resolve; the second pass picks a real relation group
  // and copies member names verbatim (code maps names → node ids afterwards).
  it("decompose demands an ANCHOR entity when setting cohort", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ANCHOR");
    expect(DECOMPOSE_SYSTEM).toContain("National Basketball Association");
  });

  it("decompose handles a COHORT_GROUPS second pass with verbatim member names", () => {
    expect(DECOMPOSE_SYSTEM).toContain("COHORT_GROUPS");
    expect(DECOMPOSE_SYSTEM).toContain("VERBATIM");
    expect(DECOMPOSE_SYSTEM).toContain("do not set \`cohort\` again");
  });
});

import { describe, it, expect } from "vitest";
import { depthLean } from "./research";
import {
  COMPOSE_SYSTEM, DECOMPOSE_SYSTEM, GAP_SYSTEM,
  SEARCH_LEAF_COMPOSE_SYSTEM,
  COHORT_RESOLVE_SYSTEM, REPORT_GATHER_SYSTEM,
} from "./prompts";

// The atomic-vs-split lean must decay with depth: the top-level question splits genuine
// multi-subject questions but only into the fewest subs that cover it; deeper levels split
// only while 2+ subjects/measures remain. Guards the tiers.
describe("depthLean", () => {
  it("depth 0 makes decomposition the default and brakes on overlap, not coverage", () => {
    const top = depthLean(0);
    expect(top).toContain("DECOMPOSITION IS THE DEFAULT"); // splitting is the expectation…
    expect(top).toContain("actively LOOK");
    expect(top).toContain(`every "versus"`);
    expect(top).toContain("Do not drop a real facet");
    expect(top).toContain("don't over-split"); // …only overlap/padding is braked
    expect(top).toContain("NO sibling covers");
    expect(top).toContain("genuinely single-lookup question"); // atomic stays possible, but rare
    expect(top).not.toContain("LEAN TOWARD SPLITTING"); // the old spread-wide pressure is gone
  });

  it("deeper levels go atomic only once one subject+measure remains", () => {
    for (const depth of [1, 2]) {
      const deep = depthLean(depth);
      expect(deep).toContain("2+ subjects or 2+ measures");
      expect(deep).toContain("exactly one subject + one measure");
      expect(deep).not.toContain("LEAN TOWARD SPLITTING");
      // a re-split must partition the sub-question's own text — no recombining/
      // paraphrasing third sub ("production and sales trends" alongside both halves)
      expect(deep).toContain("EXACT PARTITION");
      expect(deep).toContain("NOTHING ELSE");
    }
  });
});

// Tako /v3/search handles multi-entity questions poorly, so every query composer must
// carry the ONE-entity-per-query rule, and the decomposer must emit a validated
// entity-first lookup (1-3 candidate names + optional NER label + 1-3 metric substring
// filters) per question, splitting on any comparison/"and".
describe("lookup rules in prompts", () => {
  it("every compose prompt forbids multi-entity queries", () => {
    for (const p of [COMPOSE_SYSTEM, SEARCH_LEAF_COMPOSE_SYSTEM]) {
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

  // The synthesis (root) node never searches: its children + the gap round own all
  // data gathering. There must be no broad/overview composer to hand it queries.
  it("no broad/overview composer exists — the synthesis node cannot search", async () => {
    const prompts = await import("./prompts");
    expect((prompts as Record<string, unknown>).BROAD_COMPOSE_SYSTEM).toBeUndefined();
    expect((prompts as Record<string, unknown>).SEARCH_BROAD_COMPOSE_SYSTEM).toBeUndefined();
  });

  // Sub-questions exist to CUMULATIVELY answer the parent: each contributes a distinct
  // necessary piece; overlapping subs merge, non-contributing subs drop (observed:
  // "shelter costs" + "housing costs" as separate subs, and a third sub recombining
  // its siblings).
  it("decompose demands cumulative, non-overlapping contribution to the parent", () => {
    expect(DECOMPOSE_SYSTEM).toContain("CUMULATIVELY ANSWER THE PARENT");
    expect(DECOMPOSE_SYSTEM).toContain("DISTINCT, NECESSARY piece");
    expect(DECOMPOSE_SYSTEM).toContain("MERGE them into one");
    expect(DECOMPOSE_SYSTEM).toContain("restate or paraphrase the parent");
    expect(DECOMPOSE_SYSTEM).toContain(`"shelter costs" AND "housing costs"`); // the observed failure, taught as a BAD example
  });

  // Gap-fill questions must be narrow single-subject lookups that serve the original
  // question — never a broad restatement of it, and never a surface the evidence
  // digest already covers (observed live: "which CPI components contribute most to
  // inflation" came back as a gap for "what is driving US inflation").
  it("gap analysis demands narrow, non-overlapping gaps — never a restated question", () => {
    expect(GAP_SYSTEM).toContain("NARROW lookup");
    expect(GAP_SYSTEM).toContain("NEVER a restatement");
    expect(GAP_SYSTEM).toContain("IS the question, not a gap");
    expect(GAP_SYSTEM).toContain("NOT a gap");
    expect(GAP_SYSTEM).toContain("never a better version of what exists");
  });

  // Observed live: "top 3 biggest Asian semiconductor companies" was researched with
  // exactly 3 members, then the gap round added MORE companies. The roster closes once
  // every asked-for/named subject has a sub-answer — gaps fill measures, not members.
  it("gap analysis never expands the subject roster beyond the question's own enumeration", () => {
    expect(GAP_SYSTEM).toContain("roster is CLOSED");
    expect(GAP_SYSTEM).toContain("NEVER introduce a NEW subject");
    expect(GAP_SYSTEM).toContain("scope creep, not a gap");
    expect(GAP_SYSTEM).not.toContain(`missing obvious members`); // the old open-ended ranking bullet is gone
  });

  // The leaf composers serve ANSWERING the sub-question; the metric menu is the
  // preferred means, with Tako's web-source fallback as the worst case — so an
  // empty/faithful hand-over beats menu-forcing.
  it("leaf composers know web sources are the fallback — answer the question, don't force the menu", () => {
    expect(COMPOSE_SYSTEM).toContain("WEB SOURCES");
    expect(COMPOSE_SYSTEM).toContain("ANSWERING the SUB_QUESTION is");
    expect(COMPOSE_SYSTEM).toContain("preferred means, never the goal");
    expect(SEARCH_LEAF_COMPOSE_SYSTEM).toContain("WEB SOURCES");
    expect(SEARCH_LEAF_COMPOSE_SYSTEM).toContain("stay faithful to the question");
  });

  // Regression: the composer emitted near-synonym queries ("Nvidia Revenue", "Nvidia
  // Total Revenue", "Nvidia revenue growth") that all resolve to ONE revenue card,
  // producing duplicate knowledge cards. The prompt must collapse same-series wordings
  // and frame each query as answering a distinct data need, not entity×metric pairing.
  it("compose collapses near-synonym metrics into one query and answers the question, not a cross-product", () => {
    expect(COMPOSE_SYSTEM).toContain("NEAR-SYNONYM metric names are the SAME series");
    expect(COMPOSE_SYSTEM).toContain("emit ONE revenue query, not three");
    expect(COMPOSE_SYSTEM).toContain("not a mechanical entity-by-metric cross-product");
    expect(COMPOSE_SYSTEM).toContain("the FEWEST that ANSWER the SUB_QUESTION");
  });

  // The composer's gather phase sees catalogs only: cached series are instant reads,
  // uncached fetches are budgeted, and chart-bound series must be read in this phase
  // (the report can only chart what was read).
  it("report gather reads chart-bound series and treats uncached fetches as costly", () => {
    expect(REPORT_GATHER_SYSTEM).toContain("cached:true cards return instantly");
    expect(REPORT_GATHER_SYSTEM).toContain("sparingly");
    expect(REPORT_GATHER_SYSTEM).toContain("get_web_content");
    expect(REPORT_GATHER_SYSTEM).toContain("the report can only chart series you read");
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
    expect(DECOMPOSE_SYSTEM).toContain("every plan still requires entities + metricFilters");
  });

  // Grounding is a conditional planning aid: the plan itself asks for fresh context
  // only when the split depends on current data, and a thin/absent grounded answer
  // must never talk the model out of splitting (the Toyota atomic collapse).
  it("decompose asks for fresh context only when the split needs current data", () => {
    expect(DECOMPOSE_SYSTEM).toContain("needsFreshContext");
    expect(DECOMPOSE_SYSTEM).toContain("canonical domain knowledge");
    expect(DECOMPOSE_SYSTEM).toContain("still return your best plan in THIS response");
    expect(DECOMPOSE_SYSTEM).toContain("NEVER justifies fewer sub-questions");
  });

  // Regression: "research the sectors healthcare, finance, and software" was flagged
  // as a cohort — but the question ENUMERATES its subjects, so there is nothing to
  // resolve; it must be a normal split, one sub-question per named subject.
  it("a question that names its subjects is a split, never a cohort", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ENUMERATES");
    expect(DECOMPOSE_SYSTEM).toContain("NOT a cohort");
  });

  // A mechanism/driver question about a class ("how do defense contractors maintain
  // competitive advantages") is still NOT a cohort — it SPLITS into the drivers as
  // facet sub-questions, each with a concrete subject.
  it("mechanism/driver questions about a class split into facets, not a cohort", () => {
    expect(DECOMPOSE_SYSTEM).toContain("mechanism/driver question about a class");
    expect(DECOMPOSE_SYSTEM).toContain("SPLIT into the drivers as facet sub-questions");
  });

  // The company members of a sector/industry (optionally scoped to a region/market)
  // are unknowable from the question text, so such a question IS a cohort — resolved
  // via a grounded answer, never guessed from the model's own domain knowledge.
  it("a sector/industry in a region is a cohort resolved via grounding, not guessed", () => {
    expect(DECOMPOSE_SYSTEM).toContain("sector or industry, optionally scoped to a region/market");
    expect(DECOMPOSE_SYSTEM).toContain("name the members yourself from domain knowledge");
  });

  // Cohorts are no longer root-only: a question naming several sectors splits one
  // sub-question per sector, and each of those sub-questions is itself a cohort.
  it("cohorts can appear at any level — multi-sector questions split into per-sector cohorts", () => {
    expect(DECOMPOSE_SYSTEM).toContain("A cohort can appear at ANY level");
    expect(DECOMPOSE_SYSTEM).toContain("of those sub-questions is ITSELF a cohort");
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

  it("decompose splits per distinct subject but folds related measures into one sub", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ONE subject + ONE measure");
    expect(DECOMPOSE_SYSTEM).toContain("per DISTINCT subject");
    expect(DECOMPOSE_SYSTEM).toContain("one sub-question per facet"); // single-subject multi-facet questions still split
    // broad "research X" requests are always a facet split (observed Toyota collapse)
    expect(DECOMPOSE_SYSTEM).toContain("research all the updated company information of");
    expect(DECOMPOSE_SYSTEM).toContain("ALWAYS a multi-facet split");
    // Related measures of one subject share a sub-question (metricFilters carries both) —
    // the old subject×measure fan-out ("4 subs") is gone.
    expect(DECOMPOSE_SYSTEM).toContain(`metricFilters ["revenue", "margin"]), NOT 4`);
    expect(DECOMPOSE_SYSTEM).not.toContain("spread wide");
    expect(DECOMPOSE_SYSTEM).toContain("per genuinely distinct facet");
    expect(DECOMPOSE_SYSTEM).toContain("Do not drop a real facet"); // splitting stays the default for real facets
    expect(DECOMPOSE_SYSTEM).toContain("MERGE any two sub-questions");
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

  // `label` is an NER ranking boost for the entity search; the full enum must be IN the
  // prompt (structuredOutputs is off — the model has to see the legal values), interpolated
  // from GRAPH_LABELS so schema and prompt can't drift. Spot-check both ends.
  it("decompose interpolates the full label enum and teaches omit-when-unsure", () => {
    expect(DECOMPOSE_SYSTEM).toContain("label");
    expect(DECOMPOSE_SYSTEM).toContain("ORG");
    expect(DECOMPOSE_SYSTEM).toContain("WEBSITE");
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
  // same lookup shape (and carry the label enum too).
  it("gap analysis asks for entity-first lookups", () => {
    expect(GAP_SYSTEM).toContain("entities");
    expect(GAP_SYSTEM).toContain("metricFilters");
    expect(GAP_SYSTEM).toContain("STOCK_TICKER"); // label enum interpolated here too
    expect(GAP_SYSTEM).not.toContain("ONE entity and ONE metric");
  });

  // discoverMetrics is gone: no standalone-series row reaches the composer anymore.
  it("compose prompts no longer mention standalone series", () => {
    expect(COMPOSE_SYSTEM).not.toContain("Standalone series");
  });

  // Regression: compose emitted analytical/causal questions ("How has Costco's GMV
  // affected customer loyalty?") — search COLLECTS data series; analysis happens in
  // synthesis. Queries must be data-retrieval asks (entity + metric + time), and the
  // short noun-phrase form demonstrably retrieves cards the long question form misses
  // ("US shelter CPI this year" → card; the full question → 0 cards).
  it("compose demands data-retrieval queries and bans analytical/causal phrasing", () => {
    expect(COMPOSE_SYSTEM).toContain("COLLECT");
    expect(COMPOSE_SYSTEM).toContain("affected"); // the observed failure shape, taught as a NEVER
    expect(COMPOSE_SYSTEM).toContain("US shelter CPI this year"); // the proven-recall noun-phrase example
    expect(COMPOSE_SYSTEM).not.toContain("How has US shelter CPI changed in 2025?"); // old question-style example gone
  });

  // Answer-only cohorts: the class no longer needs a single graph "anchor" — its
  // entities seed the broad view while members come from the grounded answer.
  it("decompose does not require a single anchor entity for a cohort", () => {
    expect(DECOMPOSE_SYSTEM).not.toContain("MUST name the ANCHOR");
    expect(DECOMPOSE_SYSTEM).toContain('you do NOT need a single real "anchor" entity');
  });

  // The COHORT_MEMBERS second pass produces one sub-question per member, and that
  // split holds even at deeper nodes where the depth-lean otherwise pushes atomic.
  it("decompose handles a COHORT_MEMBERS second pass regardless of depth lean", () => {
    expect(DECOMPOSE_SYSTEM).toContain("COHORT_MEMBERS");
    expect(DECOMPOSE_SYSTEM).toContain("do not set \`cohort\` again");
    expect(DECOMPOSE_SYSTEM).toContain("a resolved COHORT_MEMBERS list is always a split, never atomic");
  });
});

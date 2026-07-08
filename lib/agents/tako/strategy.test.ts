import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  leaf: [] as string[],    // queries the mocked LLM returns for search-leaf-compose
  broad: [] as string[],   // queries for search-broad-compose / broad-compose
  grounded: [] as string[], // queries for the grounded compose (the leaf's primary composer)
  compose: [] as string[],  // queries for the last-resort free compose
  prompts: [] as { label: string; prompt: string }[], // every generateStructured call
  searchNodes: [] as any[],           // entity-typed graphSearch results (default for every term)
  entityNodesByTerm: {} as Record<string, any[]>, // per-term entity results (overrides searchNodes)
  metricNodesByTerm: {} as Record<string, any[]>, // metric-typed graphSearch results per query term
  metricSearchError: false,           // metric-typed graphSearch throws when true
  searchCalls: [] as any[],           // captured graphSearch (q, opts), in call order
  relatedByNode: {} as Record<string, any[]>, // fixed graphRelated result per node id (checked first)
  relatedByCall: [] as any[][],       // graphRelated result per successive call (fallback queue)
  relatedCalls: [] as any[],          // captured graphRelated {nodeId, ...opts}, in call order
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    h.prompts.push({ label: opts.label, prompt: opts.prompt });
    if (opts.label === "search-leaf-compose") return { queries: h.leaf };
    if (opts.label === "search-broad-compose") return { queries: h.broad };
    if (opts.label === "grounded-compose") return { queries: h.grounded };
    if (opts.label === "compose") return { queries: h.compose };
    if (opts.label === "broad-compose") return { queries: h.broad };
    return {};
  }),
}));

vi.mock("./graph", () => ({
  graphSearch: vi.fn(async (q: string, opts: any) => {
    h.searchCalls.push({ q, opts });
    if (opts?.types === "metric") {
      if (h.metricSearchError) throw new Error("metric search down");
      return h.metricNodesByTerm[q] ?? [];
    }
    return h.entityNodesByTerm[q] ?? h.searchNodes;
  }),
  graphRelated: vi.fn(async (nodeId: string, opts: any) => {
    h.relatedCalls.push({ nodeId, ...opts });
    if (h.relatedByNode[nodeId]) return h.relatedByNode[nodeId];
    return h.relatedByCall.shift() ?? [];
  }),
}));

import { searchStrategy, graphStrategy } from "./strategy";
import type { ResearchCtx } from "./research";

// searchStrategy only reads ctx.req + ctx.notes; graphStrategy also touches
// ctx.resolved / ctx.related / ctx.timings.
function stubCtx(): ResearchCtx {
  return {
    req: {
      canvasId: "c", message: "q", surface: "main",
      canvasState: { nodes: [], edges: [] }, providerId: "tako-search",
      takoAnswerEnabled: true, history: [],
    },
    notes: [],
    resolved: [],
    related: [],
    timings: { graph: 0, search: 0, decompose: 0, stream: 0 },
  } as unknown as ResearchCtx;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.leaf = []; h.broad = []; h.grounded = []; h.compose = []; h.prompts = [];
  h.searchNodes = []; h.entityNodesByTerm = {}; h.relatedByNode = {}; h.relatedByCall = []; h.relatedCalls = [];
  h.metricNodesByTerm = {}; h.metricSearchError = false; h.searchCalls = [];
});

describe("searchStrategy", () => {
  it("composes leaf queries from the sub-question with an empty graph", async () => {
    h.leaf = ["US inflation rate 2024", "core CPI trend"];
    const plan = await searchStrategy.leafQueries(stubCtx(), "how is inflation trending?", [], []);
    expect(plan.graph).toEqual([]);
    expect(plan.queries).toEqual(["US inflation rate 2024", "core CPI trend"]);
  });

  it("caps leaf queries at 3 and drops near-duplicates", async () => {
    h.leaf = ["Nvidia revenue", "Nvidia revenue growth", "Nvidia data center revenue", "Nvidia gross margin", "Nvidia operating income"];
    const plan = await searchStrategy.leafQueries(stubCtx(), "nvidia financials", [], []);
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(new Set(plan.queries).size).toBe(plan.queries.length); // no exact dups
  });

  it("caps broad queries at 2 with an empty graph", async () => {
    h.broad = ["US economy overview", "US GDP growth", "US inflation overview"];
    const plan = await searchStrategy.broadQueries(stubCtx(), "how is the US economy doing?", [], []);
    expect(plan.graph).toEqual([]);
    expect(plan.queries.length).toBeLessThanOrEqual(2);
  });

  it("returns empty queries (not throw) when the LLM call fails", async () => {
    const { generateStructured } = await import("../../llm");
    (generateStructured as any).mockRejectedValueOnce(new Error("boom"));
    const ctx = stubCtx();
    const plan = await searchStrategy.leafQueries(ctx, "anything", [], []);
    expect(plan.queries).toEqual([]);
    expect(plan.graph).toEqual([]);
    expect(ctx.notes.some((n) => n.includes("search-leaf compose failed"))).toBe(true);
  });
});

// Shared fixtures
const TESLA = { id: "tesla-id", name: "Tesla", type: "entity" };
const APPLES = { id: "apples-id", name: "Apples", type: "entity", subtype: "Agricultural Products" };
const APPLE_INC = { id: "apple-inc-id", name: "Apple Inc.", type: "entity", subtype: "Companies" };
const APPLE_VALLEY = { id: "apple-valley-id", name: "Apple Valley, CA", type: "entity", subtype: "Cities" };
const ETF = { id: "botz-id", name: "Global X Robotics & AI ETF", type: "entity" };
const CPI_SHELTER = { id: "m-cpi-shelter", name: "CPI Shelter (Seasonally Adjusted)", type: "metric", aliases: ["shelter CPI", "shelter inflation"], description: "CPI for shelter." };
const SHELTER_INFL = { id: "m-shelter-infl", name: "Shelter Inflation Rate (Seasonally Adjusted)", type: "metric", aliases: ["housing cost inflation"], description: "YoY shelter inflation." };

describe("graphStrategy — deterministic pair budget (2 searches, top-2 related fan-out)", () => {
  it("runs exactly ONE entity search and ONE metric search — terms never cross namespaces", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    await graphStrategy.leafQueries(stubCtx(), "q", ["Tesla", "BYD"], ["revenue", "gross margin"]);
    const entitySearches = h.searchCalls.filter((c) => c.opts?.types === "entity").map((c) => c.q);
    const metricSearches = h.searchCalls.filter((c) => c.opts?.types === "metric").map((c) => c.q);
    expect(entitySearches).toEqual(["Tesla"]);   // ONLY entities[0]; never in the metric namespace
    expect(metricSearches).toEqual(["revenue"]); // ONLY metrics[0]; never in the entity namespace
  });

  it("fans related out to the top-2 entity nodes AND top-2 metric nodes, all relation=metric", async () => {
    h.entityNodesByTerm = { Apple: [APPLES, APPLE_INC, APPLE_VALLEY] }; // 3 hits → only top 2 fan out
    h.metricNodesByTerm = { revenue: [
      { id: "m1", name: "Total Revenue", type: "metric" },
      { id: "m2", name: "Revenue Growth", type: "metric" },
      { id: "m3", name: "Junk Metric", type: "metric" },
    ] };
    h.relatedByNode = {
      "apples-id": [{ name: "Agricultural Export Value", aliases: [] }],
      "apple-inc-id": [{ name: "Revenues", aliases: [] }],
      m1: [], m2: [],
    };
    h.grounded = ["How much Revenues did Apple Inc. make?"];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how is Apple doing?", ["Apple"], ["revenue"]);
    // Every related call looks for METRICS, on exactly the top-2 nodes of each search.
    expect(h.relatedCalls.every((c) => c.relationType === "metric")).toBe(true);
    const relatedNodes = h.relatedCalls.map((c) => c.nodeId);
    expect(relatedNodes).toContain("apples-id");
    expect(relatedNodes).toContain("apple-inc-id");
    expect(relatedNodes).toContain("m1");
    expect(relatedNodes).toContain("m2");
    expect(relatedNodes).not.toContain("apple-valley-id"); // 3rd entity hit: no fan-out
    expect(relatedNodes).not.toContain("m3");              // 3rd metric hit: no fan-out
    // BOTH entity nodes become resolved rows — the junk first hit can't crowd out the right one.
    expect(plan.graph).toContainEqual({ entity: "Apples", related: ["Agricultural Export Value"], kind: "entity" });
    expect(plan.graph).toContainEqual({ entity: "Apple Inc.", related: ["Revenues"], kind: "entity" });
    expect(plan.queries).toEqual(["How much Revenues did Apple Inc. make?"]);
  });

  it("reports the graph phase wall-clock on the plan", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[]];
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", ["Tesla"], []);
    expect(typeof plan.graphMs).toBe("number");
    expect(plan.graphMs).toBeGreaterThanOrEqual(0);
  });
});

describe("graphStrategy.resolveGraph (related metric fetch)", () => {
  it("filters by the SHORT metric term — never the question or the entity name", async () => {
    h.searchNodes = [ETF];
    h.relatedByCall = [[{ name: "Closing Price", aliases: [] }]]; // hinted call succeeds
    h.grounded = ["How has the Global X Robotics & AI ETF's Closing Price moved this year?"];
    const plan = await graphStrategy.leafQueries(
      stubCtx(),
      "How is the Global X Robotics ETF performing this year?",
      ["Global X Robotics & AI ETF"],
      ["price"],
    );
    // One related call on the entity node, filtered by the short term — not the sentence, not the name.
    const entityRelated = h.relatedCalls.filter((c) => c.nodeId === ETF.id);
    expect(entityRelated).toHaveLength(1);
    expect(entityRelated[0]).toMatchObject({ relationType: "metric", q: "price" });
    expect(entityRelated[0].q).not.toContain("Global X"); // never the entity name
    expect(entityRelated[0].q).not.toContain("performing"); // never the question sentence
    expect(plan.graph).toContainEqual({ entity: ETF.name, related: ["Closing Price"], kind: "entity" });
    expect(plan.queries).toContain(h.grounded[0]);
  });

  it("retries WITHOUT q when the hinted fetch returns 0 — surfacing the full menu", async () => {
    h.searchNodes = [ETF];
    // First (hinted) call is empty; second (no-q) call returns the real menu.
    h.relatedByCall = [[], [{ name: "Closing Price", aliases: [] }, { name: "Trading Volume", aliases: [] }]];
    h.grounded = ["What is the Global X Robotics & AI ETF's Trading Volume lately?"];
    const plan = await graphStrategy.leafQueries(
      stubCtx(), "any question", ["Global X Robotics & AI ETF"], ["nonexistent-metric-phrase"],
    );
    const entityRelated = h.relatedCalls.filter((c) => c.nodeId === ETF.id);
    expect(entityRelated).toHaveLength(2);
    expect(entityRelated[0]).toMatchObject({ relationType: "metric", q: "nonexistent-metric-phrase" });
    expect(entityRelated[1].q).toBeUndefined(); // retry sends no q → full menu
    expect(plan.graph).toContainEqual({ entity: ETF.name, related: ["Closing Price", "Trading Volume"], kind: "entity" });
    expect(plan.queries).toContain(h.grounded[0]);
  });

  it("fetches the full menu in ONE no-q call when there is no metric term", async () => {
    h.searchNodes = [ETF];
    h.relatedByCall = [[{ name: "Closing Price", aliases: [] }]];
    await graphStrategy.leafQueries(stubCtx(), "how is it doing?", ["Global X Robotics & AI ETF"], []);
    expect(h.relatedCalls).toHaveLength(1); // no term → single full-menu fetch, no redundant retry
    expect(h.relatedCalls[0]).toMatchObject({ relationType: "metric", limit: 40 });
    expect(h.relatedCalls[0].q).toBeUndefined();
  });
});

describe("graphStrategy metric discovery (metric namespace side)", () => {
  it("canonicalizes the metric term; hits + siblings land in plan.metrics", async () => {
    h.searchNodes = [TESLA];
    h.metricNodesByTerm = { revenue: [
      { id: "m1", name: "Total Revenue", type: "metric" },
      { id: "m2", name: "Revenue Growth", type: "metric" },
    ] };
    h.relatedByNode = { m1: [{ name: "Revenue Per Employee", aliases: [] }], m2: [] };
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    // planner term first, then search hits, then siblings — CI-deduped
    expect(plan.metrics).toEqual(["revenue", "Total Revenue", "Revenue Growth", "Revenue Per Employee"]);
  });

  it("dedupes discovered names case-insensitively against the planner metric", async () => {
    h.searchNodes = [TESLA];
    h.metricNodesByTerm = { "Total Revenue": [{ id: "m1", name: "total revenue", type: "metric" }] }; // CI-dup of the planner term
    h.relatedByNode = { m1: [{ name: "Trading Volume", aliases: [] }] };
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", ["Tesla"], ["Total Revenue"]);
    expect(plan.metrics).toEqual(["Total Revenue", "Trading Volume"]); // planner casing wins, no CI dup
  });

  it("swallows metric-search failures — entity resolution and compose unaffected", async () => {
    h.searchNodes = [TESLA];
    h.metricSearchError = true;
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    h.grounded = ["How much Total Revenue does Tesla make?"];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    expect(plan.queries).toContain(h.grounded[0]); // grounded path still works
    expect(plan.metrics).toEqual(["revenue"]); // just the planner guess survives
    expect(ctx.notes.some((n) => n.includes("metric graph search failed"))).toBe(true);
  });

  it("falls back to mechanical entity×metric pairs from the PLANNER terms only", async () => {
    // Regression (GLP-1 → "AI Adoption Rate"): graph metric discovery keyword-matches series
    // about unrelated topics; when compose keeps nothing, the no-LLM fallback must NOT pair the
    // entity with discovered names — only the planner's own term. Relevance of discovered names
    // is the compose LLM's call; the mechanical ladder cannot judge it.
    h.searchNodes = [TESLA];
    h.metricNodesByTerm = { revenue: [{ id: "m1", name: "Total Revenue", type: "metric" }] };
    h.relatedByNode = { m1: [] };
    h.relatedByCall = [[{ name: "Employee Count", aliases: [] }]];
    h.grounded = []; // compose keeps nothing → mechanical fallback
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    expect(plan.queries).toContain("Tesla revenue"); // planner pair only
    expect(plan.queries).not.toContain("Tesla Total Revenue"); // discovered names never reach the fallback
    expect(plan.metrics).toEqual(["revenue", "Total Revenue"]); // trace enrichment unchanged
  });

  it("ONE grounded-compose over the full deterministic list — question-style queries (shelter repro)", async () => {
    // Entity search fuzzy-matches a junk city for "shelter costs" — kept, NOT gated.
    h.searchNodes = [{ id: "sc-id", name: "Shelter Cove, CA", type: "entity" }];
    h.metricNodesByTerm = { "shelter CPI": [CPI_SHELTER, SHELTER_INFL] };
    h.relatedByNode = { [CPI_SHELTER.id]: [], [SHELTER_INFL.id]: [] };
    // Hinted related fetch misses, no-q retry returns the city's junk menu.
    h.relatedByCall = [[], [{ name: "Population", aliases: [] }]];
    h.grounded = ["How has US shelter inflation changed this year?"]; // cites the "shelter inflation" alias
    const plan = await graphStrategy.leafQueries(
      stubCtx(), "how are shelter costs affecting inflation?", ["shelter costs"], ["shelter CPI"],
    );
    // Exactly one composer call; no per-entity filter or standalone compose.
    expect(h.prompts.filter((p) => p.label === "grounded-compose")).toHaveLength(1);
    expect(h.prompts.some((p) => p.label === "metric-filter" || p.label === "standalone-compose")).toBe(false);
    // The compose saw the sub-question AND the full deterministic list.
    const gc = h.prompts.find((p) => p.label === "grounded-compose");
    expect(gc?.prompt).toContain("how are shelter costs affecting inflation?");
    expect(gc?.prompt).toContain("Shelter Cove, CA: "); // entity + its menu
    expect(gc?.prompt).toContain("Standalone series");
    expect(gc?.prompt).toContain("CPI Shelter (Seasonally Adjusted)");
    // Question-style composed query used; NO bare metric-name query.
    expect(plan.queries).toEqual([h.grounded[0]]);
    // Trace rows: entity row + kind:"metric" row with the discovered series.
    expect(plan.graph).toContainEqual({ entity: "Shelter Cove, CA", related: ["Population"], kind: "entity" });
    expect(plan.graph).toContainEqual({
      entity: "metric search",
      related: ["CPI Shelter (Seasonally Adjusted)", "Shelter Inflation Rate (Seasonally Adjusted)"],
      kind: "metric",
    });
  });

  it("guard drops composed queries that cite no listed metric", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[{ name: "Total Revenue", aliases: ["Sales"] }]];
    h.grounded = [
      "How much did Tesla grow Sales last year?", // cites the "Sales" alias → kept
      "Is Tesla a good company culturally?",      // cites nothing listed → dropped
    ];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    expect(plan.queries).toEqual(["How much did Tesla grow Sales last year?"]);
    expect(ctx.notes.some((n) => n.includes("cites no listed metric"))).toBe(true);
  });

  it("caps composed queries at 3 and collapses near-duplicates", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }, { name: "Gross Margin", aliases: [] }]];
    h.grounded = [
      "Tesla Total Revenue this year",
      "Tesla Total Revenue this year",   // exact dup
      "Tesla Total Revenue trend 2025",  // near dup
      "What is Tesla's Gross Margin now?",
    ];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(plan.queries.filter((q) => q === "Tesla Total Revenue this year").length).toBe(1);
  });

  it("pools metric-search hits before their related siblings", async () => {
    h.metricNodesByTerm = { "shelter costs": [CPI_SHELTER, SHELTER_INFL] };
    h.relatedByNode = {
      [CPI_SHELTER.id]: [{ name: "Sibling A", aliases: [] }],
      [SHELTER_INFL.id]: [{ name: "Sibling B", aliases: [] }],
    };
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", [], ["shelter costs"]);
    const metricRow = plan.graph.find((g) => g.kind === "metric");
    // The nodes that matched the term lead the pool; siblings follow.
    expect(metricRow?.related).toEqual([
      "CPI Shelter (Seasonally Adjusted)",
      "Shelter Inflation Rate (Seasonally Adjusted)",
      "Sibling A",
      "Sibling B",
    ]);
  });

  it("omits the metric-search graph row when discovery found nothing", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    h.grounded = ["How much Total Revenue does Tesla make?"];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    expect(plan.graph).toEqual([{ entity: "Tesla", related: ["Total Revenue"], kind: "entity" }]);
  });

  it("free compose (last resort) fires with '(none)' only when everything else came up empty", async () => {
    // No entity term → nothing resolves; discovery finds a series but the compose returns nothing.
    h.metricNodesByTerm = { "shelter costs": [CPI_SHELTER] };
    h.relatedByNode = { [CPI_SHELTER.id]: [] };
    h.grounded = []; // grounded compose keeps nothing
    h.compose = ["US CPI shelter trend 2025"];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how are shelter costs trending?", [], ["shelter costs"]);
    const gc = h.prompts.find((p) => p.label === "grounded-compose");
    expect(gc?.prompt).toContain("CPI Shelter (Seasonally Adjusted)"); // saw the standalone series
    const free = h.prompts.find((p) => p.label === "compose");
    expect(free?.prompt).toContain("(none)");
    expect(plan.queries).toEqual(["US CPI shelter trend 2025"]);
  });

  it("records every graph call (search + related) with exact params and results", async () => {
    h.searchNodes = [TESLA];
    h.metricNodesByTerm = { revenue: [{ id: "m1", name: "Total Revenue", type: "metric", aliases: ["Sales"] }] };
    h.relatedByNode = { m1: [] };
    h.relatedByCall = [[{ id: "r1", name: "Total Revenue", aliases: [] }]];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    const calls = plan.graphCalls ?? [];
    // entity search
    const ent = calls.find((c) => c.endpoint === "graph/search" && c.params.types === "entity");
    expect(ent?.params.q).toBe("Tesla");
    expect(ent?.results.map((r) => r.name)).toEqual(["Tesla"]);
    // exactly ONE metric-namespace search: the metric term
    const mets = calls.filter((c) => c.endpoint === "graph/search" && c.params.types === "metric");
    expect(mets.map((c) => c.params.q)).toEqual(["revenue"]);
    expect(mets[0]?.results[0]).toMatchObject({ name: "Total Revenue", aliases: ["Sales"] });
    // entity-node related fetch with its exact params
    const rel = calls.find((c) => c.endpoint === "graph/related" && c.params.node_id === "tesla-id");
    expect(rel?.params).toMatchObject({ node_id: "tesla-id", relation_type: "metric", q: "revenue" });
    expect(rel?.results.map((r) => r.name)).toEqual(["Total Revenue"]);
    // metric-node sibling fetch recorded too
    const sib = calls.find((c) => c.endpoint === "graph/related" && c.params.node_id === "m1");
    expect(sib?.params).toMatchObject({ node_id: "m1", relation_type: "metric" });
  });

  it("records a failed graph call with its error", async () => {
    h.searchNodes = [TESLA];
    h.metricSearchError = true;
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", ["Tesla"], ["revenue"]);
    const failed = (plan.graphCalls ?? []).filter((c) => c.error);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0].error).toContain("metric search down");
    expect(failed[0].results).toEqual([]);
  });

  it("broadQueries passes standalone series to broad-compose and returns the enriched list", async () => {
    h.searchNodes = [TESLA];
    h.metricNodesByTerm = { revenue: [{ id: "m1", name: "Total Revenue", type: "metric" }] };
    h.relatedByNode = { m1: [] };
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    h.broad = ["Tesla overview"];
    const plan = await graphStrategy.broadQueries(stubCtx(), "how is Tesla doing?", ["Tesla"], ["revenue"]);
    expect(plan.metrics).toEqual(["revenue", "Total Revenue"]);
    const bc = h.prompts.find((p) => p.label === "broad-compose");
    expect(bc?.prompt).toContain("Standalone series");
    expect(bc?.prompt).toContain("Total Revenue");
  });
});

describe("graphStrategy multi-entity query guard", () => {
  it("drops composed queries naming 2+ distinct resolved nodes — single-entity queries survive", async () => {
    h.entityNodesByTerm = { Apple: [APPLES, APPLE_INC] }; // one TERM, two distinct top nodes
    h.relatedByNode = {
      "apples-id": [{ name: "Revenue", aliases: [] }],
      "apple-inc-id": [{ name: "Revenue", aliases: [] }],
    };
    h.grounded = [
      "How do Apples and Apple Inc. Revenue compare?",  // names BOTH resolved nodes → dropped
      "How much Revenue did Apple Inc. make?",          // one node → kept
    ];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "how is Apple doing?", ["Apple"], ["Revenue"]);
    expect(plan.queries).toEqual(["How much Revenue did Apple Inc. make?"]);
    expect(ctx.notes.some((n) => n.includes("names multiple entities"))).toBe(true);
  });

  it("treats textually overlapping node names as ONE subject", async () => {
    h.entityNodesByTerm = { Tesla: [{ id: "t1", name: "Tesla", type: "entity" }, { id: "t2", name: "Tesla, Inc.", type: "entity" }] };
    h.relatedByNode = {
      t1: [{ name: "Total Revenue", aliases: [] }],
      t2: [{ name: "Total Revenue", aliases: [] }],
    };
    h.grounded = ["How much Total Revenue did Tesla, Inc. make?"]; // contains "Tesla" AND "Tesla, Inc." — same subject
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "how much does Tesla earn?", ["Tesla"], ["revenue"]);
    expect(plan.queries).toEqual(["How much Total Revenue did Tesla, Inc. make?"]);
    expect(ctx.notes.some((n) => n.includes("names multiple entities"))).toBe(false);
  });

  it("falls back to term×metric pairs when EVERY composed query names multiple nodes", async () => {
    h.entityNodesByTerm = { Apple: [APPLES, APPLE_INC] };
    h.relatedByNode = {
      "apples-id": [{ name: "Revenue", aliases: [] }],
      "apple-inc-id": [{ name: "Revenue", aliases: [] }],
    };
    h.grounded = ["How do Apples and Apple Inc. Revenue compare?"]; // all dropped by the guard
    const plan = await graphStrategy.leafQueries(stubCtx(), "how is Apple doing?", ["Apple"], ["Revenue"]);
    expect(plan.queries).toEqual(["Apple Revenue"]); // mechanical fallback from the planner TERM
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { GraphLookup } from "../shared/schemas";

const h = vi.hoisted(() => ({
  leaf: [] as string[],    // queries the mocked LLM returns for search-leaf-compose
  broad: [] as string[],   // queries for search-broad-compose / broad-compose
  grounded: [] as string[], // queries for the grounded compose (the leaf's primary composer)
  compose: [] as string[],  // queries for the last-resort free compose
  prompts: [] as { label: string; prompt: string }[], // every generateStructured call
  searchNodes: [] as any[],           // graphSearch results (default for every term)
  entityNodesByTerm: {} as Record<string, any[]>, // per-term results; `${q}|${subtype}` keys override plain `q`
  searchErrorByTerm: {} as Record<string, boolean>, // graphSearch throws for these terms
  searchCalls: [] as any[],           // captured graphSearch (q, opts), in call order
  relatedByNodeQ: {} as Record<string, any[]>, // graphRelated result per `${nodeId}|${q ?? ""}` (checked first)
  relatedByNode: {} as Record<string, any[]>,  // fixed graphRelated result per node id
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
    if (h.searchErrorByTerm[q]) throw new Error("graph search down");
    const keyed = opts?.subtype ? h.entityNodesByTerm[`${q}|${opts.subtype}`] : undefined;
    return keyed ?? h.entityNodesByTerm[q] ?? h.searchNodes;
  }),
  graphRelated: vi.fn(async (nodeId: string, opts: any) => {
    h.relatedCalls.push({ nodeId, ...opts });
    const key = `${nodeId}|${opts?.q ?? ""}`;
    if (h.relatedByNodeQ[key]) return h.relatedByNodeQ[key];
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

const lookup = (entities: string[], metricFilters: string[], subtype?: string): GraphLookup =>
  ({ entities, metricFilters, ...(subtype ? { subtype } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  h.leaf = []; h.broad = []; h.grounded = []; h.compose = []; h.prompts = [];
  h.searchNodes = []; h.entityNodesByTerm = {}; h.searchErrorByTerm = {}; h.searchCalls = [];
  h.relatedByNodeQ = {}; h.relatedByNode = {}; h.relatedByCall = []; h.relatedCalls = [];
});

describe("searchStrategy", () => {
  it("composes leaf queries from the sub-question with an empty graph", async () => {
    h.leaf = ["US inflation rate 2024", "core CPI trend"];
    const plan = await searchStrategy.leafQueries(stubCtx(), "how is inflation trending?", lookup(["US"], ["inflation"]));
    expect(plan.graph).toEqual([]);
    expect(plan.queries).toEqual(["US inflation rate 2024", "core CPI trend"]);
  });

  it("caps leaf queries at 3 and drops near-duplicates", async () => {
    h.leaf = ["Nvidia revenue", "Nvidia revenue growth", "Nvidia data center revenue", "Nvidia gross margin", "Nvidia operating income"];
    const plan = await searchStrategy.leafQueries(stubCtx(), "nvidia financials", lookup(["Nvidia"], ["revenue"]));
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(new Set(plan.queries).size).toBe(plan.queries.length); // no exact dups
  });

  it("caps broad queries at 2 with an empty graph", async () => {
    h.broad = ["US economy overview", "US GDP growth", "US inflation overview"];
    const plan = await searchStrategy.broadQueries(stubCtx(), "how is the US economy doing?", lookup(["US"], ["GDP"]));
    expect(plan.graph).toEqual([]);
    expect(plan.queries.length).toBeLessThanOrEqual(2);
  });

  it("returns empty queries (not throw) when the LLM call fails", async () => {
    const { generateStructured } = await import("../../llm");
    (generateStructured as any).mockRejectedValueOnce(new Error("boom"));
    const ctx = stubCtx();
    const plan = await searchStrategy.leafQueries(ctx, "anything", lookup(["x"], ["y"]));
    expect(plan.queries).toEqual([]);
    expect(plan.graph).toEqual([]);
    expect(ctx.notes.some((n) => n.includes("search-leaf compose failed"))).toBe(true);
  });
});

// Shared fixtures
const TESLA = { id: "tesla-id", name: "Tesla", type: "entity" };
const APPLES = { id: "apples-id", name: "Apples", type: "entity", subtype: "Agricultural Products" };
const APPLE_INC = { id: "apple-inc-id", name: "Apple Inc.", type: "entity", subtype: "Companies" };
const ETF = { id: "botz-id", name: "Global X Robotics & AI ETF", type: "entity" };
const mkNodes = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `${prefix.toUpperCase()} ${i}`, type: "entity" }));

describe("graphStrategy — entity-first search (candidate names + subtype, no metric namespace)", () => {
  it("searches EACH candidate name in the entity namespace — NEVER the metric namespace", async () => {
    h.entityNodesByTerm = { Google: [{ id: "goog", name: "Google", type: "entity" }], Alphabet: [{ id: "abc", name: "Alphabet Inc.", type: "entity" }] };
    await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Google", "Alphabet"], ["revenue"]));
    const entitySearches = h.searchCalls.filter((c) => c.opts?.types === "entity").map((c) => c.q);
    const metricSearches = h.searchCalls.filter((c) => c.opts?.types === "metric");
    expect(entitySearches).toEqual(["Google", "Alphabet"]); // every candidate name, entity namespace only
    expect(metricSearches).toEqual([]);                     // discoverMetrics is GONE — regression lock
  });

  it("forwards the subtype to every name's search, limit 3", async () => {
    h.searchNodes = [APPLE_INC];
    await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Apple Inc.", "Apple"], ["revenue"], "Companies"));
    expect(h.searchCalls).toHaveLength(2);
    for (const c of h.searchCalls) {
      expect(c.opts).toMatchObject({ types: "entity", subtype: "Companies", limit: 3 });
    }
  });

  it("retries a zero-result subtype-filtered search WITHOUT the subtype", async () => {
    h.entityNodesByTerm = { "Tesla|Companies": [], Tesla: [TESLA] };
    h.relatedByCall = [[{ name: "Total Revenue", aliases: [] }]];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "q", lookup(["Tesla"], ["revenue"], "Companies"));
    expect(h.searchCalls).toHaveLength(2);
    expect(h.searchCalls[0].opts.subtype).toBe("Companies");
    expect(h.searchCalls[1].opts.subtype).toBeUndefined(); // retry unfiltered
    expect(ctx.notes.some((n) => n.includes("retrying unfiltered"))).toBe(true);
    expect(plan.graph).toContainEqual({ entity: "Tesla", related: ["Total Revenue"], kind: "entity" });
  });

  it("fans related out to the top-3 nodes of EACH name, deduped by id across names", async () => {
    const shared = { id: "goog", name: "Google", type: "entity" };
    h.entityNodesByTerm = {
      Google: [shared, ...mkNodes("g", 4)],       // 5 hits → only top 3 fan out
      Alphabet: [shared, { id: "abc", name: "Alphabet Inc.", type: "entity" }], // top hit = same node
    };
    await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Google", "Alphabet"], ["revenue"]));
    const relatedNodes = h.relatedCalls.filter((c) => c.q).map((c) => c.nodeId); // filtered fan-out calls
    expect(new Set(relatedNodes).size).toBe(relatedNodes.length); // one call per node×filter, no dup nodes
    expect(relatedNodes).toHaveLength(4); // top-3 of "Google" (goog,g0,g1) + 1 new from "Alphabet" — shared node once
    expect(relatedNodes).toContain("goog");
    expect(relatedNodes).toContain("abc");
    expect(relatedNodes).toContain("g1"); // 3rd hit fans out…
    expect(relatedNodes).not.toContain("g2"); // …but the 4th/5th do not (top-3, subtype makes top hits accurate)
  });

  it("calls related once per node×filter — relation=metric, q=the short filter, limit 8", async () => {
    h.searchNodes = [TESLA];
    h.relatedByNodeQ = {
      "tesla-id|revenue": [{ id: "m1", name: "Total Revenue", aliases: [] }],
      "tesla-id|profit": [{ id: "m2", name: "Gross Profit", aliases: [] }],
    };
    await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Tesla"], ["revenue", "profit"]));
    expect(h.relatedCalls).toHaveLength(2);
    expect(h.relatedCalls[0]).toMatchObject({ nodeId: "tesla-id", relation: "metrics", q: "revenue", limit: 8 });
    expect(h.relatedCalls[1]).toMatchObject({ nodeId: "tesla-id", relation: "metrics", q: "profit", limit: 8 });
  });

  it("filters by the SHORT filter term — never the question or the entity name", async () => {
    h.searchNodes = [ETF];
    h.relatedByCall = [[{ name: "Closing Price", aliases: [] }]];
    h.grounded = ["How has the Global X Robotics & AI ETF's Closing Price moved this year?"];
    const plan = await graphStrategy.leafQueries(
      stubCtx(),
      "How is the Global X Robotics ETF performing this year?",
      lookup(["Global X Robotics & AI ETF"], ["price"]),
    );
    const entityRelated = h.relatedCalls.filter((c) => c.nodeId === ETF.id);
    expect(entityRelated).toHaveLength(1);
    expect(entityRelated[0]).toMatchObject({ relation: "metrics", q: "price" });
    expect(entityRelated[0].q).not.toContain("Global X"); // never the entity name
    expect(entityRelated[0].q).not.toContain("performing"); // never the question sentence
    expect(plan.graph).toContainEqual({ entity: ETF.name, related: ["Closing Price"], kind: "entity" });
    expect(plan.queries).toContain(h.grounded[0]);
  });

  it("caps node×filter pairs at 24, fully covering top-ranked (round-robin) nodes first", async () => {
    h.entityNodesByTerm = { alpha: mkNodes("a", 5), beta: mkNodes("b", 5), gamma: mkNodes("c", 5) };
    const ctx = stubCtx();
    await graphStrategy.leafQueries(ctx, "q", lookup(["alpha", "beta", "gamma"], ["revenue", "profit", "income"]));
    // 3 names × top-3 nodes = 9 nodes × 3 filters = 27 pairs → exactly 24 filtered
    // related calls (plus at most 2 no-q full-menu retries since every menu was empty).
    const filtered = h.relatedCalls.filter((c) => c.q);
    expect(filtered).toHaveLength(24);
    expect(h.relatedCalls.filter((c) => !c.q).length).toBeLessThanOrEqual(2);
    // Node-major: the first 8 nodes in round-robin rank order (a0,b0,c0,a1,b1,c1,a2,b2)
    // each get ALL 3 filters; deeper nodes get none.
    const byNode = new Map<string, number>();
    for (const c of filtered) byNode.set(c.nodeId, (byNode.get(c.nodeId) ?? 0) + 1);
    expect([...byNode.keys()].sort()).toEqual(["a0", "a1", "a2", "b0", "b1", "b2", "c0", "c1"].sort());
    expect([...byNode.values()].every((n) => n === 3)).toBe(true);
    expect(ctx.notes.some((n) => n.includes("capped"))).toBe(true);
  });

  it("merges and dedupes each node's menu across its filters", async () => {
    h.searchNodes = [TESLA];
    h.relatedByNodeQ = {
      "tesla-id|revenue": [{ id: "m1", name: "Total Revenue", aliases: [] }, { id: "m2", name: "Revenue Growth", aliases: [] }],
      "tesla-id|sales": [{ id: "m1", name: "Total Revenue", aliases: [] }, { id: "m3", name: "Sales Per Share", aliases: [] }],
    };
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Tesla"], ["revenue", "sales"]));
    expect(plan.graph).toEqual([
      { entity: "Tesla", related: ["Total Revenue", "Revenue Growth", "Sales Per Share"], kind: "entity" },
    ]);
  });

  it("retries WITHOUT q when ALL of a node's filters return 0 — surfacing the full menu", async () => {
    h.searchNodes = [ETF];
    // Both filtered calls miss; the no-q retry returns the real menu.
    h.relatedByCall = [[], [], [{ name: "Closing Price", aliases: [] }, { name: "Trading Volume", aliases: [] }]];
    h.grounded = ["What is the Global X Robotics & AI ETF's Trading Volume lately?"];
    const plan = await graphStrategy.leafQueries(
      stubCtx(), "any question", lookup(["Global X Robotics & AI ETF"], ["nonexistent-a", "nonexistent-b"]),
    );
    const entityRelated = h.relatedCalls.filter((c) => c.nodeId === ETF.id);
    expect(entityRelated).toHaveLength(3);
    expect(entityRelated[2].q).toBeUndefined(); // retry sends no q → full menu
    expect(entityRelated[2].limit).toBe(40);
    expect(plan.graph).toContainEqual({ entity: ETF.name, related: ["Closing Price", "Trading Volume"], kind: "entity" });
    expect(plan.queries).toContain(h.grounded[0]);
  });

  it("does NOT retry a node whose filters returned anything, and allows at most 2 retries", async () => {
    h.entityNodesByTerm = { alpha: mkNodes("x", 3), beta: [TESLA] };
    // Tesla's filter hits; the 3 x-nodes all miss → only 2 of them get the no-q retry.
    h.relatedByNodeQ = { "tesla-id|revenue": [{ id: "m1", name: "Total Revenue", aliases: [] }] };
    await graphStrategy.leafQueries(stubCtx(), "q", lookup(["alpha", "beta"], ["revenue"]));
    const noQ = h.relatedCalls.filter((c) => c.q === undefined);
    expect(noQ).toHaveLength(2); // 3 all-miss nodes, retry budget 2
    expect(noQ.every((c) => c.nodeId !== "tesla-id")).toBe(true); // hit node never retried
  });

  it("fetches the full menu in ONE no-q call per node when there are no filters", async () => {
    h.searchNodes = [ETF];
    h.relatedByCall = [[{ name: "Closing Price", aliases: [] }]];
    await graphStrategy.leafQueries(stubCtx(), "how is it doing?", lookup(["Global X Robotics & AI ETF"], []));
    expect(h.relatedCalls).toHaveLength(1); // no filters → single full-menu fetch, no redundant retry
    expect(h.relatedCalls[0]).toMatchObject({ relation: "metrics", limit: 40 });
    expect(h.relatedCalls[0].q).toBeUndefined();
  });

  it("reports the graph phase wall-clock on the plan", async () => {
    h.searchNodes = [TESLA];
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Tesla"], ["revenue"]));
    expect(typeof plan.graphMs).toBe("number");
    expect(plan.graphMs).toBeGreaterThanOrEqual(0);
  });
});

describe("graphStrategy grounded compose", () => {
  it("ONE grounded-compose over the deterministic per-entity menus — no standalone series row", async () => {
    h.searchNodes = [TESLA];
    h.relatedByNodeQ = { "tesla-id|revenue": [{ id: "m1", name: "Total Revenue", aliases: ["Sales"], description: "Company revenue." }] };
    h.grounded = ["How much Total Revenue did Tesla make this year?"];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", lookup(["Tesla"], ["revenue"]));
    expect(h.prompts.filter((p) => p.label === "grounded-compose")).toHaveLength(1);
    const gc = h.prompts.find((p) => p.label === "grounded-compose");
    expect(gc?.prompt).toContain("how much does Tesla earn?");
    expect(gc?.prompt).toContain("Tesla: Total Revenue [Sales]"); // entity + its verbatim menu
    expect(gc?.prompt).not.toContain("Standalone series");
    expect(plan.queries).toEqual([h.grounded[0]]);
    expect(plan.metrics).toBeUndefined(); // no discovery enrichment anymore
  });

  it("guard drops composed queries that cite no listed metric", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[{ name: "Total Revenue", aliases: ["Sales"] }]];
    h.grounded = [
      "How much did Tesla grow Sales last year?", // cites the "Sales" alias → kept
      "Is Tesla a good company culturally?",      // cites nothing listed → dropped
    ];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "how much does Tesla earn?", lookup(["Tesla"], ["revenue"]));
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
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", lookup(["Tesla"], ["revenue"]));
    expect(plan.queries.length).toBeLessThanOrEqual(3);
    expect(plan.queries.filter((q) => q === "Tesla Total Revenue this year").length).toBe(1);
  });

  it("falls back to mechanical name×filter pairs from the PLANNER terms when compose keeps nothing", async () => {
    h.searchNodes = [TESLA];
    h.relatedByCall = [[{ name: "Employee Count", aliases: [] }]];
    h.grounded = []; // compose keeps nothing → mechanical fallback
    const plan = await graphStrategy.leafQueries(stubCtx(), "how much does Tesla earn?", lookup(["Tesla"], ["revenue"]));
    expect(plan.queries).toContain("Tesla revenue"); // planner terms only
    expect(plan.queries).not.toContain("Tesla Employee Count"); // resolved names never reach the fallback
  });

  it("free compose (last resort) fires with '(none)' when nothing resolves and the fallback has no pair", async () => {
    // No graph nodes at all; the one name CONTAINS the filter so fallbackQueries yields nothing.
    h.compose = ["US CPI shelter trend 2025"];
    const plan = await graphStrategy.leafQueries(stubCtx(), "how are shelter costs trending?", lookup(["shelter costs"], ["shelter"]));
    const free = h.prompts.find((p) => p.label === "compose");
    expect(free?.prompt).toContain("(none)");
    expect(plan.queries).toEqual(["US CPI shelter trend 2025"]);
  });

  it("records every graph call (search + related) with exact params — including subtype — and results", async () => {
    h.entityNodesByTerm = { "Tesla|Companies": [TESLA] };
    h.relatedByNodeQ = { "tesla-id|revenue": [{ id: "r1", name: "Total Revenue", aliases: [] }] };
    const plan = await graphStrategy.leafQueries(stubCtx(), "q", lookup(["Tesla"], ["revenue"], "Companies"));
    const calls = plan.graphCalls ?? [];
    const ent = calls.find((c) => c.endpoint === "graph/search");
    expect(ent?.params).toMatchObject({ q: "Tesla", types: "entity", subtype: "Companies", limit: 3 });
    expect(ent?.results.map((r) => r.name)).toEqual(["Tesla"]);
    const rel = calls.find((c) => c.endpoint === "graph/related");
    expect(rel?.params).toMatchObject({ node_id: "tesla-id", relation: "metrics", q: "revenue", limit: 8 });
    expect(rel?.subject).toBe("Tesla"); // display name of the entity the fetch was for
    expect(rel?.results.map((r) => r.name)).toEqual(["Total Revenue"]);
  });

  it("contains a failed name's search — other names still resolve, error recorded", async () => {
    h.searchErrorByTerm = { BYD: true };
    h.entityNodesByTerm = { Tesla: [TESLA] };
    h.relatedByNodeQ = { "tesla-id|revenue": [{ id: "m1", name: "Total Revenue", aliases: [] }] };
    h.grounded = ["How much Total Revenue did Tesla make?"];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "q", lookup(["BYD", "Tesla"], ["revenue"]));
    expect(plan.queries).toEqual([h.grounded[0]]); // Tesla side unaffected
    expect(ctx.notes.some((n) => n.includes('graph lookup failed for "BYD"'))).toBe(true);
    const failed = (plan.graphCalls ?? []).filter((c) => c.error);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toContain("graph search down");
    expect(failed[0].results).toEqual([]);
  });

  it("broadQueries grounds broad-compose in the per-entity menus (no standalone series)", async () => {
    h.searchNodes = [TESLA];
    h.relatedByNodeQ = { "tesla-id|revenue": [{ id: "m1", name: "Total Revenue", aliases: [] }] };
    h.broad = ["Tesla overview", "Tesla revenue trend", "extra"];
    const plan = await graphStrategy.broadQueries(stubCtx(), "how is Tesla doing?", lookup(["Tesla"], ["revenue"]));
    const bc = h.prompts.find((p) => p.label === "broad-compose");
    expect(bc?.prompt).toContain("Tesla: Total Revenue");
    expect(bc?.prompt).not.toContain("Standalone series");
    expect(plan.queries).toEqual(["Tesla overview", "Tesla revenue trend"]); // capped at 2
    expect(plan.metrics).toBeUndefined();
  });
});

describe("graphStrategy multi-entity query guard", () => {
  it("drops composed queries naming 2+ distinct resolved nodes — single-entity queries survive", async () => {
    h.entityNodesByTerm = { Apple: [APPLES, APPLE_INC] }; // one name, two distinct nodes
    h.relatedByNode = {
      "apples-id": [{ name: "Revenue", aliases: [] }],
      "apple-inc-id": [{ name: "Revenue", aliases: [] }],
    };
    h.grounded = [
      "How do Apples and Apple Inc. Revenue compare?",  // names BOTH resolved nodes → dropped
      "How much Revenue did Apple Inc. make?",          // one node → kept
    ];
    const ctx = stubCtx();
    const plan = await graphStrategy.leafQueries(ctx, "how is Apple doing?", lookup(["Apple"], ["Revenue"]));
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
    const plan = await graphStrategy.leafQueries(ctx, "how much does Tesla earn?", lookup(["Tesla"], ["revenue"]));
    expect(plan.queries).toEqual(["How much Total Revenue did Tesla, Inc. make?"]);
    expect(ctx.notes.some((n) => n.includes("names multiple entities"))).toBe(false);
  });

  it("falls back to name×filter pairs when EVERY composed query names multiple nodes", async () => {
    h.entityNodesByTerm = { Apple: [APPLES, APPLE_INC] };
    h.relatedByNode = {
      "apples-id": [{ name: "Revenue", aliases: [] }],
      "apple-inc-id": [{ name: "Revenue", aliases: [] }],
    };
    h.grounded = ["How do Apples and Apple Inc. Revenue compare?"]; // all dropped by the guard
    const plan = await graphStrategy.leafQueries(stubCtx(), "how is Apple doing?", lookup(["Apple"], ["Revenue"]));
    expect(plan.queries).toEqual(["Apple Revenue"]); // mechanical fallback from the planner terms
  });
});

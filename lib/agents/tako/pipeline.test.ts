import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  plans: {} as Record<string, any>, // decompose plan keyed by exact research question
  decomposeRejectOnce: false, // next decompose call throws a schema-validation error
  related: ["Revenue"] as string[], // metrics graphRelated returns for every entity
  composeFallback: ["fallback q"] as string[], // free-form compose fallback (only when nothing grounded)
  report: { verdict: "**Nvidia leads.**", blocks: [{ kind: "prose", md: "Because revenue." }] } as any,
  gapPlan: { sufficient: true, rationale: "covered", gaps: [] } as any,
  reportShouldFail: false, // when true, the "answer-report" call throws (composeReport → null)
  gatherCards: [] as string[], // cardIds the mocked composer gather loop pulls via get_card_contents
  answer: { answer: "", cards: [] } as any, // takoAnswer result — root grounding + cohort resolution (Error → throw)
  cohortMembers: { entities: [], rationale: "" } as any, // cohort-resolve result (Error → throw)
  overview: [] as any[], // graphOverview relations for every node (cohort roster)
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "decompose") {
      if (h.decomposeRejectOnce) {
        h.decomposeRejectOnce = false;
        throw new Error("No object generated: response did not match schema.");
      }
      const q = (String(opts.prompt).match(/RESEARCH_QUESTION:\s*(.*)/)?.[1] || "").trim();
      // Split-intent corrective retry carries a CORRECTION block — keyed separately
      // so tests can hand back the repaired (or still-broken) plan.
      if (String(opts.prompt).includes("CORRECTION:")) return h.plans[`${q}::correction`] ?? { atomic: true, rationale: "direct" };
      // Unresolvable-cohort re-plan carries a COHORT_UNAVAILABLE block.
      if (String(opts.prompt).includes("COHORT_UNAVAILABLE:")) return h.plans[`${q}::cohort-unavailable`] ?? { atomic: true, rationale: "direct" };
      // Graph-grounded second pass carries a COHORT_GROUPS block.
      if (String(opts.prompt).includes("COHORT_GROUPS:")) return h.plans[`${q}::groups`] ?? { atomic: true, rationale: "direct" };
      // Second decompose pass of cohort resolution carries a COHORT_MEMBERS block —
      // keyed separately so tests can hand back the per-member plan.
      if (String(opts.prompt).includes("COHORT_MEMBERS:")) return h.plans[`${q}::members`] ?? { atomic: true, rationale: "direct" };
      // Default: atomic with NO lookup override, so a sub-question keeps the lookup
      // its parent assigned it (a real decompose for "amd revenue" would return AMD).
      return h.plans[q] ?? { atomic: true, rationale: "direct" };
    }
    if (opts.label === "cohort-resolve") {
      if (h.cohortMembers instanceof Error) throw h.cohortMembers;
      return h.cohortMembers;
    }
    if (opts.label === "grounded-compose") {
      // Echo the resolved entity paired with every available metric (worst case: the
      // LLM keeps them all) — each cites a listed metric so the guard keeps them.
      // Read the entity off the RESOLVED: block (this leaf's actual resolved entity),
      // NOT the whole prompt — ctxBlock always echoes the top-level user message
      // ("compare Nvidia and AMD" mentions BOTH names), so scanning the full prompt
      // would misidentify every leaf as Nvidia.
      const resolvedBlock = String(opts.prompt).split("RESOLVED:\n")[1] || "";
      const ent = resolvedBlock.includes("AMD") ? "AMD" : resolvedBlock.includes("Nvidia") ? "Nvidia" : null;
      return { queries: ent ? h.related.map((m: string) => `${ent} ${m}`) : [] };
    }
    if (opts.label === "compose") return { queries: h.composeFallback };
    if (opts.label === "broad-compose") return { queries: ["macro overview"] };
    if (opts.label === "answer-report") {
      if (h.reportShouldFail) throw new Error("answer-report boom");
      return h.report;
    }
    if (opts.label === "gap-analysis") return h.gapPlan;
    return {};
  }),
  streamAnswer: vi.fn(async (opts: any) => {
    const chunks = ["**Sub.** ", "Body."];
    for (const c of chunks) opts.onToken(c);
    return chunks.join("");
  }),
  generateWithTools: vi.fn(async (opts: any) => {
    // When the harness asks for it, behave like the composer's gather loop and
    // actually invoke the get_card_contents tool (which records + emits the call).
    for (const id of h.gatherCards) await opts.tools?.get_card_contents?.execute({ cardId: id });
    return { text: "", steps: h.gatherCards.length };
  }),
}));

vi.mock("./graph", () => ({
  // Entity searches echo the query back as the resolved node (the entity-first flow
  // never searches the metric namespace; strategy.test.ts locks that).
  graphSearch: vi.fn(async (name: string) => [{ id: `${name}-id`, name, type: "entity" }]),
  graphRelated: vi.fn(async () => h.related.map((name, i) => ({ id: `m${i}`, name, aliases: [] }))),
  graphOverview: vi.fn(async (nodeId: string) => ({
    node: { id: nodeId, name: `node:${nodeId}`, type: "entity" }, relations: h.overview,
  })),
}));

vi.mock("../../tako", () => ({
  takoSearch: vi.fn(async (q: string, opts: any = {}) => {
    const lq = q.toLowerCase();
    let cards: any[];
    if (lq.includes("web")) cards = [{ cardId: "web1", title: "News article", webpageUrl: "https://news.example.com/a", source: "news.example.com" }]; // no embed → web source
    else if (lq.includes("nvidia")) cards = [{ cardId: "nvda", title: "NVDA revenue $75.2B", embedUrl: "https://e/nvda", webpageUrl: "https://w/nvda", source: "S&P Global" }];
    else if (lq.includes("amd")) cards = [{ cardId: "amd", title: "AMD revenue $5.78B", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "S&P Global" }];
    else cards = [{ cardId: "c-" + lq.slice(0, 8), title: "card " + q, embedUrl: "https://e/" + lq.slice(0, 8), source: "Tako" }];
    opts.onCall?.({ query: q, endpoint: "/v3/search", effort: opts.effort ?? "fast", web: !!opts.web, ms: 1, cards });
    return cards;
  }),
  takoContents: vi.fn(async () => ({ csv: "Timestamp,V\n2024,1" })),
  takoAnswer: vi.fn(async () => {
    if (h.answer instanceof Error) throw h.answer;
    return h.answer;
  }),
}));

import { runTakoInitial } from "./pipeline";

const req = {
  canvasId: "c", message: "compare Nvidia and AMD", surface: "main" as const,
  canvasState: { nodes: [], edges: [] }, providerId: "tako" as const, takoAnswerEnabled: true,
  history: [],
};

// The canonical split-per-entity case: a comparison decomposes into one lookup per company.
const twoBranchPlan = {
  atomic: false, rationale: "Split into per-company revenue to compare them.", entities: ["Nvidia"], metricFilters: ["Revenue"],
  subQuestions: [
    { question: "nvidia revenue", entities: ["Nvidia"], subtype: "Companies", metricFilters: ["Revenue"] },
    { question: "amd revenue", entities: ["AMD"], metricFilters: ["Revenue"] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.plans = {};
  h.decomposeRejectOnce = false;
  h.related = ["Revenue"];
  h.composeFallback = ["fallback q"];
  h.report = { verdict: "**Nvidia leads.**", blocks: [{ kind: "prose", md: "Because revenue." }] };
  h.gapPlan = { sufficient: true, rationale: "covered", gaps: [] };
  h.reportShouldFail = false;
  h.gatherCards = [];
  h.answer = { answer: "", cards: [] };
  h.cohortMembers = { entities: [], rationale: "" };
  h.overview = [];
});

describe("runTakoInitial — recursive research tree", () => {
  it("branches, wires the tree, and composes a validated answer report at the root", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;

    const events: AgentEvent[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e));

    const added = result.nodeOps.filter((o) => o.op === "add_node") as any[];
    const research = added.filter((o) => o.node.role === "research");
    const synth = added.filter((o) => o.node.role === "synthesis");
    expect(synth.length).toBeGreaterThanOrEqual(1);
    expect(research.length).toBe(2);
    for (const o of [...research, ...synth]) expect(result.allowedNodeIds.has(o.node.id)).toBe(true);

    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.some((e: any) => e.kind === "feeds")).toBe(true); // card → leaf
    expect(edges.filter((e: any) => e.kind === "derived_from" && e.to === "synth").length).toBe(2);
    expect(edges.some((e: any) => e.kind === "feeds" && e.to === "synth")).toBe(true); // broad card → synth

    // grounded queries are entity×metric pairs (no free-form drift) — the root
    // grounding /v1/answer call also mentions Nvidia, so match searches only
    const nvidiaCall = result.trace.calls?.find((c) => c.endpoint === "/v3/search" && c.query.toLowerCase().includes("nvidia"));
    expect(nvidiaCall?.query).toBe("Nvidia Revenue");
    expect(nvidiaCall?.cards[0].id).toBe("nvda");

    // each Tako card node carries the query that surfaced it (canvas provenance)
    const nvdaCard = added.find((o) => o.node.tako?.cardId === "nvda") as any;
    expect(nvdaCard.node.searches).toEqual(["Nvidia Revenue"]);

    // the root composed a validated answer report, stored on the synth node
    const synthUpdate = result.nodeOps.filter((o: any) => o.op === "update_node" && o.id === "synth").pop() as any;
    expect(synthUpdate.patch.report?.verdict).toContain("Nvidia leads");
    expect(synthUpdate.patch.report?.blocks?.length).toBeGreaterThan(0);

    // leaves streamed prose (tokens into their own node); root did NOT stream
    const tokens = events.filter((e) => e.type === "token") as any[];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) expect(t.nodeId && t.nodeId !== "synth").toBeTruthy();
    expect(result.narration).toBe("");

    // reasoning + calls survive on the authoritative trace
    expect(result.trace.reasoning?.some((r) => r.nodeId === "synth")).toBe(true);
    const nvidiaLeaf = result.trace.tree?.find((n) => n.question === "nvidia revenue");
    expect(nvidiaLeaf?.calls?.some((c) => c.cards.some((card) => card.id === "nvda"))).toBe(true);

    // entity-first lookup visibility: the planner's subtype survives onto the tree
    // node, the live reasoning event, and each related graph call carries the
    // resolved entity's display name (subject) for the trace drill-down.
    expect(nvidiaLeaf?.subtype).toBe("Companies");
    expect(nvidiaLeaf?.graphCalls?.some((c) => c.endpoint === "graph/search" && c.params.subtype === "Companies")).toBe(true);
    expect(nvidiaLeaf?.graphCalls?.filter((c) => c.endpoint === "graph/related").every((c) => c.subject === "Nvidia")).toBe(true);
    const reasoningEvt = events.find((e) => e.type === "reasoning" && (e as any).question === "nvidia revenue") as any;
    expect(reasoningEvt?.subtype).toBe("Companies");
  });

  it("drops answer-report numbers not traceable to a gathered figure", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    // $75.2B is a real gathered figure (NVDA card title); $999B is invented → must be dropped.
    h.report = {
      verdict: "**Nvidia leads.**",
      blocks: [{ kind: "tiles", tiles: [
        { label: "NVDA rev", value: "$75.2B" },
        { label: "Made up", value: "$999B" },
      ] }],
    };
    const result = await runTakoInitial(req, () => {});
    const synthUpdate = result.nodeOps.filter((o: any) => o.op === "update_node" && o.id === "synth").pop() as any;
    const tiles = synthUpdate.patch.report.blocks[0].tiles;
    expect(tiles.some((t: any) => t.value === "$75.2B")).toBe(true); // real figure kept
    expect(tiles.some((t: any) => t.value === "$999B")).toBe(false); // untraceable dropped
  });

  it("caps each sub-question to ≤3 independent searches, dropping near-duplicate metrics", async () => {
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metricFilters: ["Revenue"] };
    // Graph returns near-duplicate revenue variants + one distinct metric; the filter echoes
    // them (worst case) and the diversify backstop must collapse the variants.
    h.related = ["Revenue", "Total Revenue", "Gross Margin"];
    const result = await runTakoInitial(req, () => {});
    const grounded = (result.trace.calls ?? [])
      .filter((c) => c.endpoint !== "/v1/contents") // CSV pulls ride the trace too, but aren't searches
      .map((c) => c.query).filter((q) => q !== "macro overview");
    // ≤3 total, only ONE revenue-family query survives, the distinct concept is kept
    expect(grounded.length).toBeLessThanOrEqual(3);
    expect(grounded.filter((q) => /revenue/i.test(q)).length).toBe(1);
    expect(grounded).toContain("Nvidia Gross Margin");
    expect(grounded).not.toContain("Nvidia Total Revenue"); // near-duplicate dropped
  });

  it("records every leaf contents (CSV) fetch in the trace — on its node and live", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    const events: AgentEvent[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e));
    const nvidiaLeaf = result.trace.tree?.find((n) => n.question === "nvidia revenue");
    const contents = nvidiaLeaf?.calls?.filter((c) => c.endpoint === "/v1/contents") ?? [];
    expect(contents.length).toBe(1); // one data card → one CSV pull
    expect(contents[0].cards[0].id).toBe("nvda");
    expect(events.some((e) => e.type === "tako_call" && e.call.endpoint === "/v1/contents")).toBe(true);
  });

  it("merges the composer's get_card_contents calls into the synth tree node", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.gatherCards = ["nvda"];
    const result = await runTakoInitial(req, () => {});
    const synthNode = result.trace.tree?.find((n) => n.nodeId === "synth");
    const contents = synthNode?.calls?.filter((c) => c.endpoint === "/v1/contents") ?? [];
    expect(contents.length).toBe(1); // survives into the per-node view the final trace renders
    expect(contents[0].cards[0].id).toBe("nvda");
  });

  it("a sub-question that re-splits into ITSELF + an invented sibling stays a leaf", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    // Pathological depth-1 decompose: "nvidia revenue" re-splits into itself + a sibling
    // it does not name. The self-restating sub is dropped → 1 genuine sub → leaf.
    h.plans["nvidia revenue"] = {
      atomic: false, rationale: "bad re-split", entities: ["Nvidia"], metricFilters: ["Revenue"],
      subQuestions: [
        { question: "nvidia revenue", entities: ["Nvidia"], metricFilters: ["Revenue"] },
        { question: "amd revenue", entities: ["AMD"], metricFilters: ["Revenue"] },
      ],
    };
    const result = await runTakoInitial(req, () => {});
    // Exactly the 2 planned research nodes — no grandchildren from the bad re-split.
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research");
    expect(research.length).toBe(2);
    const nvidiaLeaf = result.trace.tree?.find((n) => n.question === "nvidia revenue");
    expect(nvidiaLeaf?.kind).toBe("leaf");
  });

  it("an atomic query produces a single synthesis block, no research nodes", async () => {
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metricFilters: ["Revenue"] };
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research").length).toBe(0);
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "synthesis").length).toBe(1);
    const synthOps = result.nodeOps.filter((o: any) => o.node?.id === "synth" || o.id === "synth");
    expect(synthOps[0].op).toBe("add_node"); // node exists before its update
  });

  it("reuses one card node across branches, linking the duplicate with a supports edge", async () => {
    // Both sub-questions resolve to the SAME entity/metric → same card returned twice.
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entities: ["Nvidia"], metricFilters: ["Revenue"],
      subQuestions: [
        { question: "nvidia revenue growth", entities: ["Nvidia"], metricFilters: ["Revenue"] },
        { question: "nvidia revenue scale", entities: ["Nvidia"], metricFilters: ["Revenue"] },
      ],
    };
    const result = await runTakoInitial(req, () => {});
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    // the nvda card is added ONCE despite both branches finding it
    expect(added.filter((o) => o.node.tako?.cardId === "nvda").length).toBe(1);
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    const nvdaNodeId = added.find((o) => o.node.tako?.cardId === "nvda").node.id;
    // one feeds edge (first branch) + a supports edge to the second branch that reused it
    expect(edges.filter((e: any) => e.from === nvdaNodeId && e.kind === "feeds").length).toBe(1);
    expect(edges.some((e: any) => e.from === nvdaNodeId && e.kind === "supports")).toBe(true);
  });

  it("cites web results as per-answer sources (see-sources), NOT as canvas nodes", async () => {
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metricFilters: ["web coverage"] };
    h.related = ["web coverage"]; // grounded query becomes "Nvidia web coverage" → a web card

    const result = await runTakoInitial(req, () => {});
    // No web result becomes a canvas node.
    const webNode = result.nodeOps.find((o: any) => o.op === "add_node" && o.node.role === "source" && o.node.grounding === "web");
    expect(webNode).toBeFalsy();
    // Instead the website is cited on the answer node's `sources` (its clickable "see sources").
    const synthPatch = result.nodeOps.find((o: any) => o.op === "update_node" && o.id === "synth" && o.patch?.sources) as any;
    expect(synthPatch).toBeTruthy();
    expect(synthPatch.patch.sources.some((s: any) => s.url === "https://news.example.com/a")).toBe(true);
  });

  it("no findings → no synth node → chat fallback", async () => {
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metricFilters: [] };
    h.related = []; // no graph metrics
    h.composeFallback = []; // and no fallback queries → nothing fetched
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node").length).toBe(0);
    expect(result.narration).toContain("couldn't find");
  });

  it("runs ONE gap-fill round: gap leaf renders with gapFill, wires derived_from to synth", async () => {
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entities: ["Nvidia"], metricFilters: ["Revenue"],
      subQuestions: [
        { question: "nvidia revenue", entities: ["Nvidia"], metricFilters: ["Revenue"] },
        { question: "nvidia margin", entities: ["Nvidia"], metricFilters: ["Revenue"] },
      ],
    };
    h.gapPlan = { sufficient: false, rationale: "AMD side missing", gaps: [
      { question: "amd revenue", entities: ["AMD"], metricFilters: ["Revenue"], why: "comparison half missing" },
    ] };
    const events: any[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e));

    const gapNode = result.nodeOps.find((o: any) => o.op === "add_node" && o.node.gapFill) as any;
    expect(gapNode).toBeTruthy();
    expect(gapNode.node.role).toBe("research");

    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.some((e: any) => e.kind === "derived_from" && e.from === gapNode.node.id && e.to === "synth")).toBe(true);

    // gap reasoning event streamed with kind "gap"; trace tree records the gap leaf
    expect(events.some((e) => e.type === "reasoning" && e.kind === "gap")).toBe(true);
    const treeGap = result.trace.tree?.find((n) => n.gapFill);
    expect(treeGap?.question).toBe("amd revenue");

    // gap findings reached the composer's figure pool → its card exists on the canvas
    expect(result.nodeOps.some((o: any) => o.op === "add_node" && o.node.tako?.cardId === "amd")).toBe(true);
  });

  it("composeReport failure degrades gracefully: synth gets a summary, no report, not stuck pending", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.reportShouldFail = true;
    const result = await runTakoInitial(req, () => {});
    const synthUpdate = result.nodeOps.filter((o: any) => o.op === "update_node" && o.id === "synth").pop() as any;
    expect(synthUpdate).toBeTruthy();
    expect(synthUpdate.patch.summary).toBeTruthy();
    expect(typeof synthUpdate.patch.summary).toBe("string");
    expect(synthUpdate.patch.summary.length).toBeGreaterThan(0);
    expect(synthUpdate.patch.report).toBeUndefined();
  });

  it("sufficient gap analysis adds no research nodes beyond the tree", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    const result = await runTakoInitial(req, () => {});
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research") as any[];
    expect(research).toHaveLength(2);
    expect(research.every((o) => !o.node.gapFill)).toBe(true);
  });
});

// Split-intent guard: a decompose that DECLARES a split (atomic:false, no cohort) but
// returns no sub-questions must not silently collapse to a leaf — the observed failure
// was "What's driving inflation this year?" leafing despite a rationale that said
// "should be split into the main contributing facets".
describe("runTakoInitial — split-intent decompose guard", () => {
  const inflationReq = { ...req, message: "What's driving inflation this year?" };
  const brokenSplit = {
    atomic: false, rationale: "should be split into the main contributing facets",
    entities: ["United States"], subtype: "Countries", metricFilters: ["inflation"],
  }; // no subQuestions, no cohort — invalid split intent
  const facetSubs = [
    { question: "energy prices driving inflation", entities: ["United States"], metricFilters: ["energy"] },
    { question: "shelter costs driving inflation", entities: ["United States"], metricFilters: ["shelter"] },
  ];

  it("retries ONCE with a CORRECTION block and branches when the retry returns the subs", async () => {
    h.plans["What's driving inflation this year?"] = brokenSplit;
    h.plans["What's driving inflation this year?::correction"] = { ...brokenSplit, subQuestions: facetSubs };
    const result = await runTakoInitial(inflationReq, () => {});

    const { generateStructured } = await import("../../llm");
    const rootDecomposes = vi.mocked(generateStructured).mock.calls.filter(([o]: any) =>
      o.label === "decompose" && String(o.prompt).includes("RESEARCH_QUESTION: What's driving inflation this year?"));
    expect(rootDecomposes).toHaveLength(2); // original + one corrective retry (children decompose separately)
    expect(String((rootDecomposes[1][0] as any).prompt)).toContain("CORRECTION:");

    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research") as any[];
    expect(research.map((o) => o.node.title)).toEqual(
      expect.arrayContaining(["energy prices driving inflation", "shelter costs driving inflation"]),
    );
    expect(result.trace.notes?.some((n) => n.includes("declared a split without sub-questions"))).toBe(true);
  });

  it("falls back to a leaf WITH the top-level lookup and a visible note when the retry is still broken", async () => {
    h.plans["What's driving inflation this year?"] = brokenSplit;
    h.plans["What's driving inflation this year?::correction"] = brokenSplit; // still no subs
    const result = await runTakoInitial(inflationReq, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research")).toHaveLength(0);
    expect(result.trace.notes?.some((n) => n.includes("split-intent unresolved"))).toBe(true);
    // the leaf kept the plan's own lookup (searched United States, not nothing)
    expect(result.trace.tree?.[0]?.entities).toEqual(["United States"]);
  });

  it("trusts 2+ sub-questions over a contradictory atomic:true flag", async () => {
    h.plans["What's driving inflation this year?"] = {
      atomic: true, rationale: "contradictory flag", entities: ["United States"], metricFilters: ["inflation"],
      subQuestions: facetSubs,
    };
    const result = await runTakoInitial(inflationReq, () => {});
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research") as any[];
    expect(research).toHaveLength(2); // branched despite atomic:true
    const { generateStructured } = await import("../../llm");
    const decomposes = vi.mocked(generateStructured).mock.calls.filter(([o]: any) => o.label === "decompose");
    expect(decomposes.filter(([o]: any) => String(o.prompt).includes("CORRECTION:"))).toHaveLength(0); // no retry needed
  });

  // Regression: a schema-invalid decompose response ("best sectors to invest in" made
  // the model omit the required lookup) threw straight through generateObject, and the
  // whole turn degraded to an empty board. One corrective retry with a SCHEMA_REMINDER
  // must recover it.
  it("retries decompose once when the response fails schema validation", async () => {
    h.decomposeRejectOnce = true;
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    const result = await runTakoInitial(req, () => {});
    const { generateStructured } = await import("../../llm");
    const rootDecomposes = vi.mocked(generateStructured).mock.calls.filter(([o]: any) =>
      o.label === "decompose" && String(o.prompt).includes("RESEARCH_QUESTION: compare Nvidia and AMD"));
    expect(rootDecomposes).toHaveLength(2); // failed attempt + schema-reminder retry
    expect(String((rootDecomposes[1][0] as any).prompt)).toContain("SCHEMA_REMINDER");
    // the retried plan drove a normal branched run
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research");
    expect(research).toHaveLength(2);
    expect(result.trace.notes?.some((n) => n.includes("invalid plan — retrying"))).toBe(true);
  });

  it("an unresolvable cohort re-plans from the question text instead of a CORRECTION retry", async () => {
    // Ungrounded cohort (answer disabled): resolution can't run. Instead of silently
    // leafing (the old dead end that left gap-fill to do the real work), the node
    // re-plans once with COHORT_UNAVAILABLE — and adopts the re-plan's split.
    h.plans["What's driving inflation this year?"] = { ...brokenSplit, cohort: "inflation drivers" };
    h.plans["What's driving inflation this year?::cohort-unavailable"] = { ...brokenSplit, subQuestions: facetSubs };
    const result = await runTakoInitial({ ...inflationReq, takoAnswerEnabled: false }, () => {});
    const { generateStructured } = await import("../../llm");
    const rootDecomposes = vi.mocked(generateStructured).mock.calls.filter(([o]: any) =>
      o.label === "decompose" && String(o.prompt).includes("RESEARCH_QUESTION: What's driving inflation this year?"));
    expect(rootDecomposes).toHaveLength(2); // original + cohort-unavailable re-plan
    expect(String((rootDecomposes[1][0] as any).prompt)).toContain("COHORT_UNAVAILABLE:");
    expect(rootDecomposes.some(([o]: any) => String(o.prompt).includes("CORRECTION:"))).toBe(false);
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research");
    expect(research).toHaveLength(2); // the re-plan's split ran
  });

  it("keeps the original cohort plan (leaf with its lookup) when the re-plan is unusable", async () => {
    h.plans["What's driving inflation this year?"] = { ...brokenSplit, cohort: "inflation drivers" };
    // ::cohort-unavailable falls back to the default { atomic:true } — no entities, no subs → not adopted
    const result = await runTakoInitial({ ...inflationReq, takoAnswerEnabled: false }, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research")).toHaveLength(0);
    expect(result.trace.tree?.[0]?.entities).toEqual(["United States"]); // original plan's lookup survives
  });
});

// Cohort-grounded decomposition: class-of-entities questions resolve REAL members via
// a grounded tako answer before decomposing — sub-questions are one-member focused.
describe("runTakoInitial — cohort resolution", () => {
  const cohortReq = { ...req, message: "identify emerging infrastructure startups" };
  const classPlan = {
    atomic: false, rationale: "class question — resolve members first",
    entities: ["Infrastructure startups"], metricFilters: ["Funding"], cohort: "emerging infrastructure startups",
  };
  const memberPlan = {
    atomic: false, rationale: "one sub per member", entities: ["Stategraph"], metricFilters: ["Funding"],
    subQuestions: [
      { question: "Stategraph funding", entities: ["Stategraph"], metricFilters: ["Funding"] },
      { question: "Runplane funding", entities: ["Runplane"], metricFilters: ["Funding"] },
    ],
  };

  it("resolves the class via takoAnswer, re-decomposes per member, nodes the answer's cards", async () => {
    h.plans["identify emerging infrastructure startups"] = classPlan;
    h.plans["identify emerging infrastructure startups::members"] = memberPlan;
    h.answer = {
      answer: "Stategraph and Runplane lead the emerging infrastructure cohort by funding.",
      cards: [{ cardId: "cs1", title: "Stategraph Funding", embedUrl: "https://e/cs1", webpageUrl: "https://w/cs1", source: "S&P Global" }],
    };
    h.cohortMembers = { entities: ["Stategraph", "Runplane"], rationale: "named in the grounded answer" };

    const events: AgentEvent[] = [];
    const result = await runTakoInitial(cohortReq, (e) => events.push(e));

    // one /v1/answer call, recorded on synth + streamed live
    const { takoAnswer } = await import("../../tako");
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    const answerCalls = (result.trace.calls ?? []).filter((c) => c.endpoint === "/v1/answer");
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0].nodeId).toBe("synth");
    expect(events.some((e) => e.type === "tako_call" && e.call.endpoint === "/v1/answer")).toBe(true);
    expect(events.some((e) => e.type === "trace" && e.stage.startsWith("resolving cohort"))).toBe(true);

    // the answer's card landed on the board, feeding the synth
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    const answerCard = added.find((o) => o.node.tako?.cardId === "cs1");
    expect(answerCard).toBeTruthy();
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.some((e: any) => e.kind === "feeds" && e.from === answerCard.node.id && e.to === "synth")).toBe(true);

    // sub-questions are per-member, not class-wide
    const research = added.filter((o) => o.node.role === "research").map((o) => o.node.title);
    expect(research).toEqual(expect.arrayContaining(["Stategraph funding", "Runplane funding"]));
    expect(result.trace.notes?.some((n) => n.includes('cohort "emerging infrastructure startups" resolved to: Stategraph, Runplane'))).toBe(true);
  });

  it("takoAnswerEnabled:false skips cohort resolution entirely", async () => {
    h.plans["identify emerging infrastructure startups"] = classPlan;
    const { takoAnswer } = await import("../../tako");
    await runTakoInitial({ ...cohortReq, takoAnswerEnabled: false }, () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
  });

  it("cohort-resolve failure is contained: note pushed, first plan proceeds, turn completes", async () => {
    h.plans["identify emerging infrastructure startups"] = classPlan;
    h.answer = { answer: "some grounded prose", cards: [] };
    h.cohortMembers = new Error("resolver down");
    const result = await runTakoInitial(cohortReq, () => {});
    expect(result.trace.notes?.some((n) => n.includes("cohort resolution failed"))).toBe(true);
    // classPlan has no subQuestions → root becomes a leaf; the turn still produces a synth
    expect(result.nodeOps.some((o: any) => o.op === "add_node" && o.node.role === "synthesis")).toBe(true);
  });
});

// EVERY root decompose is grounded by a tako answer first (not just cohort questions):
// the answer's prose + card titles feed the decompose prompt, its cards land on the
// board feeding the synth, and failures never kill the turn.
describe("runTakoInitial — root answer grounding", () => {
  it("calls takoAnswer BEFORE decompose and feeds the answer into the decompose prompt", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.answer = {
      answer: "Nvidia's data-center revenue drives the gap over AMD.",
      cards: [{ cardId: "ga1", title: "NVDA Data Center Revenue", embedUrl: "https://e/ga1", webpageUrl: "https://w/ga1", source: "S&P Global" }],
    };
    const events: AgentEvent[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e));

    // exactly one /v1/answer, recorded on synth + streamed live
    const { takoAnswer } = await import("../../tako");
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    const answerCalls = (result.trace.calls ?? []).filter((c) => c.endpoint === "/v1/answer");
    expect(answerCalls).toHaveLength(1);
    expect(answerCalls[0].nodeId).toBe("synth");
    expect(events.some((e) => e.type === "tako_call" && e.call.endpoint === "/v1/answer")).toBe(true);
    expect(events.some((e) => e.type === "trace" && e.stage.includes("grounding"))).toBe(true);

    // the answer ran BEFORE the first decompose, and grounded its prompt
    const { generateStructured } = await import("../../llm");
    const decomposeIdx = vi.mocked(generateStructured).mock.calls.findIndex(([o]: any) => o.label === "decompose");
    const decomposeOrder = vi.mocked(generateStructured).mock.invocationCallOrder[decomposeIdx];
    expect(vi.mocked(takoAnswer).mock.invocationCallOrder[0]).toBeLessThan(decomposeOrder);
    const dec = vi.mocked(generateStructured).mock.calls[decomposeIdx][0] as any;
    expect(dec.prompt).toContain("GROUNDED_ANSWER: Nvidia's data-center revenue");
    expect(dec.prompt).toContain('"NVDA Data Center Revenue"'); // CARD_TITLES

    // the answer's card landed on the board, feeding the synth
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    const answerCard = added.find((o) => o.node.tako?.cardId === "ga1");
    expect(answerCard).toBeTruthy();
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.some((e: any) => e.kind === "feeds" && e.from === answerCard.node.id && e.to === "synth")).toBe(true);

    // provenance flag on the trace
    expect(result.trace.answerUsed).toBe(true);
  });

  it("takoAnswerEnabled:false → decompose runs ungrounded, no /v1/answer call", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.answer = { answer: "should never be fetched", cards: [] };
    const { takoAnswer } = await import("../../tako");
    const result = await runTakoInitial({ ...req, takoAnswerEnabled: false }, () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
    const { generateStructured } = await import("../../llm");
    const dec = vi.mocked(generateStructured).mock.calls.find(([o]: any) => o.label === "decompose")![0] as any;
    expect(dec.prompt).not.toContain("GROUNDED_ANSWER");
    expect(result.trace.answerUsed).toBe(false);
  });

  it("takoAnswer failure is contained: note pushed, ungrounded decompose proceeds, turn completes", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.answer = new Error("answer down");
    const result = await runTakoInitial(req, () => {});
    expect(result.trace.notes?.some((n) => n.includes("answer grounding failed"))).toBe(true);
    const { generateStructured } = await import("../../llm");
    const dec = vi.mocked(generateStructured).mock.calls.find(([o]: any) => o.label === "decompose")![0] as any;
    expect(dec.prompt).not.toContain("GROUNDED_ANSWER");
    // the research tree still ran to a composed answer
    expect(result.nodeOps.some((o: any) => o.op === "add_node" && o.node.role === "synthesis")).toBe(true);
    expect(result.trace.answerUsed).toBe(false);
  });

  it("an empty answer (no prose, no cards) leaves the decompose prompt ungrounded", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.answer = { answer: "", cards: [] };
    const result = await runTakoInitial(req, () => {});
    const { generateStructured } = await import("../../llm");
    const dec = vi.mocked(generateStructured).mock.calls.find(([o]: any) => o.label === "decompose")![0] as any;
    expect(dec.prompt).not.toContain("GROUNDED_ANSWER");
    expect(result.trace.answerUsed).toBe(false);
  });

  it("cohort questions reuse the root grounding answer — still exactly ONE /v1/answer call", async () => {
    const cohortReq = { ...req, message: "identify emerging infrastructure startups" };
    h.plans["identify emerging infrastructure startups"] = {
      atomic: false, rationale: "class question", entities: ["Infrastructure startups"],
      metricFilters: ["Funding"], cohort: "emerging infrastructure startups",
    };
    h.plans["identify emerging infrastructure startups::members"] = {
      atomic: false, rationale: "one sub per member", entities: ["Stategraph"], metricFilters: ["Funding"],
      subQuestions: [
        { question: "Stategraph funding", entities: ["Stategraph"], metricFilters: ["Funding"] },
        { question: "Runplane funding", entities: ["Runplane"], metricFilters: ["Funding"] },
      ],
    };
    h.answer = { answer: "Stategraph and Runplane lead the cohort.", cards: [] };
    h.cohortMembers = { entities: ["Stategraph", "Runplane"], rationale: "named in the answer" };

    await runTakoInitial(cohortReq, () => {});
    const { takoAnswer } = await import("../../tako");
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    // the COHORT_MEMBERS second pass is ALSO grounded by the same answer
    const { generateStructured } = await import("../../llm");
    const secondPass = vi.mocked(generateStructured).mock.calls
      .find(([o]: any) => o.label === "decompose" && String(o.prompt).includes("COHORT_MEMBERS:"))![0] as any;
    expect(secondPass.prompt).toContain("GROUNDED_ANSWER: Stategraph and Runplane lead");
  });
});

// Graph-grounded cohort roster: a cohort question first tries the anchor's graph
// relations (exhaustive, pre-resolved member ids) via a COHORT_GROUPS second pass,
// falling back to the old answer-prose extraction only when the graph has nothing.
describe("graph-grounded cohort resolution", () => {
  const nbaReq = { ...req, message: "How do all NBA teams compare on attendance?" };
  const Q = "How do all NBA teams compare on attendance?";
  const firstPass = {
    atomic: false, rationale: "class question", cohort: "NBA teams",
    entities: ["National Basketball Association", "NBA"], metricFilters: ["attendance"],
  };
  const teamsGroup = {
    key: "rel:has_team", kind: "related", label: "Has team", total: 3, total_capped: false,
    items: [
      { id: "ent::bulls::1", name: "Chicago Bulls", type: "entity", aliases: ["Bulls"] },
      { id: "ent::knicks::1", name: "New York Knicks", type: "entity", aliases: [] },
      { id: "ent::lakers::1", name: "Los Angeles Lakers", type: "entity", aliases: [] },
    ],
  };
  const memberSubs = ["Chicago Bulls", "New York Knicks", "Los Angeles Lakers"].map((n) => ({
    question: `${n} attendance`, entities: [n], metricFilters: ["attendance"],
  }));

  it("plans per-member from the graph roster and never calls cohort-resolve or /v1/answer extraction", async () => {
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs };
    h.overview = [teamsGroup];
    const { generateStructured } = await import("../../llm");
    await runTakoInitial(nbaReq, () => {});
    const labels = (generateStructured as any).mock.calls.map((c: any[]) => c[0].label);
    expect(labels).not.toContain("cohort-resolve");
    const prompts = (generateStructured as any).mock.calls.map((c: any[]) => String(c[0].prompt));
    expect(prompts.some((p: string) => p.includes("COHORT_GROUPS:") && p.includes("Has team"))).toBe(true);
  });

  it("member leaves carry pre-resolved node ids — no graph/search for member names", async () => {
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs };
    h.overview = [teamsGroup];
    const { graphSearch } = await import("./graph");
    await runTakoInitial(nbaReq, () => {});
    const searched = (graphSearch as any).mock.calls.map((c: any[]) => c[0]);
    expect(searched).not.toContain("Chicago Bulls"); // pre-resolved: leaf skipped entity search
  });

  it("member leaves keep pre-resolved node ids even when their own re-plan returns entities", async () => {
    // Each member sub-question recurses into research() at depth 1 and runs its OWN
    // decompose. A real child decompose always returns entities (it re-words the
    // candidate name for the same subject) — adopting the child's own lookup must not
    // drop the parent-assigned roster node id, or the leaf re-searches the member by name.
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs };
    h.overview = [teamsGroup];
    for (const n of ["Chicago Bulls", "New York Knicks", "Los Angeles Lakers"]) {
      h.plans[`${n} attendance`] = { atomic: true, rationale: "leaf", entities: [n, n.split(" ").pop()!], metricFilters: ["attendance"] };
    }
    const { graphSearch } = await import("./graph");
    await runTakoInitial(nbaReq, () => {});
    const searched = (graphSearch as any).mock.calls.map((c: any[]) => c[0]);
    expect(searched).not.toContain("Chicago Bulls");
    expect(searched).not.toContain("New York Knicks");
    expect(searched).not.toContain("Los Angeles Lakers");
  });

  it("drills the full roster when total exceeds inline members, into a note", async () => {
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs.slice(0, 2) };
    h.overview = [{ ...teamsGroup, total: 30 }]; // 30 known, 3 inline
    const { graphRelated } = await import("./graph");
    const result = await runTakoInitial(nbaReq, () => {});
    const drill = (graphRelated as any).mock.calls.find((c: any[]) => c[1]?.relation === "rel:has_team");
    expect(drill).toBeTruthy();
    expect(result.trace.notes?.some((n: string) => n.includes("Has team"))).toBe(true);
  });

  it("falls back to the answer-grounded path when the overview yields no cohort groups", async () => {
    h.plans[Q] = firstPass;
    h.overview = []; // no groups → roster null
    h.answer = { answer: "The NBA's top teams include the Chicago Bulls.", cards: [] };
    h.cohortMembers = { entities: ["Chicago Bulls"], rationale: "from answer" };
    h.plans[`${Q}::members`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs.slice(0, 2) };
    const { generateStructured } = await import("../../llm");
    await runTakoInitial(nbaReq, () => {});
    const labels = (generateStructured as any).mock.calls.map((c: any[]) => c[0].label);
    expect(labels).toContain("cohort-resolve"); // old path ran
  });
});

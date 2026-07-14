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
  contentsCsv: "Timestamp,V\n2024,1" as string | null, // what takoContents returns (null → nothing cacheable)
  answer: { answer: "", cards: [] } as any, // takoAnswer result — root grounding + cohort resolution (Error → throw)
  cohortMembers: { entities: [], rationale: "" } as any, // cohort-resolve result (Error → throw)
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
      // Second decompose pass of cohort resolution carries a COHORT_MEMBERS block —
      // keyed separately so tests can hand back the per-member plan.
      if (String(opts.prompt).includes("COHORT_MEMBERS:")) return h.plans[`${q}::members`] ?? { atomic: true, rationale: "direct" };
      // Grounded re-plan (needsFreshContext) carries a GROUNDED_ANSWER block — checked
      // AFTER the COHORT_* keys, whose second passes may also carry the grounding.
      if (String(opts.prompt).includes("GROUNDED_ANSWER:")) return h.plans[`${q}::grounded`] ?? h.plans[q] ?? { atomic: true, rationale: "direct" };
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
  takoContents: vi.fn(async () => ({ csv: h.contentsCsv })),
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
  h.contentsCsv = "Timestamp,V\n2024,1";
  h.answer = { answer: "", cards: [] };
  h.cohortMembers = { entities: [], rationale: "" };
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
    // the synthesis node does NO searching of its own — no card ever feeds it directly
    expect(edges.some((e: any) => e.kind === "feeds" && e.to === "synth")).toBe(false);
    expect((result.trace.calls ?? []).filter((c) => c.nodeId === "synth" && c.endpoint === "/v3/search")).toHaveLength(0);

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
      .map((c) => c.query);
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

  it("merges the fallback gather's get_card_contents calls into the synth tree node", async () => {
    // No leaf manages to cache a CSV this turn (contents API returns nothing), so the
    // composer falls back to the LLM gather loop; its fetch attempt for "c-macro ou"
    // (a card with no webpageUrl) is recorded on the synth node.
    h.plans["compare Nvidia and AMD"] = {
      ...twoBranchPlan,
      subQuestions: [
        ...twoBranchPlan.subQuestions,
        { question: "macro outlook", entities: ["Macro"], metricFilters: ["Outlook"] },
      ],
    };
    h.contentsCsv = null;
    h.gatherCards = ["c-macro ou"];
    const result = await runTakoInitial(req, () => {});
    const synthNode = result.trace.tree?.find((n) => n.nodeId === "synth");
    const contents = synthNode?.calls?.filter((c) => c.endpoint === "/v1/contents") ?? [];
    expect(contents.length).toBe(1); // survives into the per-node view the final trace renders
    expect(contents[0].cards[0].id).toBe("c-macro ou");
  });

  it("the composer serves leaf-cached cards deterministically — cache-read records, no network", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    // nvda/amd CSVs were already pulled by their leaves (contents cache) → the composer
    // inlines them directly; the gather loop never runs. Each cache read mints an
    // honest cached:true record on the synth node so the trace UI shows the series
    // the report consumed.
    h.gatherCards = ["nvda"];
    const result = await runTakoInitial(req, () => {});
    const synthNode = result.trace.tree?.find((n) => n.nodeId === "synth");
    const contents = synthNode?.calls?.filter((c) => c.endpoint === "/v1/contents") ?? [];
    expect(contents.length).toBeGreaterThan(0);
    expect(contents.every((c) => c.cached === true && c.ms === 0)).toBe(true);
  });

  it("no LLM gather call when leaf CSVs are cached — the report still composes", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan; // catalog is exactly the leaf cards, all cached
    const { generateWithTools, generateStructured } = await import("../../llm");
    const result = await runTakoInitial(req, () => {});
    // Deterministic gather: the cached CSVs go straight into the emit prompt.
    expect(generateWithTools).not.toHaveBeenCalled();
    const reportCall = (generateStructured as any).mock.calls.find((c: any) => c[0].label === "answer-report")[0];
    expect(String(reportCall.prompt)).toContain("CARD_CONTENTS");
    expect(String(reportCall.prompt)).toContain("Timestamp"); // cached CSV inlined for the emit
    // the report still composes, validated against the leaf-cached CSV figures
    const synthUpdate = result.nodeOps.filter((o: any) => o.op === "update_node" && o.id === "synth").pop() as any;
    expect(synthUpdate.patch.report?.verdict).toContain("Nvidia leads");
  });

  it("stamps per-node wall-clock totals: every tree node totalMs, synth also composeMs", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    const result = await runTakoInitial(req, () => {});
    for (const n of result.trace.tree ?? []) {
      expect(typeof n.totalMs).toBe("number");
      expect(n.totalMs!).toBeGreaterThanOrEqual(0);
    }
    const synthNode = result.trace.tree?.find((n) => n.nodeId === "synth");
    expect(typeof synthNode?.composeMs).toBe("number");
    // the synth node spans the whole run — no child can outlast it
    for (const n of result.trace.tree ?? []) {
      if (n.nodeId !== "synth") expect(n.totalMs!).toBeLessThanOrEqual(synthNode!.totalMs!);
    }
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

  it("a valid split suppressed by the research budget leaves a visible note", async () => {
    // Root reserves 6; each child tries to reserve 6 more — the cap (20) lets only two
    // through, so at least one child's valid split is suppressed and must say so.
    const wide = (names: string[]) => ({
      atomic: false, rationale: "split", entities: ["Nvidia"], metricFilters: ["Revenue"],
      subQuestions: names.map((n) => ({ question: n, entities: [n], metricFilters: ["Revenue"] })),
    });
    const kids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    h.plans["compare Nvidia and AMD"] = wide(kids);
    for (const k of kids) h.plans[k] = wide(["one", "two", "three", "four", "five", "six"].map((w) => `${k} ${w}`));
    const result = await runTakoInitial(req, () => {});
    expect(result.trace.notes?.some((n) => n.includes("suppressed — research budget exhausted"))).toBe(true);
  });

  it("fences each child decompose with its siblings' questions", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    await runTakoInitial(req, () => {});
    const { generateStructured } = await import("../../llm");
    const nvidiaDec = vi.mocked(generateStructured).mock.calls
      .find(([o]: any) => o.label === "decompose" && String(o.prompt).includes("RESEARCH_QUESTION: nvidia revenue"))![0] as any;
    expect(nvidiaDec.prompt).toContain("SIBLING_QUESTIONS");
    expect(nvidiaDec.prompt).toContain("- amd revenue"); // the other lane, marked already-covered
    // the root decompose has no siblings — no fence block
    const rootDec = vi.mocked(generateStructured).mock.calls
      .find(([o]: any) => o.label === "decompose" && String(o.prompt).includes("RESEARCH_QUESTION: compare Nvidia and AMD"))![0] as any;
    expect(rootDec.prompt).not.toContain("SIBLING_QUESTIONS");
  });

  it("drops reworded parent restatements and duplicate siblings — paraphrase brake", async () => {
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entities: ["Nvidia"], metricFilters: ["Revenue"],
      subQuestions: [
        { question: "Compare Nvidia and AMD!", entities: ["Nvidia"], metricFilters: ["Revenue"] }, // parent, reworded
        { question: "nvidia revenue", entities: ["Nvidia"], metricFilters: ["Revenue"] },
        { question: "Nvidia revenue?", entities: ["Nvidia"], metricFilters: ["Revenue"] }, // sibling, reworded
        { question: "amd revenue", entities: ["AMD"], metricFilters: ["Revenue"] },
      ],
    };
    const result = await runTakoInitial(req, () => {});
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research") as any[];
    expect(research.map((o) => o.node.title).sort()).toEqual(["amd revenue", "nvidia revenue"]);
  });

  it("an atomic query produces a single synthesis block, no research nodes", async () => {
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metricFilters: ["Revenue"] };
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research").length).toBe(0);
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "synthesis").length).toBe(1);
    const synthOps = result.nodeOps.filter((o: any) => o.node?.id === "synth" || o.id === "synth");
    expect(synthOps[0].op).toBe("add_node"); // node exists before its update
  });

  it("reuses one card node across branches without drawing a cross-branch edge", async () => {
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
    // exactly one feeds edge (to the first branch) — the reusing branch gets NO edge,
    // so the card stays visually connected only to its original parent
    expect(edges.filter((e: any) => e.from === nvdaNodeId && e.kind === "feeds").length).toBe(1);
    expect(edges.some((e: any) => e.from === nvdaNodeId && e.kind === "supports")).toBe(false);
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

  it("resolves the class via takoAnswer and re-decomposes per member — answer cards stay OFF the board", async () => {
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

    // grounding is a planning aid only — its card is NOT noded onto the canvas
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    expect(added.find((o) => o.node.tako?.cardId === "cs1")).toBeUndefined();

    // sub-questions are per-member, not class-wide
    const research = added.filter((o) => o.node.role === "research").map((o) => o.node.title);
    expect(research).toEqual(expect.arrayContaining(["Stategraph funding", "Runplane funding"]));
    expect(result.trace.notes?.some((n) => n.includes('cohort "emerging infrastructure startups" resolved to: Stategraph, Runplane'))).toBe(true);
  });

  // Observed live: the second pass declared the split in its rationale ("two concrete
  // companies to research one-by-one") but returned NO subQuestions — and the node
  // leafed. With the members already resolved, the split is rebuilt in code.
  it("a flubbed second pass (split rationale, no subs) still branches — deterministic per-member fallback", async () => {
    h.plans["identify emerging infrastructure startups"] = classPlan;
    h.plans["identify emerging infrastructure startups::members"] = {
      atomic: false, rationale: "This is a split: cover the named members first", entities: ["Stategraph"], metricFilters: ["Funding"],
    }; // split intent, NO subQuestions
    h.answer = { answer: "Stategraph and Runplane lead the cohort.", cards: [] };
    h.cohortMembers = { entities: ["Stategraph", "Runplane"], rationale: "named in the answer" };
    const result = await runTakoInitial(cohortReq, () => {});

    // branched into one research node per resolved member, entities = the member names
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research") as any[];
    expect(research).toHaveLength(2);
    const memberLeaves = (result.trace.tree ?? []).filter((n) => n.kind === "leaf");
    expect(memberLeaves.map((n) => n.entities?.[0]).sort()).toEqual(["Runplane", "Stategraph"]);
    expect(memberLeaves.every((n) => n.metrics?.includes("Funding"))).toBe(true);
    expect(result.trace.notes?.some((n) => n.includes("split rebuilt deterministically from 2 resolved members"))).toBe(true);

    // the rebuild is code, not another LLM round-trip: no CORRECTION decompose ran
    const { generateStructured } = await import("../../llm");
    const corrections = vi.mocked(generateStructured).mock.calls.filter(([o]: any) =>
      o.label === "decompose" && String(o.prompt).includes("CORRECTION:"));
    expect(corrections).toHaveLength(0);
  });

  it("the split-intent CORRECTION retry keeps the COHORT_MEMBERS block in its prompt", async () => {
    // Fallback needs ≥2 members — a single-member cohort exercises the LLM correction
    // path instead, which must still see the member list.
    h.plans["identify emerging infrastructure startups"] = classPlan;
    h.plans["identify emerging infrastructure startups::members"] = {
      atomic: false, rationale: "split per member", entities: ["Stategraph"], metricFilters: ["Funding"],
    }; // split intent, no subs, 1 member → correction path
    h.answer = { answer: "Only Stategraph is named.", cards: [] };
    h.cohortMembers = { entities: ["Stategraph"], rationale: "one member" };
    await runTakoInitial(cohortReq, () => {});
    const { generateStructured } = await import("../../llm");
    const correction = vi.mocked(generateStructured).mock.calls.find(([o]: any) =>
      o.label === "decompose" && String(o.prompt).includes("CORRECTION:"))?.[0] as any;
    expect(correction).toBeTruthy();
    expect(String(correction.prompt)).toContain('COHORT_MEMBERS: ["Stategraph"]');
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

// Grounding is CONDITIONAL and prompt-only: the split decision runs first from the
// question text; /v1/answer fires only when the plan sets needsFreshContext (or the
// plan is a cohort), its prose + card titles feed a decompose RE-PLAN, its cards
// never land on the board, and failures never kill the turn.
describe("runTakoInitial — conditional root answer grounding", () => {
  const freshPlan = {
    ...twoBranchPlan,
    rationale: "drivers must come from current data",
    needsFreshContext: true,
  };

  it("a plan that never asks for fresh context makes NO /v1/answer call", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    h.answer = { answer: "should never be fetched", cards: [] };
    const { takoAnswer } = await import("../../tako");
    const result = await runTakoInitial(req, () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
    expect(result.trace.answerUsed).toBe(false);
    const { generateStructured } = await import("../../llm");
    const dec = vi.mocked(generateStructured).mock.calls.find(([o]: any) => o.label === "decompose")![0] as any;
    expect(dec.prompt).not.toContain("GROUNDED_ANSWER");
  });

  it("needsFreshContext grounds AFTER the first decompose and feeds a grounded re-plan — cards stay off the board", async () => {
    h.plans["compare Nvidia and AMD"] = freshPlan;
    h.plans["compare Nvidia and AMD::grounded"] = twoBranchPlan;
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

    // the split decision ran FIRST: first root decompose precedes the answer call and
    // is ungrounded; the grounded RE-PLAN carries the answer + card titles
    const { generateStructured } = await import("../../llm");
    const rootDecomposes = vi.mocked(generateStructured).mock.calls
      .map((c, i) => ({ o: c[0] as any, order: vi.mocked(generateStructured).mock.invocationCallOrder[i] }))
      .filter(({ o }) => o.label === "decompose" && String(o.prompt).includes("RESEARCH_QUESTION: compare Nvidia and AMD"));
    expect(rootDecomposes).toHaveLength(2);
    expect(rootDecomposes[0].order).toBeLessThan(vi.mocked(takoAnswer).mock.invocationCallOrder[0]);
    expect(String(rootDecomposes[0].o.prompt)).not.toContain("GROUNDED_ANSWER");
    expect(String(rootDecomposes[1].o.prompt)).toContain("GROUNDED_ANSWER: Nvidia's data-center revenue");
    expect(String(rootDecomposes[1].o.prompt)).toContain('"NVDA Data Center Revenue"'); // CARD_TITLES

    // grounding is a planning aid only — its card is NOT noded onto the canvas
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    expect(added.find((o) => o.node.tako?.cardId === "ga1")).toBeUndefined();

    // the grounded re-plan's split ran; provenance flag on the trace
    expect(added.filter((o) => o.node.role === "research")).toHaveLength(2);
    expect(result.trace.answerUsed).toBe(true);
  });

  it("takoAnswerEnabled:false → even a needsFreshContext plan runs ungrounded, no /v1/answer call", async () => {
    h.plans["compare Nvidia and AMD"] = freshPlan;
    h.answer = { answer: "should never be fetched", cards: [] };
    const { takoAnswer } = await import("../../tako");
    const result = await runTakoInitial({ ...req, takoAnswerEnabled: false }, () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
    const { generateStructured } = await import("../../llm");
    const dec = vi.mocked(generateStructured).mock.calls.find(([o]: any) => o.label === "decompose")![0] as any;
    expect(dec.prompt).not.toContain("GROUNDED_ANSWER");
    expect(result.trace.answerUsed).toBe(false);
  });

  it("takoAnswer failure is contained: note pushed, the ungrounded plan proceeds, turn completes", async () => {
    h.plans["compare Nvidia and AMD"] = freshPlan;
    h.answer = new Error("answer down");
    const result = await runTakoInitial(req, () => {});
    expect(result.trace.notes?.some((n) => n.includes("answer grounding failed"))).toBe(true);
    const { generateStructured } = await import("../../llm");
    // grounding failed → no grounded re-plan; every decompose stayed ungrounded
    const decs = vi.mocked(generateStructured).mock.calls.filter(([o]: any) => o.label === "decompose");
    expect(decs.every(([o]: any) => !String(o.prompt).includes("GROUNDED_ANSWER"))).toBe(true);
    // the research tree still ran to a composed answer
    expect(result.nodeOps.some((o: any) => o.op === "add_node" && o.node.role === "synthesis")).toBe(true);
    expect(result.trace.answerUsed).toBe(false);
  });

  it("an empty answer (no prose, no cards) skips the re-plan and leaves decompose ungrounded", async () => {
    h.plans["compare Nvidia and AMD"] = freshPlan;
    h.answer = { answer: "", cards: [] };
    const result = await runTakoInitial(req, () => {});
    const { generateStructured } = await import("../../llm");
    const decs = vi.mocked(generateStructured).mock.calls.filter(([o]: any) => o.label === "decompose");
    expect(decs.every(([o]: any) => !String(o.prompt).includes("GROUNDED_ANSWER"))).toBe(true);
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

// Sub-question-level cohort resolution: a multi-sector question splits into per-sector
// sub-questions, each of which is ITSELF a cohort resolved via its OWN /v1/answer call
// (Answer-only, any depth) — the members become per-company leaves.
describe("runTakoInitial — sub-question cohort resolution (multi-sector)", () => {
  const sectorReq = { ...req, message: "research the automotive and semiconductor sectors in Asia" };
  const ROOT_Q = "research the automotive and semiconductor sectors in Asia";
  // Root: a plain split into two sector sub-questions (NOT a cohort itself).
  const rootSplit = {
    atomic: false, rationale: "two sectors — one sub-question per sector",
    entities: ["Asia markets"], metricFilters: ["revenue"],
    subQuestions: [
      { question: "automotive companies in Asia", entities: ["Asian automotive companies"], metricFilters: ["revenue"] },
      { question: "semiconductor companies in Asia", entities: ["Asian semiconductor companies"], metricFilters: ["revenue"] },
    ],
  };
  // Each sector sub-question is a cohort (members unknown from the question text).
  const autoCohort = { atomic: false, rationale: "class question", cohort: "automotive companies in Asia", entities: ["Asian automotive companies"], metricFilters: ["revenue"] };
  const semiCohort = { atomic: false, rationale: "class question", cohort: "semiconductor companies in Asia", entities: ["Asian semiconductor companies"], metricFilters: ["revenue"] };
  const autoMembers = {
    atomic: false, rationale: "one sub per member", entities: ["Asian automotive companies"], metricFilters: ["revenue"],
    subQuestions: [
      { question: "Toyota revenue", entities: ["Toyota Motor"], metricFilters: ["revenue"] },
      { question: "Honda revenue", entities: ["Honda Motor"], metricFilters: ["revenue"] },
    ],
  };
  const semiMembers = {
    atomic: false, rationale: "one sub per member", entities: ["Asian semiconductor companies"], metricFilters: ["revenue"],
    subQuestions: [
      { question: "TSMC revenue", entities: ["TSMC"], metricFilters: ["revenue"] },
      { question: "Samsung revenue", entities: ["Samsung Electronics"], metricFilters: ["revenue"] },
    ],
  };

  function wirePlans() {
    h.plans[ROOT_Q] = rootSplit;
    h.plans["automotive companies in Asia"] = autoCohort;
    h.plans["semiconductor companies in Asia"] = semiCohort;
    h.plans["automotive companies in Asia::members"] = autoMembers;
    h.plans["semiconductor companies in Asia::members"] = semiMembers;
    h.answer = { answer: "Leading Asian firms include Toyota, Honda, TSMC and Samsung.", cards: [] };
    h.cohortMembers = { entities: ["Toyota Motor", "Honda Motor"], rationale: "named in the grounded answer" };
  }

  it("resolves EACH sector sub-question via its own /v1/answer call and researches per-company", async () => {
    wirePlans();
    const result = await runTakoInitial(sectorReq, () => {});

    // The root is a plain split (no cohort), so it does NOT ground; each of the two
    // sector sub-questions grounds once → exactly two /v1/answer calls.
    const { takoAnswer } = await import("../../tako");
    expect(takoAnswer).toHaveBeenCalledTimes(2);

    // Both answer calls attach to a sub-question research node, never the root synth.
    const answerCalls = (result.trace.calls ?? []).filter((c) => c.endpoint === "/v1/answer");
    expect(answerCalls).toHaveLength(2);
    expect(answerCalls.every((c) => c.nodeId !== "synth")).toBe(true);
    expect(new Set(answerCalls.map((c) => c.nodeId)).size).toBe(2); // distinct nodes

    // Both sectors ran the COHORT_MEMBERS second pass.
    const { generateStructured } = await import("../../llm");
    const memberPasses = (generateStructured as any).mock.calls
      .filter((c: any[]) => c[0].label === "decompose" && String(c[0].prompt).includes("COHORT_MEMBERS:"));
    expect(memberPasses).toHaveLength(2);
  });

  it("mints per-company research leaves under each sector", async () => {
    wirePlans();
    const result = await runTakoInitial(sectorReq, () => {});
    const research = result.nodeOps
      .filter((o: any) => o.op === "add_node" && o.node.role === "research")
      .map((o: any) => o.node.title);
    expect(research).toEqual(expect.arrayContaining([
      "automotive companies in Asia", "semiconductor companies in Asia",
      "Toyota revenue", "Honda revenue", "TSMC revenue", "Samsung revenue",
    ]));
  });

  it("takoAnswerEnabled:false leaves the sector cohorts unresolved (no /v1/answer)", async () => {
    wirePlans();
    const { takoAnswer } = await import("../../tako");
    await runTakoInitial({ ...sectorReq, takoAnswerEnabled: false }, () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
  });
});

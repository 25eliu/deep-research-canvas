import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  plans: {} as Record<string, any>, // decompose plan keyed by exact research question
  related: ["Revenue"] as string[], // metrics graphRelated returns for every entity
  composeFallback: ["fallback q"] as string[], // free-form compose fallback (only when nothing grounded)
  report: { verdict: "**Nvidia leads.**", blocks: [{ kind: "prose", md: "Because revenue." }] } as any,
  gapPlan: { sufficient: true, rationale: "covered", gaps: [] } as any,
  reportShouldFail: false, // when true, the "answer-report" call throws (composeReport → null)
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "decompose") {
      const q = (String(opts.prompt).match(/RESEARCH_QUESTION:\s*(.*)/)?.[1] || "").trim();
      // Default: atomic with NO pair override, so a sub-question keeps the entity/metric
      // its parent assigned it (a real decompose for "amd revenue" would return AMD).
      return h.plans[q] ?? { atomic: true, rationale: "direct" };
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
  generateWithTools: vi.fn(async () => ({ text: "", steps: 0 })),
}));

vi.mock("./graph", () => ({
  // Type-aware: metric discovery finds nothing here (strategy.test.ts covers it),
  // entity searches echo the query back as the resolved node.
  graphSearch: vi.fn(async (name: string, opts: any) =>
    opts?.types === "metric" ? [] : [{ id: `${name}-id`, name, type: "entity" }]),
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
  takoContents: vi.fn(async () => ({ csv: "Timestamp,V\n2024,1" })),
}));

import { runTakoInitial } from "./pipeline";

const req = {
  canvasId: "c", message: "compare Nvidia and AMD", surface: "main" as const,
  canvasState: { nodes: [], edges: [] }, providerId: "tako" as const, takoAnswerEnabled: true,
  history: [],
};

// The canonical split-per-entity case: a comparison decomposes into one pair per company.
const twoBranchPlan = {
  atomic: false, rationale: "Split into per-company revenue to compare them.", entity: "Nvidia", metric: "Revenue",
  subQuestions: [
    { question: "nvidia revenue", entity: "Nvidia", metric: "Revenue" },
    { question: "amd revenue", entity: "AMD", metric: "Revenue" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.plans = {};
  h.related = ["Revenue"];
  h.composeFallback = ["fallback q"];
  h.report = { verdict: "**Nvidia leads.**", blocks: [{ kind: "prose", md: "Because revenue." }] };
  h.gapPlan = { sufficient: true, rationale: "covered", gaps: [] };
  h.reportShouldFail = false;
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

    // grounded queries are entity×metric pairs (no free-form drift)
    const nvidiaCall = result.trace.calls?.find((c) => c.query.toLowerCase().includes("nvidia"));
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entity: "Nvidia", metric: "Revenue" };
    // Graph returns near-duplicate revenue variants + one distinct metric; the filter echoes
    // them (worst case) and the diversify backstop must collapse the variants.
    h.related = ["Revenue", "Total Revenue", "Gross Margin"];
    const result = await runTakoInitial(req, () => {});
    const grounded = (result.trace.calls ?? []).map((c) => c.query).filter((q) => q !== "macro overview");
    // ≤3 total, only ONE revenue-family query survives, the distinct concept is kept
    expect(grounded.length).toBeLessThanOrEqual(3);
    expect(grounded.filter((q) => /revenue/i.test(q)).length).toBe(1);
    expect(grounded).toContain("Nvidia Gross Margin");
    expect(grounded).not.toContain("Nvidia Total Revenue"); // near-duplicate dropped
  });

  it("a sub-question that re-splits into ITSELF + an invented sibling stays a leaf", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    // Pathological depth-1 decompose: "nvidia revenue" re-splits into itself + a sibling
    // it does not name. The self-restating sub is dropped → 1 genuine sub → leaf.
    h.plans["nvidia revenue"] = {
      atomic: false, rationale: "bad re-split", entity: "Nvidia", metric: "Revenue",
      subQuestions: [
        { question: "nvidia revenue", entity: "Nvidia", metric: "Revenue" },
        { question: "amd revenue", entity: "AMD", metric: "Revenue" },
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entity: "Nvidia", metric: "Revenue" };
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research").length).toBe(0);
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "synthesis").length).toBe(1);
    const synthOps = result.nodeOps.filter((o: any) => o.node?.id === "synth" || o.id === "synth");
    expect(synthOps[0].op).toBe("add_node"); // node exists before its update
  });

  it("reuses one card node across branches, linking the duplicate with a supports edge", async () => {
    // Both sub-questions resolve to the SAME entity/metric → same card returned twice.
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entity: "Nvidia", metric: "Revenue",
      subQuestions: [
        { question: "nvidia revenue growth", entity: "Nvidia", metric: "Revenue" },
        { question: "nvidia revenue scale", entity: "Nvidia", metric: "Revenue" },
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entity: "Nvidia", metric: "web coverage" };
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entity: "Nvidia", metric: "" };
    h.related = []; // no graph metrics
    h.composeFallback = []; // and no fallback queries → nothing fetched
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node").length).toBe(0);
    expect(result.narration).toContain("couldn't find");
  });

  it("runs ONE gap-fill round: gap leaf renders with gapFill, wires derived_from to synth", async () => {
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entity: "Nvidia", metric: "Revenue",
      subQuestions: [
        { question: "nvidia revenue", entity: "Nvidia", metric: "Revenue" },
        { question: "nvidia margin", entity: "Nvidia", metric: "Revenue" },
      ],
    };
    h.gapPlan = { sufficient: false, rationale: "AMD side missing", gaps: [
      { question: "amd revenue", entity: "AMD", metric: "Revenue", why: "comparison half missing" },
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

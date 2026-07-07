import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  plans: {} as Record<string, any>, // decompose plan keyed by exact research question
  related: ["Revenue"] as string[], // metrics graphRelated returns for every entity
  composeFallback: ["fallback q"] as string[], // free-form compose fallback (only when nothing grounded)
  report: { verdict: "**Nvidia leads.**", blocks: [{ kind: "prose", md: "Because revenue." }] } as any,
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "decompose") {
      const q = (String(opts.prompt).match(/RESEARCH_QUESTION:\s*(.*)/)?.[1] || "").trim();
      // Default: atomic with NO entity override, so a sub-question keeps the entities
      // its parent assigned it (a real decompose for "amd revenue" would return AMD).
      return h.plans[q] ?? { atomic: true, rationale: "direct", entities: [], metrics: [] };
    }
    if (opts.label === "metric-filter") return { keep: h.related }; // keep all available metrics
    if (opts.label === "compose") return { queries: h.composeFallback };
    if (opts.label === "broad-compose") return { queries: ["macro overview"] };
    if (opts.label === "answer-report") return h.report;
    return {};
  }),
  streamAnswer: vi.fn(async (opts: any) => {
    const chunks = ["**Sub.** ", "Body."];
    for (const c of chunks) opts.onToken(c);
    return chunks.join("");
  }),
}));

vi.mock("./graph", () => ({
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
}));

import { runTakoInitial } from "./pipeline";

const req = {
  canvasId: "c", message: "compare Nvidia and AMD", surface: "main" as const,
  canvasState: { nodes: [], edges: [] }, providerId: "tako" as const, takoAnswerEnabled: true,
  history: [],
};

const twoBranchPlan = {
  atomic: false, rationale: "Split into per-company revenue to compare them.", entities: ["Nvidia", "AMD"], metrics: ["Revenue"],
  subQuestions: [
    { question: "nvidia revenue", entities: ["Nvidia"], metrics: ["Revenue"] },
    { question: "amd revenue", entities: ["AMD"], metrics: ["Revenue"] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  h.plans = {};
  h.related = ["Revenue"];
  h.composeFallback = ["fallback q"];
  h.report = { verdict: "**Nvidia leads.**", blocks: [{ kind: "prose", md: "Because revenue." }] };
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metrics: ["Revenue"] };
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

  it("an atomic query produces a single synthesis block, no research nodes", async () => {
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metrics: ["Revenue"] };
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research").length).toBe(0);
    expect(result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "synthesis").length).toBe(1);
    const synthOps = result.nodeOps.filter((o: any) => o.node?.id === "synth" || o.id === "synth");
    expect(synthOps[0].op).toBe("add_node"); // node exists before its update
  });

  it("reuses one card node across branches, linking the duplicate with a supports edge", async () => {
    // Both sub-questions resolve to the SAME entity/metric → same card returned twice.
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entities: ["Nvidia"], metrics: ["Revenue"],
      subQuestions: [
        { question: "nvidia revenue growth", entities: ["Nvidia"], metrics: ["Revenue"] },
        { question: "nvidia revenue scale", entities: ["Nvidia"], metrics: ["Revenue"] },
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metrics: ["web coverage"] };
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
    h.plans["compare Nvidia and AMD"] = { atomic: true, rationale: "direct", entities: ["Nvidia"], metrics: [] };
    h.related = []; // no graph metrics
    h.composeFallback = []; // and no fallback queries → nothing fetched
    const result = await runTakoInitial(req, () => {});
    expect(result.nodeOps.filter((o: any) => o.op === "add_node").length).toBe(0);
    expect(result.narration).toContain("couldn't find");
  });
});

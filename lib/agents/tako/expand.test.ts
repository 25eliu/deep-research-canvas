import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

// Same fully-mocked research engine as pipeline.test.ts — the strategy runs for real
// against mocked graph/tako/llm, so runTakoExpand exercises the true tree build.
const h = vi.hoisted(() => ({
  plans: {} as Record<string, any>,
  decomposeRejectOnce: false,
  related: ["Revenue"] as string[],
  composeFallback: ["fallback q"] as string[],
  report: { verdict: "**AMD margins rising.**", blocks: [{ kind: "prose", md: "x" }] } as any,
  gapPlan: { sufficient: true, rationale: "covered", gaps: [] } as any,
  reportShouldFail: false,
  gatherCards: [] as string[],
  broadQueries: ["macro overview"] as string[],
  answer: { answer: "", cards: [] } as any,
  cohortMembers: { entities: [], rationale: "" } as any,
  overview: [] as any[],
  crossLinks: { links: [] } as any, // crosslink structured-output result (Error → throw)
  searchEmpty: false, // when true, takoSearch returns no cards (degrade path)
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "decompose") {
      if (h.decomposeRejectOnce) {
        h.decomposeRejectOnce = false;
        throw new Error("No object generated: response did not match schema.");
      }
      const q = (String(opts.prompt).match(/RESEARCH_QUESTION:\s*(.*)/)?.[1] || "").trim();
      if (String(opts.prompt).includes("CORRECTION:")) return h.plans[`${q}::correction`] ?? { atomic: true, rationale: "direct" };
      if (String(opts.prompt).includes("COHORT_UNAVAILABLE:")) return h.plans[`${q}::cohort-unavailable`] ?? { atomic: true, rationale: "direct" };
      if (String(opts.prompt).includes("COHORT_GROUPS:")) return h.plans[`${q}::groups`] ?? { atomic: true, rationale: "direct" };
      if (String(opts.prompt).includes("COHORT_MEMBERS:")) return h.plans[`${q}::members`] ?? { atomic: true, rationale: "direct" };
      if (String(opts.prompt).includes("GROUNDED_ANSWER:")) return h.plans[`${q}::grounded`] ?? h.plans[q] ?? { atomic: true, rationale: "direct" };
      return h.plans[q] ?? { atomic: true, rationale: "direct" };
    }
    if (opts.label === "cohort-resolve") {
      if (h.cohortMembers instanceof Error) throw h.cohortMembers;
      return h.cohortMembers;
    }
    if (opts.label === "grounded-compose") {
      const resolvedBlock = String(opts.prompt).split("RESOLVED:\n")[1] || "";
      const ent = resolvedBlock.includes("AMD") ? "AMD" : resolvedBlock.includes("Nvidia") ? "Nvidia" : null;
      return { queries: ent ? h.related.map((m: string) => `${ent} ${m}`) : [] };
    }
    if (opts.label === "compose") return { queries: h.composeFallback };
    if (opts.label === "broad-compose") return { queries: h.broadQueries };
    if (opts.label === "answer-report") {
      if (h.reportShouldFail) throw new Error("answer-report boom");
      return h.report;
    }
    if (opts.label === "gap-analysis") return h.gapPlan;
    if (opts.label === "crosslink") {
      if (h.crossLinks instanceof Error) throw h.crossLinks;
      return h.crossLinks;
    }
    return {};
  }),
  streamAnswer: vi.fn(async (opts: any) => {
    const chunks = ["**Sub.** ", "Body."];
    for (const c of chunks) opts.onToken(c);
    return chunks.join("");
  }),
  generateWithTools: vi.fn(async (opts: any) => {
    for (const id of h.gatherCards) await opts.tools?.get_card_contents?.execute({ cardId: id });
    return { text: "", steps: h.gatherCards.length };
  }),
}));

vi.mock("./graph", () => ({
  graphSearch: vi.fn(async (name: string) => [{ id: `${name}-id`, name, type: "entity" }]),
  graphRelated: vi.fn(async () => h.related.map((name, i) => ({ id: `m${i}`, name, aliases: [] }))),
  graphOverview: vi.fn(async (nodeId: string) => ({
    node: { id: nodeId, name: `node:${nodeId}`, type: "entity" }, relations: h.overview,
  })),
}));

vi.mock("../../tako", () => ({
  takoSearch: vi.fn(async (q: string, opts: any = {}) => {
    if (h.searchEmpty) { opts.onCall?.({ query: q, endpoint: "/v3/search", effort: opts.effort ?? "fast", web: !!opts.web, ms: 1, cards: [] }); return []; }
    const lq = q.toLowerCase();
    let cards: any[];
    if (lq.includes("web")) cards = [{ cardId: "web1", title: "News article", webpageUrl: "https://news.example.com/a", source: "news.example.com" }];
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

import { runTakoExpand } from "./expand";

// A board that already has a research tree rooted at "synth".
const boardState = {
  nodes: [
    { id: "synth", type: "text", role: "synthesis", title: "Chip leaders", summary: "Nvidia leads.", grounding: "tako", confidence: 0.9 },
    { id: "rq_nvda", type: "text", role: "research", title: "Nvidia revenue", summary: "Up.", grounding: "tako", confidence: 0.85 },
  ],
  edges: [{ id: "e1", from: "rq_nvda", to: "synth", kind: "derived_from" }],
} as any;

const expandReq = (over: any = {}) => ({
  canvasId: "c", message: "research AMD's margins", surface: "main" as const,
  canvasState: boardState, providerId: "tako" as const, takoAnswerEnabled: true, history: [], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.plans = {};
  h.decomposeRejectOnce = false;
  h.related = ["Revenue"];
  h.composeFallback = ["fallback q"];
  h.report = { verdict: "**AMD margins rising.**", blocks: [{ kind: "prose", md: "x" }] };
  h.gapPlan = { sufficient: true, rationale: "ok", gaps: [] };
  h.reportShouldFail = false;
  h.gatherCards = [];
  h.broadQueries = ["macro overview"];
  h.answer = { answer: "", cards: [] };
  h.cohortMembers = { entities: [], rationale: "" };
  h.overview = [];
  h.crossLinks = { links: [] };
  h.searchEmpty = false;
});

describe("runTakoExpand", () => {
  it("mints a NEW synthesis root (not 'synth') and never removes existing nodes", async () => {
    const res = await runTakoExpand(expandReq(), "HIST");
    const added = res.nodeOps.filter((o: any) => o.op === "add_node");
    const roots = added.filter((o: any) => o.node.role === "synthesis").map((o: any) => o.node.id);
    expect(roots.length).toBe(1);
    expect(roots[0]).not.toBe("synth");
    expect(res.nodeOps.some((o: any) => o.op === "remove_node")).toBe(false);
  });

  it("does not collide with existing board node ids", async () => {
    const res = await runTakoExpand(expandReq(), "HIST");
    const newIds = res.nodeOps.filter((o: any) => o.op === "add_node").map((o: any) => o.node.id);
    expect(newIds).not.toContain("rq_nvda");
    expect(newIds).not.toContain("synth");
  });

  it("anchors the new tree to the selected node's tree root with a derived_from edge", async () => {
    const res = await runTakoExpand(expandReq({ selection: { nodeIds: ["rq_nvda"], nodes: [] } }), "HIST");
    const ops = res.nodeOps as any[];
    const newRoot = ops.find((o) => o.op === "add_node" && o.node.role === "synthesis")!.node.id;
    const anchor = ops.find(
      (o) => o.op === "add_edge" && o.edge.kind === "derived_from" && o.edge.from === newRoot,
    );
    expect(anchor?.edge.to).toBe("synth"); // rq_nvda's tree root
  });

  it("degrades to the answer lane (no new tree) when research finds nothing", async () => {
    h.searchEmpty = true;
    const res = await runTakoExpand(expandReq(), "HIST");
    expect(res.nodeOps.some((o: any) => o.op === "add_node" && o.node.role === "synthesis")).toBe(false);
    expect(res.trace.notes?.some((n: string) => n.includes("no data"))).toBe(true);
  });
});

describe("runTakoExpand cross-links", () => {
  it("emits a validated supports edge the LLM proposes to an existing node", async () => {
    h.crossLinks = { links: [{ from: "SELF_ROOT", to: "rq_nvda", kind: "supports", reason: "same sector" }] };
    const res = await runTakoExpand(expandReq(), "HIST");
    const ops = res.nodeOps as any[];
    const newRoot = ops.find((o) => o.op === "add_node" && o.node.role === "synthesis")!.node.id;
    const link = ops.find((o) => o.op === "add_edge" && o.edge.kind === "supports" && o.edge.to === "rq_nvda");
    expect(link?.edge.from).toBe(newRoot);
  });

  it("drops a proposed edge whose target is not a real board node", async () => {
    h.crossLinks = { links: [{ from: "SELF_ROOT", to: "ghost_node", kind: "supports", reason: "nope" }] };
    const res = await runTakoExpand(expandReq(), "HIST");
    expect(res.nodeOps.some((o: any) => o.op === "add_edge" && o.edge.to === "ghost_node")).toBe(false);
  });

  it("survives a cross-link LLM failure without dropping the tree", async () => {
    h.crossLinks = new Error("crosslink boom");
    const res = await runTakoExpand(expandReq(), "HIST");
    expect(res.nodeOps.some((o: any) => o.op === "add_node" && o.node.role === "synthesis")).toBe(true);
  });
});

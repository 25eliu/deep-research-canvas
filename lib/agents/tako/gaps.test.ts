import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  plan: { sufficient: true, rationale: "covered", gaps: [] } as any,
  leafResult: { nodeId: "rq_gap", title: "g", synthesis: "s", findingCount: 1, children: [], depth: 1, kind: "leaf" } as any,
  leafCalls: [] as any[],
  // Per-question override: when set for a question, researchLeaf rejects instead
  // of resolving (simulates a leaf-synth streamAnswer throw for just that gap).
  leafRejections: {} as Record<string, string>,
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "gap-analysis") {
      if (h.plan instanceof Error) throw h.plan;
      return h.plan;
    }
    return {};
  }),
}));

vi.mock("./flow", () => ({
  SYNTH_ID: "synth",
  uniqueResearchId: vi.fn((_ctx: any, q: string) => `rq_${q.replace(/\W+/g, "_")}`),
  derivedEdge: vi.fn((from: string, to: string) => ({ op: "add_edge", edge: { id: `derives:${from}->${to}`, from, to, kind: "derived_from" } })),
  researchLeaf: vi.fn(async (...args: any[]) => {
    h.leafCalls.push(args);
    const question = args[0];
    if (h.leafRejections[question]) throw new Error(h.leafRejections[question]);
    return { ...h.leafResult, nodeId: args[2] };
  }),
}));

import { runGapRound } from "./gaps";
import { researchLeaf } from "./flow";

function fakeCtx(overrides: Partial<any> = {}) {
  const events: AgentEvent[] = [];
  const ops: any[] = [];
  return {
    req: { canvasId: "c", message: "q", surface: "main", canvasState: { nodes: [], edges: [] }, providerId: "tako", history: [] },
    ledger: { list: () => [{ card: { cardId: "nvda", description: "d" }, title: "NVDA rev", source: "S&P", kind: "data_card" }] },
    push: (o: any[]) => ops.push(...o),
    emit: (e: AgentEvent) => events.push(e),
    budget: { researchNodes: 2, maxNodes: 20 },
    notes: [], figures: [], branchResults: [{ question: "nvidia revenue", claim: "up", confidence: 0.8, figures: [] }],
    reasoning: [], tree: [], usedIds: new Set(["synth"]),
    _events: events, _ops: ops,
    ...overrides,
  } as any;
}

const gap = (n: number) => ({ question: `gap ${n}`, entity: `E${n}`, metric: "Revenue", why: "missing" });

beforeEach(() => {
  vi.clearAllMocks();
  h.plan = { sufficient: true, rationale: "covered", gaps: [] };
  h.leafResult = { nodeId: "rq_gap", title: "g", synthesis: "s", findingCount: 1, children: [], depth: 1, kind: "leaf" };
  h.leafCalls = [];
  h.leafRejections = {};
});

describe("runGapRound", () => {
  it("sufficient → no research, notes the rationale", async () => {
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res).toEqual({ ran: true, gaps: [], filled: 0 });
    expect(researchLeaf).not.toHaveBeenCalled();
    expect(ctx.notes.some((n: string) => n.includes("sufficient"))).toBe(true);
  });

  it("runs each gap as a gapFill leaf, emits kind:'gap' reasoning, wires derived edges to synth", async () => {
    h.plan = { sufficient: false, rationale: "one side missing", gaps: [gap(1), gap(2)] };
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res.filled).toBe(2);
    expect(h.leafCalls).toHaveLength(2);
    // opts.gapFill on every call (last arg)
    for (const args of h.leafCalls) expect(args[args.length - 1]).toEqual({ gapFill: true });
    const reasoning = ctx._events.filter((e: any) => e.type === "reasoning");
    expect(reasoning).toHaveLength(2);
    for (const r of reasoning) expect(r.kind).toBe("gap");
    const edges = ctx._ops.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.filter((e: any) => e.kind === "derived_from" && e.to === "synth")).toHaveLength(2);
    expect(ctx.budget.researchNodes).toBe(4); // reserved
  });

  it("caps at 4 gaps and respects remaining budget", async () => {
    h.plan = { sufficient: false, rationale: "r", gaps: [gap(1), gap(2), gap(3), gap(4), gap(5), gap(6)] };
    const ctx = fakeCtx({ budget: { researchNodes: 18, maxNodes: 20 } }); // room for only 2
    await runGapRound(ctx, "q");
    expect(h.leafCalls).toHaveLength(2);
  });

  it("budget exhausted → skips entirely", async () => {
    const ctx = fakeCtx({ budget: { researchNodes: 20, maxNodes: 20 } });
    const res = await runGapRound(ctx, "q");
    expect(res.ran).toBe(false);
  });

  it("analysis failure → ran:false with a note, never throws", async () => {
    h.plan = new Error("llm down");
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res).toEqual({ ran: false, gaps: [], filled: 0 });
    expect(ctx.notes.some((n: string) => n.includes("gap analysis failed"))).toBe(true);
  });

  it("a gap leaf that finds nothing is not counted as filled and gets no edge", async () => {
    h.plan = { sufficient: false, rationale: "r", gaps: [gap(1)] };
    h.leafResult = { ...h.leafResult, nodeId: null, findingCount: 0 };
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res.filled).toBe(0);
    expect(ctx._ops.filter((o: any) => o.op === "add_edge")).toHaveLength(0);
  });

  it("one gap leaf throwing does not kill the round — the other still fills, and a note is pushed", async () => {
    h.plan = { sufficient: false, rationale: "r", gaps: [gap(1), gap(2)] };
    h.leafRejections["gap 1"] = "leaf-synth stream failed";
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res.ran).toBe(true);
    expect(res.filled).toBe(1); // only gap 2 succeeded
    expect(ctx.notes.some((n: string) => n.includes('gap fill failed for "gap 1"') && n.includes("leaf-synth stream failed"))).toBe(true);
    const edges = ctx._ops.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.filter((e: any) => e.kind === "derived_from" && e.to === "synth")).toHaveLength(1);
  });
});

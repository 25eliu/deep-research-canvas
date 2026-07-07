import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  leaf: [] as string[],   // queries the mocked LLM returns for search-leaf-compose
  broad: [] as string[],  // queries for search-broad-compose
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "search-leaf-compose") return { queries: h.leaf };
    if (opts.label === "search-broad-compose") return { queries: h.broad };
    return {};
  }),
}));

import { searchStrategy } from "./strategy";
import type { ResearchCtx } from "./research";

// searchStrategy only reads ctx.req (for ctxBlock) and ctx.notes.
function stubCtx(): ResearchCtx {
  return {
    req: {
      canvasId: "c", message: "q", surface: "main",
      canvasState: { nodes: [], edges: [] }, providerId: "tako-search",
      takoAnswerEnabled: true, history: [],
    },
    notes: [],
  } as unknown as ResearchCtx;
}

beforeEach(() => { vi.clearAllMocks(); h.leaf = []; h.broad = []; });

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

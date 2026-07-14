import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  leaf: ["US inflation rate", "core CPI"] as string[],
  broad: ["US economy overview"] as string[],
  report: { verdict: "**Inflation is cooling.**", blocks: [{ kind: "prose", md: "Because CPI fell." }] } as any,
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "decompose") return { atomic: true, rationale: "direct", entities: ["US"], metricFilters: ["inflation"] };
    if (opts.label === "search-leaf-compose") return { queries: h.leaf };
    if (opts.label === "search-broad-compose") return { queries: h.broad };
    if (opts.label === "answer-report") return h.report;
    if (opts.label === "gap-analysis") return { sufficient: true, rationale: "covered", gaps: [] };
    return {};
  }),
  streamAnswer: vi.fn(async (opts: any) => { opts.onToken("ok"); return "ok"; }),
}));

// Graph must NEVER be called by the search provider — these throw if invoked.
// (vi.hoisted is required here: vi.mock factories are hoisted above top-level
// consts, so a plain `const graphSearch = vi.fn(...)` referenced inside the
// factory below would throw "Cannot access before initialization".)
const { graphSearch, graphRelated } = vi.hoisted(() => ({
  graphSearch: vi.fn(async () => { throw new Error("graphSearch must not be called"); }),
  graphRelated: vi.fn(async () => { throw new Error("graphRelated must not be called"); }),
}));
vi.mock("./graph", () => ({ graphSearch, graphRelated }));

vi.mock("../../tako", () => ({
  takoSearch: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "c-" + q.slice(0, 6), title: "card " + q, embedUrl: "https://e/" + q.slice(0, 6), source: "FRED" }];
    opts.onCall?.({ query: q, endpoint: "/v3/search", effort: opts.effort ?? "fast", web: !!opts.web, ms: 1, cards });
    return cards;
  }),
}));

import { runTakoInitial } from "./pipeline";
import { searchStrategy } from "./strategy";

const req = {
  canvasId: "c", message: "how is inflation trending?", surface: "main" as const,
  canvasState: { nodes: [], edges: [] }, providerId: "tako-search" as const,
  takoAnswerEnabled: true, history: [],
};

beforeEach(() => { vi.clearAllMocks(); });

describe("runTakoInitial with searchStrategy", () => {
  it("builds a synth answer from LLM-composed queries and issues ZERO graph calls", async () => {
    const events: AgentEvent[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e), searchStrategy);

    // never touched the graph
    expect(graphSearch).not.toHaveBeenCalled();
    expect(graphRelated).not.toHaveBeenCalled();

    // it did run Tako searches using the LLM-composed queries
    const queries = (result.trace.calls ?? []).map((c) => c.query);
    expect(queries).toContain("US inflation rate");

    // produced a synth node + composed report
    const added = result.nodeOps.filter((o: any) => o.op === "add_node");
    expect(added.some((o: any) => o.node.role === "synthesis")).toBe(true);
    const synthUpdate = result.nodeOps.filter((o: any) => o.op === "update_node" && o.id === "synth").pop() as any;
    expect(synthUpdate.patch.report?.verdict).toContain("Inflation is cooling");

    // the trace graph for the (atomic root) node is empty
    const rootNode = result.trace.tree?.find((n: any) => n.nodeId === "synth");
    expect(rootNode?.graph ?? []).toEqual([]);
  });
});

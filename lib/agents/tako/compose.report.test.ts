// lib/agents/tako/compose.report.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  report: {} as any,
  hero: null as any,
  gatherFails: false,
  csv: "Timestamp,Revenue\n2023,26974\n2024,60922",
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "answer-report") return h.report;
    if (opts.label === "graphy-hero") return h.hero;
    return {};
  }),
  generateWithTools: vi.fn(async (opts: any) => {
    if (h.gatherFails) throw new Error("tool loop down");
    // simulate the model fetching one card then answering
    const out = await opts.tools.get_card_contents.execute({ cardId: "nvda" });
    expect(String(out)).toContain("Timestamp");
    return { text: "nvda series fetched", steps: 2 };
  }),
}));

vi.mock("./flow", async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, fetchContents: vi.fn(async () => h.csv) };
});

import { composeReport } from "./compose";
import { newResearchCtx } from "./research";
import { FindingLedger } from "./findings";

function ctxWithCard() {
  const ledger = new FindingLedger();
  ledger.add({ cardId: "nvda", title: "NVDA revenue", embedUrl: "https://e/nvda", webpageUrl: "https://w/nvda", source: "S&P Global", description: "Revenue" } as any, "synth");
  const ctx = newResearchCtx(
    { canvasId: "c", message: "q", surface: "main", canvasState: { nodes: [], edges: [] }, providerId: "tako", history: [] } as any,
    ledger, () => {},
  );
  ctx.branchResults.push({ question: "nvidia revenue", claim: "up", confidence: 0.8, figures: [] });
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.hero = null;
  h.gatherFails = false;
  h.report = { verdict: "**Up.**", blocks: [{ kind: "prose", md: "Because." }] };
});

describe("composeReport v2 — agentic gather + GPT emit", () => {
  it("comparison points copied from a fetched CSV survive validation", async () => {
    h.report = { verdict: "**Nvidia leads.**", blocks: [{
      kind: "comparison", series: [
        { label: "NVDA", entity: "Nvidia", points: [{ x: "2024", y: 60922 }, { x: "fake", y: 123456789 }] },
      ],
    }] };
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    const comp: any = report!.blocks[0];
    expect(comp.series[0].points).toEqual([{ x: "2024", y: 60922 }]); // real CSV value kept, invented dropped
  });

  it("records a /v1/contents tako_call on synth for each tool fetch", async () => {
    const ctx = ctxWithCard();
    await composeReport(ctx, "q");
    const contentsCalls = ctx.calls.filter((c) => c.endpoint === "/v1/contents");
    expect(contentsCalls).toHaveLength(1);
    expect(contentsCalls[0].nodeId).toBe("synth");
    expect(contentsCalls[0].cards[0].id).toBe("nvda");
  });

  it("gather failure falls back to composing without card contents", async () => {
    h.gatherFails = true;
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    expect(report?.verdict).toContain("Up");
    expect(ctx.notes.some((n) => n.includes("report gather failed"))).toBe(true);
  });

  it("report failure returns null with a note (no Claude fallback anymore)", async () => {
    const { generateStructured } = await import("../../llm");
    (generateStructured as any).mockRejectedValueOnce(new Error("model down"));
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    expect(report).toBeNull();
  });

  it("graphyEnabled:true attaches a validated graphy hero to the report", async () => {
    h.report = { verdict: "NVDA leads", blocks: [] };
    h.hero = {
      title: "Revenue doubles",
      config: {
        type: "column",
        data: {
          columns: [{ key: "x", label: "Year" }, { key: "s0", label: "Revenue" }],
          rows: [{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }],
        },
      },
    };
    const ctx = ctxWithCard();
    ctx.req.graphyEnabled = true;
    const report = await composeReport(ctx, "how is NVDA revenue");
    expect(report?.graphy?.title).toBe("Revenue doubles");
  });

  it("graphyEnabled unset → no graphy field and no graphy-hero LLM call", async () => {
    h.report = { verdict: "v", blocks: [] };
    const { generateStructured } = await import("../../llm");
    const report = await composeReport(ctxWithCard(), "how is NVDA revenue");
    expect(report?.graphy).toBeUndefined();
    expect(generateStructured).not.toHaveBeenCalledWith(expect.objectContaining({ label: "graphy-hero" }));
  });
});

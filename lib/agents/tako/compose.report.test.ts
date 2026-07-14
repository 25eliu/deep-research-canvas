// lib/agents/tako/compose.report.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  report: {} as any,
  hero: null as any,
  gatherFails: false,
  readCards: ["nvda"] as string[], // cardIds the mocked gather loop reads via get_card_contents
  readWebUrls: [] as string[], // urls the mocked gather loop reads via get_web_content
  webToolOut: "" as string, // what get_web_content returned to the mocked loop
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
    for (const id of h.readCards) {
      const out = await opts.tools.get_card_contents.execute({ cardId: id });
      if (id === "nvda") expect(String(out)).toContain("Timestamp");
    }
    for (const url of h.readWebUrls) {
      h.webToolOut = String(await opts.tools.get_web_content.execute({ url }));
    }
    return { text: "gather note", steps: 2 };
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
  h.readCards = ["nvda"];
  h.readWebUrls = [];
  h.webToolOut = "";
  h.report = { verdict: "**Up.**", blocks: [{ kind: "prose", md: "Because." }] };
});

describe("composeReport v3 — deterministic gather + GPT emit", () => {
  it("comparison points copied from a CSV the fallback gather read survive validation", async () => {
    h.report = { verdict: "**Nvidia leads.**", blocks: [{
      kind: "comparison", series: [
        { label: "NVDA", entity: "Nvidia", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }, { x: "fake", y: 123456789 }] },
      ],
    }] };
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    const comp: any = report!.blocks[0];
    expect(comp.series[0].points).toEqual([{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }]); // real CSV values kept, invented dropped
  });

  it("fallback gather runs only when nothing is cached — records a /v1/contents tako_call on synth", async () => {
    const ctx = ctxWithCard(); // no cache entries → the LLM gather loop must run
    const { generateWithTools } = await import("../../llm");
    await composeReport(ctx, "q");
    expect(generateWithTools).toHaveBeenCalledTimes(1);
    const contentsCalls = ctx.calls.filter((c) => c.endpoint === "/v1/contents");
    expect(contentsCalls).toHaveLength(1);
    expect(contentsCalls[0].nodeId).toBe("synth");
    expect(contentsCalls[0].cards[0].id).toBe("nvda");
  });

  it("leaf-cached CSVs feed CARD_CONTENTS deterministically — no LLM gather call at all", async () => {
    const ctx = ctxWithCard();
    ctx.contents.cache.set("https://w/nvda", h.csv); // a leaf already pulled this card's series
    h.report = { verdict: "**Nvidia leads.**", blocks: [{
      kind: "comparison", series: [
        { label: "NVDA", entity: "Nvidia", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }, { x: "fake", y: 123456789 }] },
      ],
    }] };
    const { generateWithTools, generateStructured } = await import("../../llm");
    const report = await composeReport(ctx, "q");
    expect(generateWithTools).not.toHaveBeenCalled(); // one whole LLM round-trip removed
    // Cache reads mint honest trace records (cached:true, no network) so the UI can
    // show which series the report consumed.
    const contentsCalls = ctx.calls.filter((c) => c.endpoint === "/v1/contents");
    expect(contentsCalls).toHaveLength(1);
    expect(contentsCalls[0].cached).toBe(true);
    expect(contentsCalls[0].ms).toBe(0);
    // the cached CSV is inlined into the emit prompt's CARD_CONTENTS
    const reportCall = (generateStructured as any).mock.calls.find((c: any) => c[0].label === "answer-report")[0];
    expect(String(reportCall.prompt)).toContain("Timestamp");
    const comp: any = report!.blocks[0];
    expect(comp.series[0].points).toEqual([{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }]);
  });

  it("question-relevant cached cards are ordered first in CARD_CONTENTS", async () => {
    const ctx = ctxWithCard(); // ledger already has "nvda" (NVDA revenue)
    ctx.ledger.add({ cardId: "amd", title: "AMD revenue", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "S&P Global" } as any, "AMD");
    ctx.contents.cache.set("https://w/nvda", h.csv);
    ctx.contents.cache.set("https://w/amd", "Timestamp,Revenue\n2024,26974");
    const { generateStructured } = await import("../../llm");
    await composeReport(ctx, "how is AMD doing");
    const reportCall = (generateStructured as any).mock.calls.find((c: any) => c[0].label === "answer-report")[0];
    const prompt = String(reportCall.prompt);
    expect(prompt.indexOf('"amd"')).toBeGreaterThan(-1);
    expect(prompt.indexOf('"amd"')).toBeLessThan(prompt.indexOf('"nvda"')); // AMD named in the question → first
  });

  it("validates against the full per-turn cache even when the gather loop read nothing", async () => {
    const ctx = ctxWithCard();
    ctx.contents.cache.set("https://w/nvda", h.csv);
    h.readCards = []; // the composer decided it needed no series re-read
    h.report = { verdict: "**Nvidia leads.**", blocks: [{
      kind: "tiles", tiles: [{ label: "FY24 revenue", value: "60922" }, { label: "fake", value: "123456789" }],
    }] };
    const report = await composeReport(ctx, "q");
    const tiles: any = report!.blocks[0];
    expect(tiles.tiles).toEqual([{ label: "FY24 revenue", value: "60922" }]); // cached CSV still whitelists real values
  });

  it("web sources reach the report as snippets only; full content stays behind get_web_content", async () => {
    const ctx = ctxWithCard();
    ctx.webSources.push({ title: "Article", source: "Reuters", url: "https://web/x", summary: "short snip", content: "FULLPAGECONTENT ".repeat(50) });
    h.readWebUrls = ["https://web/x"];
    await composeReport(ctx, "q");
    expect(h.webToolOut).toContain("FULLPAGECONTENT"); // the tool serves the full text from memory
    const { generateStructured } = await import("../../llm");
    const reportCall = (generateStructured as any).mock.calls.find((c: any) => c[0].label === "answer-report")[0];
    expect(String(reportCall.prompt)).toContain("short snip");
    expect(String(reportCall.prompt)).not.toContain("FULLPAGECONTENT"); // no 1.5k-char content inlined
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

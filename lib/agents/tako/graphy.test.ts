// lib/agents/tako/graphy.test.ts
import { vi } from "vitest";
const h = vi.hoisted(() => ({
  hero: null as unknown, // what the mocked graphy-hero LLM call returns
  heroFails: false,
}));
vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: { label: string }) => {
    if (opts.label === "graphy-hero") {
      if (h.heroFails) throw new Error("model down");
      return h.hero;
    }
    return {};
  }),
  // compose.ts (imported for allowedSets/traceable) also pulls this from ../../llm —
  // the factory must provide it or the import binding is undefined.
  generateWithTools: vi.fn(async () => ({ text: "", steps: 0 })),
}));

import { describe, it, expect } from "vitest";
import { zGraphyConfig, zAnswerReportEmit, zAnswerReport } from "../../schema";

describe("zGraphyConfig", () => {
  const valid = {
    type: "line",
    data: {
      columns: [{ key: "x", label: "Year" }, { key: "s0", label: "NVDA revenue" }],
      rows: [{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }],
    },
  };

  it("accepts a minimal valid config (string and number cell values)", () => {
    expect(zGraphyConfig.parse(valid)).toEqual(valid);
  });

  it("rejects unknown chart types", () => {
    expect(() => zGraphyConfig.parse({ ...valid, type: "radar" })).toThrow();
  });

  it("rejects configs with fewer than 2 columns or 0 rows", () => {
    expect(() => zGraphyConfig.parse({ ...valid, data: { ...valid.data, columns: [valid.data.columns[0]] } })).toThrow();
    expect(() => zGraphyConfig.parse({ ...valid, data: { ...valid.data, rows: [] } })).toThrow();
  });
});

describe("report schema split", () => {
  it("zAnswerReportEmit REJECTS a graphy field (composer LLM can never emit one)", () => {
    const emit = zAnswerReportEmit.strict();
    expect(() => emit.parse({ verdict: "v", blocks: [], graphy: { config: {} } })).toThrow();
  });

  it("zAnswerReport accepts an optional graphy block", () => {
    const r = zAnswerReport.parse({
      verdict: "v", blocks: [],
      graphy: { title: "t", config: { type: "column", data: { columns: [{ key: "x", label: "" }, { key: "s0", label: "rev" }], rows: [{ x: "2024", s0: 1 }] } } },
    });
    expect(r.graphy?.config.type).toBe("column");
  });
});

import { enforceTraceable, seriesToGraphyConfig, fallbackGraphyBlock } from "./graphy";
import { allowedSets } from "./compose";
import type { AnswerBlock, GraphyConfig } from "../../schema";

// Allowed figures mimic what csvFigures extracts from a fetched card CSV.
const ALLOWED = allowedSets([
  { label: "NVDA Revenue 2023", value: "26974" },
  { label: "NVDA Revenue 2024", value: "60922" },
  { label: "AMD Revenue 2024", value: "25785" },
]);

function cfg(rows: Record<string, string | number>[]): GraphyConfig {
  return {
    type: "column",
    data: {
      columns: [{ key: "x", label: "Year" }, { key: "s0", label: "Revenue" }],
      rows,
    },
  };
}

describe("enforceTraceable — every number must come from Tako card contents", () => {
  it("passes a fully traceable config through unchanged (x-axis labels exempt)", () => {
    const c = cfg([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }]);
    expect(enforceTraceable(c, ALLOWED, () => {})).toEqual(c);
  });

  it("drops rows whose numeric values are untraceable, keeps the rest", () => {
    const c = cfg([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }, { x: "2025", s0: 999999 }]);
    const out = enforceTraceable(c, ALLOWED, () => {});
    expect(out?.data.rows).toEqual([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }]);
  });

  it("does not mutate the input config", () => {
    const c = cfg([{ x: "2023", s0: 26974 }, { x: "2025", s0: 999999 }, { x: "2024", s0: 60922 }]);
    const snapshot = JSON.parse(JSON.stringify(c));
    enforceTraceable(c, ALLOWED, () => {});
    expect(c).toEqual(snapshot);
  });

  it("discards the whole config when most numeric values are untraceable", () => {
    const drops: string[] = [];
    const c = cfg([{ x: "2023", s0: 111 }, { x: "2024", s0: 222 }, { x: "2025", s0: 26974 }]);
    expect(enforceTraceable(c, ALLOWED, (w) => drops.push(w))).toBeNull();
    expect(drops.length).toBeGreaterThan(0);
  });

  it("discards a config left with fewer than 2 rows", () => {
    const c = cfg([{ x: "2024", s0: 60922 }, { x: "2025", s0: 42 }]);
    expect(enforceTraceable(c, ALLOWED, () => {})).toBeNull();
  });

  it("matches values by magnitude within 0.5% (formatted values like $26,974 pass)", () => {
    const c = cfg([{ x: "2023", s0: "$26,974" }, { x: "2024", s0: "60,922" }]);
    expect(enforceTraceable(c, ALLOWED, () => {})).not.toBeNull();
  });
});

describe("seriesToGraphyConfig — deterministic fallback from existing report blocks", () => {
  const series = [
    { label: "NVDA", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }] },
    { label: "AMD", points: [{ x: "2024", y: 25785 }] },
  ];

  it("converts multi-series points to columns+rows, bar→column, aligning by x", () => {
    const out = seriesToGraphyConfig("bar", series);
    expect(out.type).toBe("column");
    expect(out.data.columns).toEqual([
      { key: "x", label: "Category" },
      { key: "s0", label: "NVDA" },
      { key: "s1", label: "AMD" },
    ]);
    expect(out.data.rows).toEqual([
      { x: "2023", s0: 26974 },
      { x: "2024", s0: 60922, s1: 25785 },
    ]);
  });

  it("keeps line as line", () => {
    expect(seriesToGraphyConfig("line", series).type).toBe("line");
  });
});

describe("fallbackGraphyBlock — first chart/comparison block wins", () => {
  const chartBlock: AnswerBlock = {
    kind: "chart", title: "Revenue",
    chartSpec: { kind: "line", series: [{ label: "NVDA", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }] }] },
  };
  const comparisonBlock: AnswerBlock = {
    kind: "comparison", title: "NVDA vs AMD",
    series: [{ label: "NVDA", entity: "NVIDIA", points: [{ x: "2024", y: 60922 }] }],
  };

  it("converts the first chart block (already validated by composeReport)", () => {
    const out = fallbackGraphyBlock([{ kind: "prose", md: "hi" }, chartBlock, comparisonBlock]);
    expect(out?.title).toBe("Revenue");
    expect(out?.config.type).toBe("line");
    expect(out?.config.data.rows).toHaveLength(2);
  });

  it("converts a comparison block when no chart block exists (comparison → line)", () => {
    const out = fallbackGraphyBlock([comparisonBlock]);
    expect(out?.title).toBe("NVDA vs AMD");
    expect(out?.config.type).toBe("line");
  });

  it("returns null when no convertible block exists", () => {
    expect(fallbackGraphyBlock([{ kind: "prose", md: "hi" }])).toBeNull();
  });
});

import { composeGraphyHero } from "./graphy";
import { newResearchCtx } from "./research";
import { FindingLedger } from "./findings";
import type { AgentRequest } from "../../schema";

function heroCtx() {
  const req: AgentRequest = {
    canvasId: "c", message: "compare NVDA and AMD revenue", surface: "main",
    canvasState: { nodes: [], edges: [] }, providerId: "tako",
    takoAnswerEnabled: true, graphyEnabled: true, history: [],
  };
  return newResearchCtx(req, new FindingLedger(), () => {});
}

const CARD_CONTENTS = [{ cardId: "nvda", title: "NVDA Revenue", data: "Year,Revenue\n2023,26974\n2024,60922" }];
const GOOD_HERO = {
  title: "NVDA revenue surge",
  config: {
    type: "column",
    data: {
      columns: [{ key: "x", label: "Year" }, { key: "s0", label: "Revenue ($M)" }],
      rows: [{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }],
    },
  },
};
const CHART_BLOCK: AnswerBlock = {
  kind: "chart", title: "Revenue",
  chartSpec: { kind: "bar", series: [{ label: "NVDA", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }] }] },
};

describe("composeGraphyHero", () => {
  it("returns the LLM-modeled block when every number traces to card contents", async () => {
    h.heroFails = false; h.hero = GOOD_HERO;
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [], CARD_CONTENTS, ALLOWED);
    expect(out?.title).toBe("NVDA revenue surge");
    expect(out?.config.data.rows).toHaveLength(2);
  });

  it("falls back to the report's chart block when the modeled numbers are untraceable", async () => {
    h.heroFails = false;
    h.hero = { ...GOOD_HERO, config: { ...GOOD_HERO.config, data: { ...GOOD_HERO.config.data, rows: [{ x: "2023", s0: 111 }, { x: "2024", s0: 222 }] } } };
    const ctx = heroCtx();
    const out = await composeGraphyHero(ctx, "q", "verdict", [CHART_BLOCK], CARD_CONTENTS, ALLOWED);
    expect(out?.config.type).toBe("column"); // converted bar chartSpec, not the fabricated config
    expect(out?.config.data.rows).toEqual([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }]);
    expect(ctx.notes.some((n) => n.includes("graphy"))).toBe(true);
  });

  it("falls back when the LLM call throws", async () => {
    h.heroFails = true;
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [CHART_BLOCK], CARD_CONTENTS, ALLOWED);
    expect(out?.config.data.rows).toHaveLength(2);
  });

  it("returns null (silent degradation) when the LLM fails and no convertible block exists", async () => {
    h.heroFails = true;
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [{ kind: "prose", md: "p" }], CARD_CONTENTS, ALLOWED);
    expect(out).toBeNull();
  });

  it("skips the LLM entirely when there are no card contents (straight to fallback)", async () => {
    h.heroFails = false; h.hero = GOOD_HERO;
    const { generateStructured } = await import("../../llm");
    (generateStructured as ReturnType<typeof vi.fn>).mockClear();
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [CHART_BLOCK], [], ALLOWED);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(out?.config.data.rows).toHaveLength(2);
  });

  // Provenance: the shipped block is stamped with how it was produced, the ctx
  // carries the trace info the pipeline persists, and a live "graphy" event streams
  // the same outcome to the chat UI.
  it("modeled: stamps source, sets ctx.graphyTrace, emits a graphy event", async () => {
    h.heroFails = false; h.hero = GOOD_HERO;
    const ctx = heroCtx();
    const events: { type: string; info?: { outcome: string } }[] = [];
    ctx.emit = (e) => events.push(e as (typeof events)[number]);
    const out = await composeGraphyHero(ctx, "q", "verdict", [], CARD_CONTENTS, ALLOWED);
    expect(out?.source).toBe("modeled");
    expect(ctx.graphyTrace).toMatchObject({ outcome: "modeled", series: 1, rows: 2 });
    expect(events.find((e) => e.type === "graphy")?.info?.outcome).toBe("modeled");
  });

  it("fallback: stamps source and traces outcome when the LLM fails", async () => {
    h.heroFails = true;
    const ctx = heroCtx();
    const out = await composeGraphyHero(ctx, "q", "verdict", [CHART_BLOCK], CARD_CONTENTS, ALLOWED);
    expect(out?.source).toBe("fallback");
    expect(ctx.graphyTrace?.outcome).toBe("fallback");
  });

  it("none: traces the no-hero outcome so the UI can say so", async () => {
    h.heroFails = true;
    const ctx = heroCtx();
    const out = await composeGraphyHero(ctx, "q", "verdict", [{ kind: "prose", md: "p" }], CARD_CONTENTS, ALLOWED);
    expect(out).toBeNull();
    expect(ctx.graphyTrace?.outcome).toBe("none");
  });
});

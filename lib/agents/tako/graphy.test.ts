// lib/agents/tako/graphy.test.ts
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

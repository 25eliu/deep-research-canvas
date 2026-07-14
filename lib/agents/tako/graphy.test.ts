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

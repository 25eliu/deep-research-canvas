import { describe, it, expect } from "vitest";
import { numericMagnitude, csvFigures, validateBlock, allowedSets } from "./compose";

describe("numericMagnitude", () => {
  it("parses plain numbers and thousands separators", () => {
    expect(numericMagnitude("5,780")).toBe(5780);
    expect(numericMagnitude("71")).toBe(71);
  });
  it("parses percentages as their face value", () => {
    expect(numericMagnitude("71%")).toBe(71);
  });
  it("scales magnitude suffixes", () => {
    expect(numericMagnitude("$75.2B")).toBeCloseTo(75.2e9, 0);
    expect(numericMagnitude("$5.78 billion")).toBeCloseTo(5.78e9, 0);
    expect(numericMagnitude("$34.6M")).toBeCloseTo(34.6e6, 0);
    expect(numericMagnitude("$1.39K")).toBeCloseTo(1.39e3, 0);
  });
  it("returns null for pure text", () => {
    expect(numericMagnitude("data center")).toBeNull();
    expect(numericMagnitude("")).toBeNull();
  });
});

const allow = (values: string[]) => allowedSets(values.map((value) => ({ label: "f", value })));

describe("csvFigures", () => {
  it("turns every numeric cell (per column) into a gathered figure", () => {
    const csv = "Timestamp,Revenue,Margin\n2023,26974,0.56\n2024,60922,0.72";
    const figs = csvFigures(csv, "NVDA");
    expect(figs.some((f) => f.value === "26974")).toBe(true);
    expect(figs.some((f) => f.value === "0.72")).toBe(true);
    expect(figs.every((f) => f.label.startsWith("NVDA"))).toBe(true);
  });
  it("returns [] for a header-only or empty csv", () => {
    expect(csvFigures("", "x")).toEqual([]);
    expect(csvFigures("Timestamp,V", "x")).toEqual([]);
  });
});

describe("validateBlock — new kinds", () => {
  it("comparison: drops untraceable points, drops emptied series, keeps traceable", () => {
    const block: any = { kind: "comparison", series: [
      { label: "NVDA", entity: "Nvidia", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }, { x: "2022", y: 999999 }] },
      { label: "AMD", entity: "AMD", points: [{ x: "2024", y: 424242 }] },
    ] };
    const out: any = validateBlock(block, allow(["26974", "60922"]), () => {});
    expect(out.series).toHaveLength(1);
    expect(out.series[0].points).toEqual([{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }]);
  });
  it("comparison: a degenerate single-surviving-point block is dropped entirely", () => {
    const block: any = { kind: "comparison", series: [
      { label: "NVDA", entity: "Nvidia", points: [{ x: "2024", y: 60922 }, { x: "fake", y: 999999 }] },
    ] };
    expect(validateBlock(block, allow(["60922"]), () => {})).toBeNull();
  });
  it("chart: a degenerate single-surviving-point block is dropped entirely", () => {
    const block: any = { kind: "chart", chartSpec: { kind: "line", series: [
      { label: "NVDA", points: [{ x: "2024", y: 60922 }, { x: "fake", y: 999999 }] },
    ] } };
    expect(validateBlock(block, allow(["60922"]), () => {})).toBeNull();
  });
  it("leaderboard: a minority of untraceable values blanks to '—', ranking intact", () => {
    const block: any = { kind: "leaderboard", metricLabel: "Rev", rows: [
      { rank: 1, entity: "Nvidia", value: "$60,922", detail: { md: "ok", stats: [{ label: "fake", value: "$1" }] } },
      { rank: 2, entity: "AMD", value: "$26,974" },
      { rank: 3, entity: "Intel", value: "$999" },
    ] };
    const out: any = validateBlock(block, allow(["$60,922", "$26,974"]), () => {});
    expect(out.kind).toBe("leaderboard");
    expect(out.rows).toHaveLength(3); // the ranking never loses rows
    expect(out.rows[0].value).toBe("$60,922");
    expect(out.rows[0].detail.stats).toEqual([]);
    expect(out.rows[2].value).toBe("—"); // untraceable value blanked, row kept
  });
  it("leaderboard: mostly-untraceable values convert to a prose ranked list — no '—' dashes", () => {
    const block: any = { kind: "leaderboard", title: "Top AI labs", metricLabel: "Rev", rows: [
      { rank: 1, entity: "OpenAI", value: "$999B", detail: { md: "largest lab" } },
      { rank: 2, entity: "Anthropic", value: "$888B" },
      { rank: 3, entity: "Nvidia", value: "$60,922" },
    ] };
    const out: any = validateBlock(block, allow(["$60,922"]), () => {});
    expect(out.kind).toBe("prose");
    expect(out.md).toContain("**Top AI labs**");
    expect(out.md).toContain("1. **OpenAI** — largest lab");
    expect(out.md).toContain("3. **Nvidia** ($60,922)"); // traceable value kept inline
    expect(out.md).not.toContain("—\n"); // no placeholder dashes anywhere
    expect(out.md).not.toContain("$999B");
  });
  it("leaderboard: all values untraceable → prose ranked roster without values", () => {
    const block: any = { kind: "leaderboard", metricLabel: "Rev", rows: [
      { rank: 1, entity: "OpenAI", value: "$999B" },
      { rank: 2, entity: "Anthropic", value: "$888B" },
    ] };
    const out: any = validateBlock(block, allow(["$1"]), () => {});
    expect(out.kind).toBe("prose");
    expect(out.md).toContain("1. **OpenAI**");
    expect(out.md).not.toContain("$999B");
    expect(out.md).not.toContain("(");
  });
  it("table: a fully-untraceable value column is pruned (header included)", () => {
    const block: any = { kind: "table", columns: ["Company", "Revenue", "Employees"], rows: [
      ["Nvidia", "$60,922", "29,600"],
      ["AMD", "$26,974", "26,000"],
    ] };
    const out: any = validateBlock(block, allow(["$60,922", "$26,974"]), () => {});
    expect(out.columns).toEqual(["Company", "Revenue"]);
    expect(out.rows).toEqual([["Nvidia", "$60,922"], ["AMD", "$26,974"]]);
  });
  it("table: a row with no traceable values is pruned", () => {
    const block: any = { kind: "table", columns: ["Company", "Revenue"], rows: [
      ["Nvidia", "$60,922"],
      ["OpenAI", "$999B"],
      ["AMD", "$26,974"],
    ] };
    const out: any = validateBlock(block, allow(["$60,922", "$26,974"]), () => {});
    expect(out.rows).toEqual([["Nvidia", "$60,922"], ["AMD", "$26,974"]]);
  });
  it("table: mostly-untraceable numeric cells drop the whole block", () => {
    const block: any = { kind: "table", columns: ["Company", "Revenue", "Employees"], rows: [
      ["Nvidia", "$60,922", "$1"],
      ["AMD", "$2", "$3"],
    ] };
    expect(validateBlock(block, allow(["$60,922"]), () => {})).toBeNull();
  });
  it("table: pure-text columns survive pruning untouched", () => {
    const block: any = { kind: "table", columns: ["Company", "HQ", "Revenue"], rows: [
      ["Nvidia", "Santa Clara", "$60,922"],
      ["AMD", "Santa Clara", "$26,974"],
    ] };
    const out: any = validateBlock(block, allow(["$60,922", "$26,974"]), () => {});
    expect(out.columns).toEqual(["Company", "HQ", "Revenue"]);
    expect(out.rows).toHaveLength(2);
  });
  it("sections: strips an untraceable figure but keeps the section prose", () => {
    const block: any = { kind: "sections", sections: [
      { title: "Rates", md: "Higher.", figure: { label: "Fed", value: "9.9%" } },
    ] };
    const out: any = validateBlock(block, allow(["5.5%"]), () => {});
    expect(out.sections[0].figure).toBeUndefined();
    expect(out.sections[0].md).toBe("Higher.");
  });
  it("timeline: strips untraceable values, keeps the event", () => {
    const block: any = { kind: "timeline", events: [{ date: "2024", title: "Launch", value: "$77B" }] };
    const out: any = validateBlock(block, allow(["$30B"]), () => {});
    expect(out.events[0].value).toBeUndefined();
    expect(out.events[0].title).toBe("Launch");
  });
  it("magnitude matching: a suffixed figure keeps an equivalent differently-formatted value", () => {
    const block: any = { kind: "leaderboard", metricLabel: "Rev", rows: [
      { rank: 1, entity: "Nvidia", value: "$75.2B" },
    ] };
    const out: any = validateBlock(block, allow(["$75.2 billion"]), () => {});
    expect(out.rows).toHaveLength(1);
  });
});

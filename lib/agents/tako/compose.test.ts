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
      { label: "NVDA", entity: "Nvidia", points: [{ x: "2024", y: 60922 }, { x: "2023", y: 999999 }] },
      { label: "AMD", entity: "AMD", points: [{ x: "2024", y: 424242 }] },
    ] };
    const out: any = validateBlock(block, allow(["60922"]), () => {});
    expect(out.series).toHaveLength(1);
    expect(out.series[0].points).toEqual([{ x: "2024", y: 60922 }]);
  });
  it("leaderboard: drops rows with untraceable values, filters detail stats", () => {
    const block: any = { kind: "leaderboard", metricLabel: "Rev", rows: [
      { rank: 1, entity: "Nvidia", value: "$60,922", detail: { md: "ok", stats: [{ label: "fake", value: "$1" }] } },
      { rank: 2, entity: "AMD", value: "$999" },
    ] };
    const out: any = validateBlock(block, allow(["$60,922"]), () => {});
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].detail.stats).toEqual([]);
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

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ComparisonChart, { sortedDomain } from "./ComparisonChart";

// @testing-library/react's auto-cleanup only registers when it detects a global
// `afterEach` (i.e. vitest's `test.globals: true`). Our vitest.config.ts keeps
// globals off, so wire cleanup explicitly to avoid renders leaking across tests.
afterEach(cleanup);

const block = {
  kind: "comparison" as const,
  title: "Revenue", unit: "USD bn",
  series: [
    { label: "Nvidia", entity: "Nvidia", points: [{ x: "2022", y: 27 }, { x: "2023", y: 61 }, { x: "2024", y: 130 }] },
    { label: "AMD", entity: "AMD", points: [{ x: "2022", y: 24 }, { x: "2023", y: 23 }, { x: "2024", y: 26 }] },
  ],
  insight: "Nvidia tripled while AMD stayed flat.",
};

// jsdom can't measure ResponsiveContainer — explicit width/height makes recharts
// render its SVG synchronously.
const SIZE = { width: 560, height: 240 };

const tickLabels = (container: HTMLElement) =>
  Array.from(container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick text"))
    .map((el) => el.textContent);

describe("ComparisonChart", () => {
  it("renders a legend chip per series with the latest value", () => {
    render(<ComparisonChart block={block} {...SIZE} />);
    expect(screen.getByText("Nvidia")).toBeTruthy();
    expect(screen.getByText("AMD")).toBeTruthy();
    expect(screen.getByText("130")).toBeTruthy();
    expect(screen.getByText("26")).toBeTruthy();
  });
  it("renders one line per series and the insight line", () => {
    const { container } = render(<ComparisonChart block={block} {...SIZE} />);
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(2);
    expect(screen.getByText(/tripled/)).toBeTruthy();
  });
  it("falls back to grouped bars when a series has under 3 points", () => {
    const bars = { ...block, series: block.series.map((s) => ({ ...s, points: s.points.slice(0, 2) })) };
    const { container } = render(<ComparisonChart block={bars} {...SIZE} />);
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(0);
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBeGreaterThan(0);
  });
  it("shows full x-axis tick labels — no string truncation", () => {
    const { container } = render(<ComparisonChart block={block} {...SIZE} />);
    const labels = tickLabels(container);
    expect(labels).toContain("2022");
    expect(labels).toContain("2024");
  });
  it("sorts a numeric/date-like x-domain instead of keeping first-appearance (interleaved series) order", () => {
    const interleaved = {
      ...block,
      series: [
        { label: "A", entity: "A", points: [{ x: "2022", y: 1 }, { x: "2024", y: 3 }] },
        { label: "B", entity: "B", points: [{ x: "2023", y: 2 }] },
      ],
    };
    const { container } = render(<ComparisonChart block={interleaved} {...SIZE} />);
    expect(tickLabels(container)).toEqual(["2022", "2023", "2024"]);
  });
});

describe("sortedDomain", () => {
  it("sorts numeric domains", () => {
    expect(sortedDomain(["2024", "2022", "2023"])).toEqual(["2022", "2023", "2024"]);
  });
  it("sorts date-like domains", () => {
    expect(sortedDomain(["2024-03-01", "2023-01-15", "2023-06-30"]))
      .toEqual(["2023-01-15", "2023-06-30", "2024-03-01"]);
  });
  it("keeps appearance order for categorical domains", () => {
    expect(sortedDomain(["Cloud", "Ads", "Devices"])).toEqual(["Cloud", "Ads", "Devices"]);
  });
});

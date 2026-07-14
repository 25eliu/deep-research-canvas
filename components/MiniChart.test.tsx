import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import MiniChart from "./MiniChart";

// Explicit afterEach cleanup — vitest globals are off (see ComparisonChart.test.tsx).
afterEach(cleanup);

// jsdom can't measure ResponsiveContainer — explicit width/height makes recharts
// render its SVG synchronously.
const SIZE = { width: 274, height: 176 };

const lineSpec = {
  kind: "line" as const, unit: "USD bn",
  series: [{ label: "Revenue", points: [{ x: "2022", y: 27 }, { x: "2023", y: 61 }, { x: "2024", y: 130 }] }],
};

describe("MiniChart", () => {
  it("renders the no-data fallback for an empty spec", () => {
    const { container } = render(<MiniChart spec={{ kind: "line", series: [] }} {...SIZE} />);
    expect(container.querySelector(".empty-note")?.textContent).toBe("no data");
  });
  it("renders a line with one curve and the unit label", () => {
    const { container } = render(<MiniChart spec={lineSpec} {...SIZE} />);
    expect(container.querySelectorAll(".recharts-line-curve")).toHaveLength(1);
    expect(container.querySelector(".chart-unit")?.textContent).toBe("USD bn");
  });
  it("renders one bar per point in bar mode", () => {
    const { container } = render(<MiniChart spec={{ ...lineSpec, kind: "bar" }} {...SIZE} />);
    expect(container.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(3);
  });
  it("keeps long category labels whole — no string truncation", () => {
    const spec = {
      kind: "bar" as const,
      series: [{ label: "GDP", points: [{ x: "United Kingdom", y: 3 }, { x: "United States", y: 27 }] }],
    };
    const { container } = render(<MiniChart spec={spec} {...SIZE} />);
    const labels = Array.from(container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick text"))
      .map((el) => el.textContent);
    expect(labels).toContain("United Kingdom");
    expect(labels).toContain("United States");
  });
});

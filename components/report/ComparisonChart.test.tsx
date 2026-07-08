import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import ComparisonChart from "./ComparisonChart";

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

describe("ComparisonChart", () => {
  it("renders a legend chip per series with the latest value", () => {
    render(<ComparisonChart block={block} />);
    expect(screen.getByText("Nvidia")).toBeTruthy();
    expect(screen.getByText("AMD")).toBeTruthy();
    expect(screen.getByText("130")).toBeTruthy();
    expect(screen.getByText("26")).toBeTruthy();
  });
  it("renders one polyline per series and the insight line", () => {
    const { container } = render(<ComparisonChart block={block} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    expect(screen.getByText(/tripled/)).toBeTruthy();
  });
  it("falls back to grouped bars when a series has under 3 points", () => {
    const bars = { ...block, series: block.series.map((s) => ({ ...s, points: s.points.slice(0, 2) })) };
    const { container } = render(<ComparisonChart block={bars} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
  });
});

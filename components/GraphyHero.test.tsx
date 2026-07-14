import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import GraphyHero from "./GraphyHero";
import type { GraphyBlock } from "@/lib/schema";

// Explicit afterEach cleanup — vitest globals are off (see ComparisonChart.test.tsx).
afterEach(cleanup);

// jsdom can't measure ResponsiveContainer — explicit width makes recharts render
// its SVG synchronously (see MiniChart.test.tsx).
const WIDTH = 480;

const lineBlock: GraphyBlock = {
  title: "Revenue vs profit",
  config: {
    type: "line",
    data: {
      columns: [
        { key: "year", label: "Year" },
        { key: "revenue", label: "Revenue" },
        { key: "profit", label: "Profit" },
      ],
      rows: [
        { year: "2022", revenue: 27, profit: 4 },
        { year: "2023", revenue: 61, profit: 9 },
        { year: "2024", revenue: 130, profit: 22 },
      ],
    },
  },
};

const columnBlock: GraphyBlock = {
  config: {
    type: "column",
    data: {
      columns: [
        { key: "quarter", label: "Quarter" },
        { key: "units", label: "Units" },
      ],
      rows: [
        { quarter: "Q1", units: 12 },
        { quarter: "Q2", units: 18 },
      ],
    },
  },
};

const degenerateBlock: GraphyBlock = {
  config: {
    type: "line",
    data: {
      columns: [
        { key: "label", label: "Label" },
        { key: "note", label: "Note" },
      ],
      rows: [
        { label: "a", note: "--" },
        { label: "b", note: "--" },
      ],
    },
  },
};

const formattedBlock: GraphyBlock = {
  config: {
    type: "bar",
    data: {
      columns: [
        { key: "company", label: "Company" },
        { key: "revenue", label: "Revenue" },
      ],
      rows: [
        { company: "Acme", revenue: "$26,974" },
        { company: "Globex", revenue: "$8,102" },
      ],
    },
  },
};

// A pure-non-digit placeholder ("N/A") must GAP, not chart as 0 — the parse regex
// strips it to "" and Number("") === 0, which would fabricate a real-looking point
// on a chart whose numbers are server-enforced traceable.
const placeholderBlock: GraphyBlock = {
  config: {
    type: "line",
    data: {
      columns: [
        { key: "year", label: "Year" },
        { key: "revenue", label: "Revenue" },
      ],
      rows: [
        { year: "2022", revenue: 27 },
        { year: "2023", revenue: "N/A" },
        { year: "2024", revenue: 130 },
      ],
    },
  },
};

describe("GraphyHero", () => {
  it("renders a line config with 2 series columns and the title text", () => {
    const { container } = render(<GraphyHero block={lineBlock} width={WIDTH} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.textContent).toContain("Revenue vs profit");
  });
  it("renders a column config (bar-family type switch works)", () => {
    const { container } = render(<GraphyHero block={columnBlock} width={WIDTH} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBeGreaterThan(0);
  });
  it("renders nothing for a degenerate config (no numeric series cells)", () => {
    const { container } = render(<GraphyHero block={degenerateBlock} width={WIDTH} />);
    expect(container.textContent).toBe("");
  });
  it("parses formatted string values ($26,974) without crashing", () => {
    const { container } = render(<GraphyHero block={formattedBlock} width={WIDTH} />);
    expect(container.querySelector("svg")).toBeTruthy();
  });
  it("gaps a pure-non-digit placeholder cell (N/A) instead of charting 0", () => {
    const { container } = render(<GraphyHero block={placeholderBlock} width={WIDTH} />);
    expect(container.querySelector("svg")).toBeTruthy();
    // One dot per real numeric point — the N/A row must not contribute a point.
    const dots = container.querySelectorAll(".recharts-line-dots circle");
    expect(dots).toHaveLength(2);
  });
});

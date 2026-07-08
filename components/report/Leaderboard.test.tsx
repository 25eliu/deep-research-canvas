import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import Leaderboard from "./Leaderboard";

const block = {
  kind: "leaderboard" as const, metricLabel: "Market cap",
  rows: [
    { rank: 1, entity: "Nvidia", value: "$3.4T", delta: "+12%",
      detail: { md: "Dominates accelerators.", stats: [{ label: "Revenue", value: "$130B" }] } },
    { rank: 2, entity: "Apple", value: "$3.2T" },
  ],
};

describe("Leaderboard", () => {
  afterEach(cleanup);

  it("renders ranked rows with values", () => {
    render(<Leaderboard block={block} />);
    expect(screen.getByText("Nvidia")).toBeTruthy();
    expect(screen.getByText("$3.4T")).toBeTruthy();
    expect(screen.getByText("Apple")).toBeTruthy();
  });
  it("expands a row with detail on click, revealing prose and stats", () => {
    render(<Leaderboard block={block} />);
    expect(screen.queryByText(/Dominates/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/ }));
    expect(screen.getByText(/Dominates/)).toBeTruthy();
    expect(screen.getByText("$130B")).toBeTruthy();
  });
  it("rows without detail are not buttons", () => {
    render(<Leaderboard block={block} />);
    expect(screen.queryByRole("button", { name: /Apple/ })).toBeNull();
  });
});

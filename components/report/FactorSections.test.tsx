import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import FactorSections from "./FactorSections";

afterEach(cleanup);

const block = {
  kind: "sections" as const,
  sections: [
    { title: "Interest rates", md: "Higher for longer.", figure: { label: "Fed funds", value: "5.5%" } },
    { title: "Supply", md: "Inventory recovered.", chartSpec: { kind: "line" as const, series: [{ label: "s", points: [{ x: "a", y: 1 }, { x: "b", y: 2 }] }] } },
  ],
};

describe("FactorSections", () => {
  it("renders every section expanded by default (factors ARE the answer)", () => {
    render(<FactorSections block={block} />);
    expect(screen.getByText(/Higher for longer/)).toBeTruthy();
    expect(screen.getByText(/Inventory recovered/)).toBeTruthy();
    expect(screen.getByText("5.5%")).toBeTruthy();
  });
  it("collapses a section on header click", () => {
    render(<FactorSections block={block} />);
    fireEvent.click(screen.getByRole("button", { name: /Interest rates/ }));
    expect(screen.queryByText(/Higher for longer/)).toBeNull();
  });
});

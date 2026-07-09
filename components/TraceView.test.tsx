import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import TraceView from "./TraceView";

afterEach(cleanup);

const trace: any = {
  action: "EXPLAIN", provider: "tako", queries: [], cards: [], opsApplied: 0, notes: [], ms: 1200,
  groundedIn: {
    nodes: [{ id: "nvda", title: "Nvidia revenue" }],
    takoAnswerUsed: true,
    cards: [],
    contents: [{ nodeId: "nvda", cardId: "c1", title: "Nvidia revenue", rows: 12 }],
  },
};

describe("TraceView grounded chips", () => {
  it("renders a contents chip and selects its node on click", () => {
    const onSelect = vi.fn();
    render(<TraceView trace={trace} streaming={false} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Trace")); // expand the collapsed trace
    fireEvent.click(screen.getByText("Nvidia revenue · data"));
    expect(onSelect).toHaveBeenCalledWith("nvda");
  });

  it("node chips still select on click", () => {
    const onSelect = vi.fn();
    render(<TraceView trace={trace} streaming={false} onSelectNode={onSelect} />);
    fireEvent.click(screen.getByText("Trace"));
    fireEvent.click(screen.getByText("Nvidia revenue"));
    expect(onSelect).toHaveBeenCalledWith("nvda");
  });

  it("renders the Grounded-in block when only contents is populated", () => {
    // Isolates the `hasGrounded` `|| contents` branch: nodes/cards empty,
    // takoAnswerUsed false — contents alone must still surface the block.
    const contentsOnlyTrace: any = {
      action: "EXPLAIN", provider: "tako", queries: [], cards: [], opsApplied: 0, notes: [], ms: 800,
      groundedIn: {
        nodes: [],
        takoAnswerUsed: false,
        cards: [],
        contents: [{ nodeId: "nvda", cardId: "c1", title: "Nvidia revenue", rows: 12 }],
      },
    };
    render(<TraceView trace={contentsOnlyTrace} streaming={false} />);
    fireEvent.click(screen.getByText("Trace"));
    expect(screen.getByText("Nvidia revenue · data")).toBeTruthy();
  });
});

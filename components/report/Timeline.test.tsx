import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import Timeline from "./Timeline";

afterEach(cleanup);

const block = {
  kind: "timeline" as const,
  events: [
    { date: "2024-03", title: "Blackwell announced", md: "New architecture.", value: "$30B" },
    { date: "2025-01", title: "Volume shipping" },
  ],
};

describe("Timeline", () => {
  it("renders each event with date, title, and optional value/prose", () => {
    render(<Timeline block={block} />);
    expect(screen.getByText("2024-03")).toBeTruthy();
    expect(screen.getByText("Blackwell announced")).toBeTruthy();
    expect(screen.getByText("$30B")).toBeTruthy();
    expect(screen.getByText("Volume shipping")).toBeTruthy();
  });
});

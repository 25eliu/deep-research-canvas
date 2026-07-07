import { describe, it, expect } from "vitest";
import { numericMagnitude } from "./compose";

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

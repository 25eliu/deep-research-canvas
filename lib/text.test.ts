import { describe, it, expect } from "vitest";
import { normalizeText, tokenize, jaccard, titleSignature } from "./text";

describe("normalizeText", () => {
  it("lowercases, strips punctuation, drops grammatical stopwords", () => {
    expect(normalizeText("Compare Nvidia and AMD!")).toBe("nvidia amd");
  });
  it("keeps domain nouns like data, center, revenue", () => {
    expect(normalizeText("data center revenue")).toBe("data center revenue");
  });
});

describe("jaccard", () => {
  it("is 1 for identical token sets", () => {
    expect(jaccard(tokenize("nvidia revenue"), tokenize("revenue nvidia"))).toBe(1);
  });
  it("is a partial overlap for shared tokens", () => {
    // {nvidia,revenue} vs {amd,revenue} → 1/3
    expect(jaccard(tokenize("nvidia revenue"), tokenize("amd revenue"))).toBeCloseTo(1 / 3, 5);
  });
  it("is 0 for disjoint sets", () => {
    expect(jaccard(tokenize("nvidia"), tokenize("intel"))).toBe(0);
  });
  it("is 0 when either set is empty (all-stopword)", () => {
    expect(jaccard(tokenize("the and of"), tokenize("nvidia"))).toBe(0);
  });
});

describe("titleSignature", () => {
  it("is equal for reworded-identical titles", () => {
    expect(titleSignature("Nvidia Total Revenue - Data center (Quarterly)"))
      .toBe(titleSignature("nvidia total revenue data center quarterly"));
  });
  it("differs when the entity tokens differ (combined vs split)", () => {
    const nvidia = titleSignature("Nvidia Total revenue - Data center (Quarterly)");
    const amd = titleSignature("Advanced Micro Devices Total revenue - Data center (Quarterly)");
    const combined = titleSignature("Micro Devices, Nvidia - Total revenue - Data center (Quarterly)");
    expect(nvidia).not.toBe(amd);
    expect(nvidia).not.toBe(combined);
    expect(amd).not.toBe(combined);
  });
});

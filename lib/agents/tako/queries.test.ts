import { describe, it, expect } from "vitest";
import { diversifyQueries } from "./queries";
import { fallbackQueries } from "./strategy";

describe("diversifyQueries", () => {
  it("keeps distinct per-entity queries", () => {
    expect(diversifyQueries(["nvidia data center revenue", "amd data center revenue"]))
      .toEqual(["nvidia data center revenue", "amd data center revenue"]);
  });

  it("drops a reordered paraphrase (jaccard 1.0)", () => {
    const out = diversifyQueries(["nvidia data center revenue", "nvidia revenue data center"]);
    expect(out).toEqual(["nvidia data center revenue"]);
  });

  it("drops a stopword-only paraphrase", () => {
    // "compare nvidia and amd data center revenue" → same token set as the combined query
    const out = diversifyQueries([
      "nvidia amd data center revenue",
      "compare nvidia and amd data center revenue",
    ]);
    expect(out).toEqual(["nvidia amd data center revenue"]);
  });

  it("keeps first, respects max", () => {
    expect(diversifyQueries(["a nvidia", "b amd", "c intel"], { max: 2 }))
      .toEqual(["a nvidia", "b amd"]);
  });

  it("keeps queries below the threshold (partial overlap)", () => {
    // {nvidia,revenue} vs {amd,revenue} → 1/3 < 0.8 → both kept
    expect(diversifyQueries(["nvidia revenue", "amd revenue"]).length).toBe(2);
  });
});

describe("fallbackQueries", () => {
  it("drops a context/target noun that leaked into entities (no 'X contribution to X')", () => {
    // "inflation" is the target, not a subject — it appears inside the metric, so it's dropped.
    const out = fallbackQueries(["gasoline prices", "inflation"], ["contribution to inflation", "price change this year"]);
    expect(out).toContain("gasoline prices contribution to inflation");
    expect(out).toContain("gasoline prices price change this year");
    expect(out.some((q) => q.includes("inflation contribution to inflation"))).toBe(false);
    expect(out.every((q) => q.startsWith("gasoline prices"))).toBe(true);
  });

  it("collapses stuttered words from a mismatched entity/metric pairing", () => {
    const out = fallbackQueries(["U.S. gasoline prices"], ["gasoline price level"]);
    // "gasoline" is not repeated twice in the composed query
    expect(out[0]).toBe("U.S. gasoline prices price level");
  });

  it("covers every subject entity, capped at 3, metric-first ordering", () => {
    const out = fallbackQueries(["Nvidia", "AMD"], ["revenue growth", "gross margin"]);
    expect(out.length).toBe(3);
    expect(out).toContain("Nvidia revenue growth");
    expect(out).toContain("AMD revenue growth"); // both subjects get the primary metric
  });

  it("skips degenerate pairs where metric ⊆ entity", () => {
    const out = fallbackQueries(["gross margin"], ["margin"]);
    expect(out).toEqual([]); // "margin" ⊆ "gross margin" → no query
  });
});

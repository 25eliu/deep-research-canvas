import { describe, it, expect } from "vitest";
import { mapCard } from "./tako";

describe("mapCard", () => {
  it("maps a v3 card shape defensively", () => {
    const c = mapCard({
      card_id: "abc", title: "Nvidia Revenue",
      embed_url: "https://e", webpage_url: "https://w", image_url: "https://i",
      sources: [{ source_name: "SEC" }],
      description: "…last updated on Jan 5, 2026.",
    });
    expect(c.cardId).toBe("abc");
    expect(c.source).toBe("SEC");
    expect(c.embedUrl).toBe("https://e");
    expect(c.asOf).toBe("Jan 5, 2026");
  });

  it("returns undefined cardId when absent (filtered by caller)", () => {
    expect(mapCard({ title: "x" }).cardId).toBeUndefined();
  });
});

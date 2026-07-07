import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mapCard, mapWebResult, relevanceKeeps, takoSearch, takoAnswer, type TakoCallMeta } from "./tako";

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

  it("surfaces Tako's per-card relevance rating", () => {
    expect(mapCard({ card_id: "a", relevance: "Medium" }).relevance).toBe("Medium");
    expect(mapCard({ card_id: "b" }).relevance).toBeUndefined();
  });
});

describe("mapWebResult", () => {
  it("maps a web_results[] entry to a web-kind card (no embedUrl, url as cardId)", () => {
    const w = mapWebResult({
      title: "Gasoline CPI", url: "https://fred.stlouisfed.org/series/X",
      snippet: "Gasoline prices rose 3.2% in June.", source_name: "FRED", publish_date: "2026-06-01",
    });
    expect(w.cardId).toBe("https://fred.stlouisfed.org/series/X");
    expect(w.webpageUrl).toBe("https://fred.stlouisfed.org/series/X");
    expect(w.embedUrl).toBeUndefined(); // → classifyKind() treats it as "web"
    expect(w.source).toBe("FRED");
    expect(w.description).toContain("3.2%");
  });

  it("captures the full page content separately from the snippet", () => {
    const w = mapWebResult({
      title: "T", url: "https://x.com", snippet: "short snippet",
      content: "the full multi-paragraph page content the agent reads", source_name: "X",
    });
    expect(w.description).toBe("short snippet"); // node/summary stays short
    expect(w.content).toBe("the full multi-paragraph page content the agent reads"); // synthesis reads this
  });
});

describe("takoSearch web_results", () => {
  const OLD_KEY = process.env.TAKO_API_KEY;
  beforeEach(() => { process.env.TAKO_API_KEY = "test-key"; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (OLD_KEY === undefined) delete process.env.TAKO_API_KEY;
    else process.env.TAKO_API_KEY = OLD_KEY;
  });
  const okFetch = (body: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as any);

  it("folds web_results into the returned cards when web is requested", async () => {
    vi.stubGlobal("fetch", okFetch({
      cards: [{ card_id: "nvda", title: "NVDA", embed_url: "https://e" }],
      web_results: [{ title: "Reuters piece", url: "https://reuters.com/a", snippet: "…", source_name: "Reuters" }],
    }));
    const cards = await takoSearch("q", { web: true });
    expect(cards.map((c) => c.cardId)).toEqual(["nvda", "https://reuters.com/a"]);
  });

  it("ignores web_results when web is NOT requested", async () => {
    vi.stubGlobal("fetch", okFetch({
      cards: [{ card_id: "nvda", title: "NVDA", embed_url: "https://e" }],
      web_results: [{ title: "Reuters piece", url: "https://reuters.com/a", source_name: "Reuters" }],
    }));
    const cards = await takoSearch("q", { web: false });
    expect(cards.map((c) => c.cardId)).toEqual(["nvda"]);
  });
});

describe("relevanceKeeps", () => {
  it("drops only explicit sub-Medium ratings", () => {
    expect(relevanceKeeps("Low")).toBe(false);
    expect(relevanceKeeps("very low")).toBe(false);
    expect(relevanceKeeps("None")).toBe(false);
  });

  it("keeps Medium+ and missing/unknown ratings (no over-filtering)", () => {
    expect(relevanceKeeps("Medium")).toBe(true);
    expect(relevanceKeeps("High")).toBe(true);
    expect(relevanceKeeps(undefined)).toBe(true);
    expect(relevanceKeeps("")).toBe(true);
    expect(relevanceKeeps("weird")).toBe(true);
  });
});

describe("takoSearch / takoAnswer onCall telemetry", () => {
  const OLD_KEY = process.env.TAKO_API_KEY;
  beforeEach(() => { process.env.TAKO_API_KEY = "test-key"; });
  afterEach(() => {
    vi.restoreAllMocks();
    if (OLD_KEY === undefined) delete process.env.TAKO_API_KEY;
    else process.env.TAKO_API_KEY = OLD_KEY;
  });

  const okFetch = (body: unknown) =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as any);

  it("takoSearch fires onCall with mapped cards + call metadata on success", async () => {
    vi.stubGlobal("fetch", okFetch({ cards: [{ card_id: "nvda", title: "NVDA rev", sources: [{ source_name: "SEC" }] }] }));
    const calls: TakoCallMeta[] = [];
    const cards = await takoSearch("nvidia revenue", { effort: "fast", web: true, count: 3, onCall: (m) => calls.push(m) });

    expect(cards).toHaveLength(1);
    expect(cards[0].cardId).toBe("nvda");
    expect(calls).toHaveLength(1);
    const m = calls[0];
    expect(m.query).toBe("nvidia revenue");
    expect(m.endpoint).toBe("/v3/search");
    expect(m.effort).toBe("fast");
    expect(m.web).toBe(true);
    expect(m.ms).toBeGreaterThanOrEqual(0);
    expect(m.cards.map((c) => c.cardId)).toEqual(["nvda"]); // query → cards linkage
    expect(m.error).toBeUndefined();
  });

  it("takoSearch fires onCall with error set AND rethrows on failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "boom" }) as any));
    const calls: TakoCallMeta[] = [];
    await expect(takoSearch("q", { onCall: (m) => calls.push(m) })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].cards).toEqual([]);
    expect(calls[0].error).toBeTruthy();
    expect(calls[0].endpoint).toBe("/v3/search");
  });

  it("takoSearch drops Low-relevance cards, keeps Medium+/unknown", async () => {
    vi.stubGlobal("fetch", okFetch({
      cards: [
        { card_id: "m", title: "Medium", relevance: "Medium" },
        { card_id: "lo", title: "Low", relevance: "Low" },
        { card_id: "hi", title: "High", relevance: "High" },
        { card_id: "u", title: "Unknown" }, // no relevance → kept
      ],
    }));
    const cards = await takoSearch("q");
    expect(cards.map((c) => c.cardId)).toEqual(["m", "hi", "u"]);
  });

  it("takoAnswer fires onCall with endpoint /v1/answer", async () => {
    vi.stubGlobal("fetch", okFetch({ answer: "grounded prose", cards: [{ card_id: "amd", title: "AMD" }] }));
    const calls: TakoCallMeta[] = [];
    const res = await takoAnswer("compare amd", { onCall: (m) => calls.push(m) });

    expect(res.answer).toBe("grounded prose");
    expect(calls).toHaveLength(1);
    expect(calls[0].endpoint).toBe("/v1/answer");
    expect(calls[0].web).toBe(false);
    expect(calls[0].cards.map((c) => c.cardId)).toEqual(["amd"]);
  });
});

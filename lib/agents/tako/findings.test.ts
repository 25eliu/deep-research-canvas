import { describe, it, expect } from "vitest";
import { classifyKind, FindingLedger } from "./findings";
import type { TakoCard } from "../../tako";

const card = (over: Partial<TakoCard> = {}): TakoCard => ({
  cardId: "c1", title: "NVDA revenue", description: "desc", embedUrl: "https://e/1",
  webpageUrl: "https://w/1", source: "Tako", ...over,
});

describe("classifyKind", () => {
  it("is data_card when the card has a chart embed", () => {
    expect(classifyKind(card({ embedUrl: "https://e/1" }))).toBe("data_card");
  });
  it("is web when there is no embed (a web-grounded fact)", () => {
    expect(classifyKind(card({ embedUrl: undefined }))).toBe("web");
  });
});

describe("FindingLedger", () => {
  it("assigns 1-based citation indices in insertion order", () => {
    const l = new FindingLedger();
    const a = l.add(card({ cardId: "a", title: "A rev", embedUrl: "https://e/a" }));
    const b = l.add(card({ cardId: "b", title: "B rev", embedUrl: "https://e/b" }));
    expect(a?.index).toBe(1);
    expect(b?.index).toBe(2);
    expect(l.size).toBe(2);
  });

  it("dedups by cardId — a repeat returns null and does not grow", () => {
    const l = new FindingLedger();
    expect(l.add(card({ cardId: "a" }))).not.toBeNull();
    expect(l.add(card({ cardId: "a" }))).toBeNull();
    expect(l.size).toBe(1);
  });

  it("dedups by embed URL even when cardIds differ (re-published chart)", () => {
    const l = new FindingLedger();
    expect(l.add(card({ cardId: "a", title: "T1", embedUrl: "https://e/x" }))).not.toBeNull();
    expect(l.add(card({ cardId: "b", title: "T2", embedUrl: "https://e/x" }))).toBeNull();
    expect(l.size).toBe(1);
  });

  it("merges same-title + same-source cards even when cardId/embed differ (Tako re-mints ids per search)", () => {
    const l = new FindingLedger();
    // The real duplicate pattern (verified on staging): three near-synonym queries
    // ("Nvidia revenue", "Nvidia total revenue", "Nvidia revenue growth") each return
    // the SAME series — "NVIDIA … Total Revenues (Annual)" / Fiscal.ai — under a fresh
    // cardId + embedUrl. They must collapse to ONE knowledge card.
    expect(l.add(card({ cardId: "a", title: "NVIDIA Corporation Total Revenues (Normalized) (Annual)", source: "Fiscal.ai", embedUrl: "https://e/a" }))).not.toBeNull();
    expect(l.add(card({ cardId: "b", title: "NVIDIA Corporation Total Revenues (Normalized) (Annual)", source: "Fiscal.ai", embedUrl: "https://e/b" }))).toBeNull();
    // punctuation/case-only difference still collapses (title signature is normalized)
    expect(l.add(card({ cardId: "c", title: "nvidia corporation total revenues normalized annual", source: "Fiscal.ai", embedUrl: "https://e/c" }))).toBeNull();
    expect(l.size).toBe(1);
  });

  it("keeps same-title cards from DIFFERENT sources (two providers of one series)", () => {
    const l = new FindingLedger();
    expect(l.add(card({ cardId: "a", title: "Nvidia Total Revenue", source: "Fiscal.ai", embedUrl: "https://e/a" }))).not.toBeNull();
    expect(l.add(card({ cardId: "b", title: "Nvidia Total Revenue", source: "S&P Global", embedUrl: "https://e/b" }))).not.toBeNull();
    expect(l.size).toBe(2);
  });

  it("does NOT merge the combined-vs-split comparison trio (distinct titles, same source)", () => {
    const l = new FindingLedger();
    // Different entity/scope tokens in the title → distinct signatures → all kept,
    // even though the source is identical.
    l.add(card({ cardId: "1", title: "Nvidia Total revenue - Data center (Quarterly)", source: "S&P Global", embedUrl: "https://e/1" }));
    l.add(card({ cardId: "2", title: "Advanced Micro Devices Total revenue - Data center (Quarterly)", source: "S&P Global", embedUrl: "https://e/2" }));
    l.add(card({ cardId: "3", title: "Micro Devices, Nvidia - Total revenue - Data center (Quarterly)", source: "S&P Global", embedUrl: "https://e/3" }));
    expect(l.size).toBe(3);
  });

  it("keeps quarterly vs annual apart — Tako titles encode the timeframe", () => {
    const l = new FindingLedger();
    expect(l.add(card({ cardId: "a", title: "NVIDIA Corporation Total Revenues (Quarterly)", source: "Fiscal.ai", embedUrl: "https://e/a" }))).not.toBeNull();
    expect(l.add(card({ cardId: "b", title: "NVIDIA Corporation Total Revenues (Annual)", source: "Fiscal.ai", embedUrl: "https://e/b" }))).not.toBeNull();
    expect(l.size).toBe(2);
  });

  it("a differing webpageUrl neither causes nor prevents a merge", () => {
    const l = new FindingLedger();
    // same cardId, different webpageUrl → still deduped (webpageUrl not a key)
    expect(l.add(card({ cardId: "a", webpageUrl: "https://w/1" }))).not.toBeNull();
    expect(l.add(card({ cardId: "a", webpageUrl: "https://w/2" }))).toBeNull();
    expect(l.size).toBe(1);
  });

  it("builds a data_card node grounded 'tako' with the chart embed", () => {
    const l = new FindingLedger();
    const f = l.add(card({ cardId: "a", embedUrl: "https://e/a" }))!;
    const node = l.toNode(f);
    expect(node.type).toBe("data_card");
    expect(node.grounding).toBe("tako");
    expect(node.tako?.embedUrl).toBe("https://e/a");
    expect(node.id).toBe(f.nodeId);
  });

  it("builds a clickable 'source' node grounded 'web' for a web fact", () => {
    const l = new FindingLedger();
    const f = l.add(card({ cardId: "a", embedUrl: undefined, webpageUrl: "https://w/a" }))!;
    const node = l.toNode(f);
    expect(node.type).toBe("text");
    expect(node.role).toBe("source");
    expect(node.grounding).toBe("web");
    expect(node.tako?.webpageUrl).toBe("https://w/a");
    expect(node.sources?.[0]?.url).toBe("https://w/a"); // clickable link carried on `sources`
  });

  it("tags the node with its owning section", () => {
    const l = new FindingLedger();
    const f = l.add(card({ cardId: "a" }), "Nvidia")!;
    expect(l.toNode(f).section).toBe("Nvidia");
  });

  it("validNodeIds returns exactly the minted node ids (provenance set)", () => {
    const l = new FindingLedger();
    const a = l.add(card({ cardId: "a", title: "A rev", embedUrl: "https://e/a" }))!;
    const b = l.add(card({ cardId: "b", title: "B rev", embedUrl: "https://e/b" }))!;
    expect(l.validNodeIds()).toEqual(new Set([a.nodeId, b.nodeId]));
  });
});

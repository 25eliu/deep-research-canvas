import { describe, it, expect } from "vitest";
import { sanitizeOps } from "./sanitize";

const takoNode = (over: any = {}) => ({
  op: "add_node",
  node: { id: "c1", type: "data_card", title: "Rev", grounding: "tako", confidence: 0.9,
    tako: { cardId: "REAL" }, ...over },
});

describe("sanitizeOps", () => {
  it("strips any tako ref from baseline providers and forces grounding=model", () => {
    const out = sanitizeOps([takoNode()], { allowTako: false });
    const n = (out[0] as any).node;
    expect(n.tako).toBeUndefined();
    expect(n.grounding).toBe("model");
  });

  it("drops a hallucinated cardId not fetched this turn and downgrades", () => {
    const out = sanitizeOps([takoNode({ tako: { cardId: "FAKE" } })],
      { allowTako: true, validCardIds: new Set(["REAL"]) });
    const n = (out[0] as any).node;
    expect(n.tako).toBeUndefined();
    expect(n.grounding).toBe("model");
    expect(n.confidence).toBeLessThanOrEqual(0.4);
  });

  it("keeps a real fetched cardId", () => {
    const out = sanitizeOps([takoNode({ tako: { cardId: "REAL" } })],
      { allowTako: true, validCardIds: new Set(["REAL"]) });
    const n = (out[0] as any).node;
    expect(n.tako?.cardId).toBe("REAL");
    expect(n.grounding).toBe("tako");
  });

  it("returns [] for non-array input and skips malformed ops", () => {
    expect(sanitizeOps("nope" as any, { allowTako: false })).toEqual([]);
    expect(sanitizeOps([{ nope: true }], { allowTako: false })).toEqual([]);
  });

  it("backfills confidence and forces position:null", () => {
    const out = sanitizeOps([{ op: "add_node", node: { id: "x", type: "data_card",
      title: "T", grounding: "model" } }], { allowTako: false });
    const n = (out[0] as any).node;
    expect(n.confidence).toBe(0.5);
    expect(n.position).toBeNull();
  });
});

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

  it("strips tako ref from a baseline update_node patch and forces grounding=model", () => {
    const out = sanitizeOps(
      [{ op: "update_node", id: "c1", patch: { tako: { cardId: "REAL" }, grounding: "tako" } }],
      { allowTako: false },
    );
    const patch = (out[0] as any).patch;
    expect(patch.tako).toBeUndefined();
    expect(patch.grounding).toBe("model");
  });

  it("drops a hallucinated cardId in an update_node patch and downgrades", () => {
    const out = sanitizeOps(
      [{ op: "update_node", id: "c1", patch: { tako: { cardId: "FAKE" }, grounding: "tako", confidence: 0.9 } }],
      { allowTako: true, validCardIds: new Set(["REAL"]) },
    );
    const patch = (out[0] as any).patch;
    expect(patch.tako).toBeUndefined();
    expect(patch.grounding).toBe("model");
    expect(patch.confidence).toBeLessThanOrEqual(0.4);
  });

  it("keeps a real fetched cardId in an update_node patch", () => {
    const out = sanitizeOps(
      [{ op: "update_node", id: "c1", patch: { tako: { cardId: "REAL" }, grounding: "tako" } }],
      { allowTako: true, validCardIds: new Set(["REAL"]) },
    );
    const patch = (out[0] as any).patch;
    expect(patch.tako?.cardId).toBe("REAL");
    expect(patch.grounding).toBe("tako");
  });

  it("passes update_node patches with no tako/grounding/confidence through unchanged", () => {
    const out = sanitizeOps(
      [{ op: "update_node", id: "c1", patch: { title: "New title" } }],
      { allowTako: false },
    );
    const patch = (out[0] as any).patch;
    expect(patch).toEqual({ title: "New title" });
  });
});

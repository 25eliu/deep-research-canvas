import { describe, it, expect } from "vitest";
import { FindingLedger } from "./findings";
import { newResearchCtx, synthNode, SYNTH_ID } from "./flow";

const req: any = {
  canvasId: "c", message: "research the chip makers", surface: "main",
  canvasState: { nodes: [], edges: [] }, providerId: "tako", takoAnswerEnabled: true, history: [],
};

describe("research root-id parameterization", () => {
  it("synthNode uses the id it is given", () => {
    expect(synthNode(SYNTH_ID, "H", "S").id).toBe("synth");
    expect(synthNode("synth_chips", "H", "S").id).toBe("synth_chips");
    expect(synthNode("synth_chips", "H", "S").role).toBe("synthesis");
  });

  it("newResearchCtx defaults rootId to SYNTH_ID and seeds usedIds with it", () => {
    const ctx = newResearchCtx(req, new FindingLedger(), () => {});
    expect(ctx.rootId).toBe("synth");
    expect(ctx.usedIds.has("synth")).toBe(true);
  });

  it("newResearchCtx honors an override rootId", () => {
    const ctx = newResearchCtx(req, new FindingLedger(), () => {}, undefined, undefined, { rootId: "synth_chips" });
    expect(ctx.rootId).toBe("synth_chips");
    expect(ctx.usedIds.has("synth_chips")).toBe(true);
    expect(ctx.usedIds.has("synth")).toBe(false);
  });
});

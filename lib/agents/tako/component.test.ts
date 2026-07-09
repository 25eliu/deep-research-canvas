import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRequest, CanvasNode } from "../../schema";

const h = vi.hoisted(() => ({
  mockResearchLeaf: vi.fn(),
  mockRunAnswerLane: vi.fn(),
  mockGenerateStructured: vi.fn(),
}));

vi.mock("../../llm", () => ({
  generateStructured: h.mockGenerateStructured,
  streamAnswer: vi.fn(),
}));

// Only researchLeaf is mocked — newResearchCtx/uniqueResearchId/derivedEdge (and
// FindingLedger, via ./findings) run for REAL, so this test exercises the actual
// id/edge shapes runComponentLane depends on instead of a stand-in that can drift
// from the real signatures.
vi.mock("./flow", async (orig) => {
  const real: any = await orig();
  return { ...real, researchLeaf: (...a: any[]) => h.mockResearchLeaf(...a) };
});

vi.mock("./chat", () => ({
  runAnswerLane: h.mockRunAnswerLane,
}));

vi.mock("./strategy", () => ({
  graphStrategy: {},
}));

import { runComponentLane } from "./component";

const boardNode: CanvasNode = { id: "nvda", type: "data_card", title: "Nvidia revenue", grounding: "tako", confidence: 0.9 };
const synthNode: CanvasNode = { id: "synth", type: "text", role: "synthesis", title: "Answer", grounding: "tako", confidence: 0.9 };

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    canvasId: "c", message: "add a chart of AMD's data-center revenue", surface: "main",
    canvasState: { nodes: [boardNode, synthNode], edges: [] },
    selection: { nodeIds: ["nvda"], nodes: [boardNode] },
    providerId: "tako", takoAnswerEnabled: true, history: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Setup generateStructured mock
  h.mockGenerateStructured.mockResolvedValue({
    question: "AMD data-center revenue", rationale: "user asked",
    entities: ["Advanced Micro Devices", "AMD"], subtype: "Companies", metricFilters: ["revenue"],
  });

  // Setup researchLeaf mock
  h.mockResearchLeaf.mockResolvedValue({
    nodeId: "rq_amd_datacenter_revenue", title: "AMD data-center revenue", synthesis: "AMD grew.", findingCount: 2,
    children: [], depth: 1, kind: "leaf" as const,
  });

  // Setup runAnswerLane mock
  h.mockRunAnswerLane.mockResolvedValue({
    nodeOps: [], narration: "", sideReply: "degraded answer", validCardIds: new Set(), allowedNodeIds: new Set(),
    trace: { notes: [] },
  });
});

describe("runComponentLane", () => {
  it("distills a plan and runs researchLeaf with the lookup", async () => {
    await runComponentLane(req(), "GENERATE", "", () => {});
    expect(h.mockResearchLeaf).toHaveBeenCalledTimes(1);
    const call = h.mockResearchLeaf.mock.calls[0];
    const [question, depth, nodeId, root, , lookup] = call;
    expect(question).toBe("AMD data-center revenue");
    expect(depth).toBe(1);
    expect(root).toBe(false);
    expect(String(nodeId)).toMatch(/^rq_/);
    expect(lookup).toEqual({ entities: ["Advanced Micro Devices", "AMD"], subtype: "Companies", metricFilters: ["revenue"] });
  });

  it("anchors the new node to the selection with a derived_from edge", async () => {
    const result = await runComponentLane(req(), "GENERATE", "", () => {});
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges).toContainEqual(expect.objectContaining({ to: "nvda", kind: "derived_from" }));
  });

  it("falls back to the synthesis node as anchor when nothing is selected", async () => {
    const result = await runComponentLane(req({ selection: undefined }), "AUGMENT", "", () => {});
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges).toContainEqual(expect.objectContaining({ to: "synth", kind: "derived_from" }));
  });

  it("narration carries the leaf synthesis; side_chat routes it to sideReply", async () => {
    const main = await runComponentLane(req(), "GENERATE", "", () => {});
    expect(main.narration).toContain("AMD grew.");
    expect(main.sideReply).toBeNull();

    const side = await runComponentLane(req({ surface: "side_chat" }), "GENERATE", "", () => {});
    expect(side.sideReply).toContain("AMD grew.");
  });

  it("degrades to the answer lane when the leaf finds nothing", async () => {
    h.mockResearchLeaf.mockResolvedValueOnce({ nodeId: null, title: "q", synthesis: "", findingCount: 0, children: [], depth: 1, kind: "leaf" });

    const result = await runComponentLane(req(), "GENERATE", "HIST", () => {});
    expect(h.mockRunAnswerLane).toHaveBeenCalledTimes(1);
    expect(result.sideReply).toBe("degraded answer");
    expect(result.trace.notes?.some((n: string) => n.includes("no data found"))).toBe(true);
  });

  it("retries the distill once with a schema reminder, then degrades if both fail", async () => {
    h.mockGenerateStructured
      .mockRejectedValueOnce(new Error("invalid"))
      .mockRejectedValueOnce(new Error("invalid again"));

    const result = await runComponentLane(req(), "GENERATE", "", () => {});
    expect(h.mockGenerateStructured).toHaveBeenCalledTimes(2);
    expect(h.mockGenerateStructured.mock.calls[1][0].prompt).toContain("SCHEMA_REMINDER");
    expect(h.mockRunAnswerLane).toHaveBeenCalledTimes(1);
    expect(result.sideReply).toBe("degraded answer");
  });
});

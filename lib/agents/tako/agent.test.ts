import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentRequest } from "../../schema";

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async () => ({ action: "EXPLAIN", reason: "r" })),
}));
vi.mock("../shared/memory", () => ({
  foldHistory: vi.fn(async () => ({ historyText: "HIST", windowTurns: [], summary: "NEWSUM", summarizedThrough: "m3" })),
  summarizeTurns: vi.fn(),
}));
vi.mock("./strategy", () => ({ graphStrategy: {} }));

const emptyResult = () => ({
  nodeOps: [], narration: "", sideReply: "ok", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { groundedIn: { nodes: [{ id: "nvda", title: "N" }], takoAnswerUsed: false, cards: [] } },
});
const runAnswerLane = vi.fn(async (..._args: unknown[]) => emptyResult());
vi.mock("./chat", () => ({ runAnswerLane: (...a: any[]) => runAnswerLane(...a) }));
const runComponentLane = vi.fn(async (..._args: unknown[]) => ({ ...emptyResult(), trace: {} }));
vi.mock("./component", () => ({ runComponentLane: (...a: any[]) => runComponentLane(...a) }));
const runTakoInitial = vi.fn(async (..._args: unknown[]) => ({ ...emptyResult(), sideReply: null, trace: {} }));
vi.mock("./pipeline", () => ({ runTakoInitial: (...a: any[]) => runTakoInitial(...a) }));

import { runTako } from "./agent";
import { generateStructured } from "../../llm";
import { foldHistory } from "../shared/memory";

const req: AgentRequest = {
  canvasId: "c", message: "tell me more", surface: "side_chat",
  canvasState: { nodes: [{ id: "nvda", type: "data_card", title: "N", grounding: "tako", confidence: 0.9 }], edges: [] },
  selection: { nodeIds: ["nvda"], nodes: [] },
  providerId: "tako", takoAnswerEnabled: true,
  history: [{ id: "m1", role: "user", text: "how did Nvidia do", surface: "main" }],
  historySummary: "PRIOR",
};

beforeEach(() => vi.clearAllMocks());

describe("runTako lane dispatch", () => {
  it("EXPLAIN dispatches the answer lane with historyText and folds memory", async () => {
    const res = await runTako(req);
    expect(foldHistory).toHaveBeenCalledTimes(1);
    expect(runAnswerLane).toHaveBeenCalledTimes(1);
    expect(runAnswerLane.mock.calls[0][1]).toBe("HIST");
    expect(res.memory).toEqual({ summary: "NEWSUM", summarizedThrough: "m3" });
    expect(res.trace?.groundedIn?.nodes[0].id).toBe("nvda");
    expect(res.trace?.action).toBe("EXPLAIN");
  });

  it("GENERATE dispatches the research lane with its action", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "GENERATE", reason: "chart" } as any);
    await runTako(req);
    expect(runComponentLane).toHaveBeenCalledTimes(1);
    expect(runComponentLane.mock.calls[0][1]).toBe("GENERATE");
    expect(runAnswerLane).not.toHaveBeenCalled();
  });

  it("AUGMENT dispatches the research lane", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "AUGMENT", reason: "more data" } as any);
    await runTako(req);
    expect(runComponentLane.mock.calls[0][1]).toBe("AUGMENT");
  });

  it("REPLACE dispatches the initial pipeline", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "REPLACE", reason: "new topic" } as any);
    await runTako(req);
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
  });

  it("empty board runs the initial pipeline WITHOUT a router call", async () => {
    const res = await runTako({ ...req, canvasState: { nodes: [], edges: [] }, selection: undefined });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
    expect(res.trace?.action).toBe("REPLACE");
  });

  it("router hard-failure defaults to the answer lane", async () => {
    vi.mocked(generateStructured).mockRejectedValueOnce(new Error("llm down"));
    const res = await runTako(req);
    expect(runAnswerLane).toHaveBeenCalledTimes(1);
    expect(res.trace?.action).toBe("EXPLAIN");
  });
});

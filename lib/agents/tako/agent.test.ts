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
const runTakoFollowup = vi.fn(async (..._args: unknown[]) => emptyResult());
vi.mock("./followup", () => ({ runTakoFollowup: (...a: any[]) => runTakoFollowup(...a) }));
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

describe("runTako routing", () => {
  it("folds history and threads action + historyText into the follow-up", async () => {
    const res = await runTako(req);
    expect(foldHistory).toHaveBeenCalledTimes(1);
    const [, actionArg, historyArg] = runTakoFollowup.mock.calls[0];
    expect(actionArg).toBe("EXPLAIN");
    expect(historyArg).toBe("HIST");
    expect(res.memory).toEqual({ summary: "NEWSUM", summarizedThrough: "m3" });
    expect(res.trace?.groundedIn?.nodes[0].id).toBe("nvda");
  });

  it("empty board runs the initial pipeline WITHOUT a router call", async () => {
    const res = await runTako({ ...req, canvasState: { nodes: [], edges: [] }, selection: undefined });
    expect(generateStructured).not.toHaveBeenCalled();
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
    expect(res.trace?.action).toBe("REPLACE");
  });

  it("REPLACE on a non-empty board runs the initial pipeline", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "REPLACE", reason: "new topic" } as any);
    await runTako(req);
    expect(runTakoInitial).toHaveBeenCalledTimes(1);
    expect(runTakoFollowup).not.toHaveBeenCalled();
  });

  it("router hard-failure defaults to EXPLAIN instead of killing the turn", async () => {
    vi.mocked(generateStructured).mockRejectedValueOnce(new Error("llm down"));
    const res = await runTako(req);
    expect(runTakoFollowup.mock.calls[0][1]).toBe("EXPLAIN");
    expect(res.trace?.action).toBe("EXPLAIN");
  });

  it("GENERATE flows to the follow-up as AUGMENT until the research lane lands", async () => {
    vi.mocked(generateStructured).mockResolvedValueOnce({ action: "GENERATE", reason: "make a chart" } as any);
    await runTako(req);
    expect(runTakoFollowup.mock.calls[0][1]).toBe("AUGMENT");
  });
});

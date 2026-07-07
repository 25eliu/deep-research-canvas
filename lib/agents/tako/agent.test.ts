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
const runTakoFollowup = vi.fn(async (..._args: unknown[]) => ({
  nodeOps: [], narration: "", sideReply: "ok", validCardIds: new Set(), allowedNodeIds: new Set(),
  trace: { groundedIn: { nodes: [{ id: "nvda", title: "N" }], takoAnswerUsed: false, cards: [] } },
}));
vi.mock("./followup", () => ({ runTakoFollowup: (...a: any[]) => runTakoFollowup(...a) }));
vi.mock("./pipeline", () => ({ runTakoInitial: vi.fn() }));

import { runTako } from "./agent";
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

describe("runTako", () => {
  it("folds history and threads action + historyText into the follow-up", async () => {
    const res = await runTako(req);
    expect(foldHistory).toHaveBeenCalledTimes(1);
    const [, actionArg, historyArg] = runTakoFollowup.mock.calls[0];
    expect(actionArg).toBe("EXPLAIN");
    expect(historyArg).toBe("HIST");
    expect(res.memory).toEqual({ summary: "NEWSUM", summarizedThrough: "m3" });
    expect(res.trace?.groundedIn?.nodes[0].id).toBe("nvda");
  });
});

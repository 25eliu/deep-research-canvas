import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";
import type { AgentRequest } from "../../schema";

vi.mock("../../tako", () => ({
  takoAnswer: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "amd", title: "AMD rev", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "Tako" }];
    opts.onCall?.({ query: q, endpoint: "/v1/answer", effort: opts.effort ?? "fast", web: false, ms: 2, cards });
    return { answer: "AMD grew revenue.", cards };
  }),
}));

vi.mock("../../llm", () => ({
  streamAnswer: vi.fn(async (opts: any) => {
    opts.onToken("answer");
    return "answer";
  }),
}));

import { runTakoFollowup } from "./followup";
import { takoAnswer } from "../../tako";

const boardNode = { id: "nvda", type: "data_card" as const, title: "Nvidia revenue", summary: "grew 88%", grounding: "tako" as const, confidence: 0.9 };

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    canvasId: "c", message: "explain this", surface: "side_chat",
    canvasState: { nodes: [boardNode], edges: [] },
    selection: { nodeIds: ["nvda"], nodes: [boardNode] },
    providerId: "tako", takoAnswerEnabled: true, history: [],
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("runTakoFollowup — board-first", () => {
  it("EXPLAIN with board content answers WITHOUT calling Tako", async () => {
    const result = await runTakoFollowup(req(), "EXPLAIN", "", () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
    expect(result.trace.groundedIn?.nodes.map((n) => n.id)).toEqual(["nvda"]);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(false);
    expect(result.sideReply).toBe("answer");
  });

  it("AUGMENT calls Tako for new data even with board content", async () => {
    const result = await runTakoFollowup(req({ surface: "main" }), "AUGMENT", "", () => {});
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(true);
  });

  it("EXPLAIN on an empty board falls back to Tako", async () => {
    const result = await runTakoFollowup(
      req({ canvasState: { nodes: [], edges: [] }, selection: undefined }),
      "EXPLAIN", "", () => {},
    );
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(true);
  });

  it("never calls Tako when takoAnswerEnabled is false", async () => {
    await runTakoFollowup(req({ takoAnswerEnabled: false }), "AUGMENT", "", () => {});
    expect(takoAnswer).not.toHaveBeenCalled();
  });

  it("emits tako_call events and records calls when Tako is used", async () => {
    const events: AgentEvent[] = [];
    const result = await runTakoFollowup(req({ surface: "main" }), "AUGMENT", "", (e) => events.push(e));
    expect((events.filter((e) => e.type === "tako_call") as any[]).length).toBe(1);
    expect(result.trace.calls?.[0].endpoint).toBe("/v1/answer");
  });

  // Regression: this lane's calls/synthesis key on nodeId "followup", which has no
  // research-tree entry — without a reasoning step (live) and a trace.reasoning entry
  // (finalized) the trace rendered the step as "(unnamed step)".
  it("names the followup step with the question, live and in the finalized trace", async () => {
    const events: AgentEvent[] = [];
    const result = await runTakoFollowup(req({ surface: "main", message: "how about AMD?" }), "AUGMENT", "", (e) => events.push(e));
    const reasoning = events.find((e) => e.type === "reasoning") as Extract<AgentEvent, { type: "reasoning" }>;
    expect(reasoning?.nodeId).toBe("followup");
    expect(reasoning?.question).toBe("how about AMD?");
    expect(events.indexOf(reasoning)).toBeLessThan(events.findIndex((e) => e.type === "tako_call"));
    expect(result.trace.reasoning).toEqual([{ nodeId: "followup", question: "how about AMD?", rationale: "" }]);
  });

  // Regression: follow-up cards were added with NO feeds edge — on a board with a
  // research tree, treeLayout only positions data cards via feeds edges, so new
  // follow-up cards stacked invisibly at (0,0). Every new card must anchor to the
  // selection-first retrieved node (else the board's synth node).
  it("AUGMENT anchors each new card to the retrieved node with a feeds edge", async () => {
    const result = await runTakoFollowup(req({ surface: "main" }), "AUGMENT", "", () => {});
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    expect(added).toHaveLength(1);
    const cardId = added[0].node.id;
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges).toContainEqual(expect.objectContaining({ from: cardId, to: "nvda", kind: "feeds" }));
  });

  it("falls back to the board's synth node as the anchor when nothing was retrieved", async () => {
    const synthNode = { id: "synth", type: "text" as const, role: "synthesis" as const, title: "Answer", grounding: "tako" as const, confidence: 0.9 };
    const result = await runTakoFollowup(
      req({ surface: "main", canvasState: { nodes: [synthNode], edges: [] }, selection: undefined, message: "zzz nothing matches" }),
      "AUGMENT", "", () => {},
    );
    const added = result.nodeOps.filter((o: any) => o.op === "add_node") as any[];
    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    if (added.length) {
      expect(edges).toContainEqual(expect.objectContaining({ from: added[0].node.id, to: "synth", kind: "feeds" }));
    }
  });
});

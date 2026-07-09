import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";
import type { AgentRequest, CanvasNode } from "../../schema";

// generateWithTools mock: simulates the model calling each provided tool once,
// then returning an analyst note. Tests override `script` to drive other flows.
let script: ((tools: any) => Promise<void>) | null = null;
vi.mock("../../llm", () => ({
  generateWithTools: vi.fn(async (opts: any) => {
    if (script) await script(opts.tools);
    else {
      if (opts.tools.get_node_contents) await opts.tools.get_node_contents.execute({ nodeId: "nvda" });
      if (opts.tools.tako_answer) await opts.tools.tako_answer.execute({ query: "amd revenue" });
    }
    return { text: "note", steps: 2 };
  }),
  streamAnswer: vi.fn(async (opts: any) => {
    opts.onToken("answer");
    return "answer";
  }),
}));

vi.mock("../../tako", () => ({
  takoContents: vi.fn(async () => ({ csv: "Timestamp,Revenue\n2023,61\n2024,130", totalRows: 2 })),
  takoAnswer: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "amd", title: "AMD rev", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "Tako" }];
    opts.onCall?.({ query: q, endpoint: "/v1/answer", effort: "fast", web: false, ms: 2, cards });
    return { answer: "AMD grew revenue.", cards };
  }),
}));

vi.mock("./followup", () => {
  const mockFollowup = vi.fn(async () => ({
    nodeOps: [], narration: "", sideReply: "legacy", validCardIds: new Set(), allowedNodeIds: new Set(),
    trace: { notes: ["legacy path"] },
  }));
  return { runTakoFollowup: mockFollowup };
});

import { runAnswerLane } from "./chat";
import { generateWithTools } from "../../llm";
import { takoContents, takoAnswer } from "../../tako";
import { runTakoFollowup } from "./followup";

const cardNode: CanvasNode = {
  id: "nvda", type: "data_card", title: "Nvidia revenue", grounding: "tako", confidence: 0.9,
  tako: { cardId: "c-nvda", webpageUrl: "https://t/nvda" },
};

function req(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    canvasId: "c", message: "when did it peak?", surface: "side_chat",
    canvasState: { nodes: [cardNode], edges: [] },
    selection: { nodeIds: ["nvda"], nodes: [cardNode] },
    providerId: "tako", takoAnswerEnabled: true, history: [],
    ...over,
  };
}

beforeEach(() => { vi.clearAllMocks(); script = null; });

describe("runAnswerLane — gather loop", () => {
  it("fetches node contents and records groundedIn.contents with rows", async () => {
    const result = await runAnswerLane(req(), "", () => {});
    expect(takoContents).toHaveBeenCalledWith("https://t/nvda", { mode: "inline" });
    expect(result.trace.groundedIn?.contents).toEqual([
      { nodeId: "nvda", cardId: "c-nvda", title: "Nvidia revenue", rows: 2 },
    ]);
    expect(result.sideReply).toBe("answer"); // side_chat → sideReply
    expect(result.nodeOps).toEqual([]); // the answer lane never mints nodes
  });

  it("records tako answer usage in trace + groundedIn", async () => {
    const result = await runAnswerLane(req(), "", () => {});
    expect(takoAnswer).toHaveBeenCalledTimes(1);
    expect(result.trace.answerUsed).toBe(true);
    expect(result.trace.groundedIn?.takoAnswerUsed).toBe(true);
    expect(result.trace.queries).toEqual(["amd revenue"]);
  });

  it("omits the tako_answer tool entirely when takoAnswerEnabled is false", async () => {
    await runAnswerLane(req({ takoAnswerEnabled: false }), "", () => {});
    const tools = vi.mocked(generateWithTools).mock.calls[0][0].tools;
    expect(tools.tako_answer).toBeUndefined();
    expect(tools.get_node_contents).toBeDefined();
    expect(takoAnswer).not.toHaveBeenCalled();
  });

  it("emits a tako_call event per real fetch", async () => {
    const events: AgentEvent[] = [];
    await runAnswerLane(req(), "", (e) => events.push(e));
    const calls = events.filter((e) => e.type === "tako_call") as any[];
    expect(calls.map((c) => c.call.endpoint).sort()).toEqual(["/v1/answer", "/v1/contents"]);
  });

  it("caches repeat fetches and enforces the contents budget", async () => {
    const many = Array.from({ length: 10 }, (_, i): CanvasNode => ({
      id: `n${i}`, type: "data_card", title: `N${i}`, grounding: "tako", confidence: 0.9,
      tako: { cardId: `c${i}`, webpageUrl: `https://t/${i}` },
    }));
    script = async (tools) => {
      await tools.get_node_contents.execute({ nodeId: "n0" });
      await tools.get_node_contents.execute({ nodeId: "n0" }); // cache hit — no second fetch
      for (let i = 1; i < 10; i++) await tools.get_node_contents.execute({ nodeId: `n${i}` });
    };
    await runAnswerLane(req({ canvasState: { nodes: many, edges: [] }, selection: undefined }), "", () => {});
    expect(takoContents).toHaveBeenCalledTimes(8); // budget of 8 real fetches
  });

  it("returns tool-result strings for unknown nodes and fetch errors (loop survives)", async () => {
    let unknownMsg = "", errMsg = "";
    vi.mocked(takoContents).mockRejectedValueOnce(new Error("boom"));
    script = async (tools) => {
      unknownMsg = await tools.get_node_contents.execute({ nodeId: "nope" });
      errMsg = await tools.get_node_contents.execute({ nodeId: "nvda" });
    };
    const result = await runAnswerLane(req(), "", () => {});
    expect(unknownMsg).toContain("unknown nodeId");
    expect(errMsg).toContain("contents unavailable");
    expect(result.sideReply).toBe("answer"); // turn still answered
  });

  it("excerpts web-source page text from the LEAD (not CSV tail truncation) and records rows 0", async () => {
    const webNode: CanvasNode = {
      id: "web1", type: "text", title: "Reuters article", grounding: "web", confidence: 0.8,
      sources: [{ url: "https://r/article" }],
    };
    const longText = ["lead paragraph", "middle", ...Array.from({ length: 40 }, (_, i) => `line ${i}`), "tail"].join("\n");
    vi.mocked(takoContents).mockResolvedValueOnce({ text: longText } as any);
    let toolResult = "";
    script = async (tools) => {
      toolResult = await tools.get_node_contents.execute({ nodeId: "web1" });
    };
    const result = await runAnswerLane(
      req({ canvasState: { nodes: [webNode], edges: [] }, selection: undefined }), "", () => {},
    );
    expect(toolResult.startsWith("lead paragraph")).toBe(true);
    expect(toolResult).toContain("middle"); // tail-truncation would have dropped the lead's second line
    expect(result.trace.groundedIn?.contents).toEqual([
      { nodeId: "web1", cardId: undefined, title: "Reuters article", rows: 0 },
    ]);
  });

  it("falls back to the legacy follow-up when the gather loop hard-fails", async () => {
    vi.mocked(generateWithTools).mockRejectedValueOnce(new Error("tool loop exploded"));
    const result = await runAnswerLane(req(), "HIST", () => {});
    expect(runTakoFollowup).toHaveBeenCalledWith(expect.anything(), "EXPLAIN", "HIST", expect.anything());
    expect(result.sideReply).toBe("legacy");
    expect(result.trace.notes?.[0]).toContain("gather loop failed");
  });

  it("main surface streams tokens into narration", async () => {
    const events: AgentEvent[] = [];
    const result = await runAnswerLane(req({ surface: "main" }), "", (e) => events.push(e));
    expect(result.narration).toBe("answer");
    expect(result.sideReply).toBeNull();
    expect(events.some((e) => e.type === "token")).toBe(true);
  });
});

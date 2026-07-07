import { describe, it, expect } from "vitest";
import { ctxBlock } from "./ctx";
import type { AgentRequest } from "../../schema";

const base: AgentRequest = {
  canvasId: "c", message: "how did Nvidia do?", surface: "main",
  canvasState: {
    nodes: [{ id: "nvda", type: "data_card", title: "Nvidia revenue", summary: "grew 88%", grounding: "tako", confidence: 0.9 }],
    edges: [],
  },
  providerId: "tako", history: [],
};

describe("ctxBlock", () => {
  it("includes retrieved node CONTENT, not just metadata", () => {
    const out = ctxBlock(base);
    expect(out).toContain("grew 88%");        // summary content
    expect(out).toContain("[#nvda");          // content-block marker
    expect(out).toContain("BOARD CONTEXT");
  });

  it("includes the conversation block when historyText is provided", () => {
    const out = ctxBlock(base, "SUMMARY OF EARLIER CONVERSATION:\nuser asked about chips");
    expect(out).toContain("CONVERSATION SO FAR");
    expect(out).toContain("user asked about chips");
  });

  it("omits the conversation block when no history", () => {
    expect(ctxBlock(base)).not.toContain("CONVERSATION SO FAR");
  });
});

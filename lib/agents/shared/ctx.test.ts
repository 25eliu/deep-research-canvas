import { describe, it, expect } from "vitest";
import { ctxBlock, scopedCtxBlock } from "./ctx";
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

const treeState = {
  nodes: [
    { id: "synth", type: "text", role: "synthesis", title: "Chip leaders", summary: "Nvidia leads.", grounding: "tako", confidence: 0.9 },
    { id: "rq_nvda", type: "text", role: "research", title: "Nvidia revenue", summary: "Up 200%.", grounding: "tako", confidence: 0.85,
      chartSpec: { kind: "line", series: [{ label: "rev", points: [{ x: "2024", y: 60 }] }] } },
    { id: "rq_amd", type: "text", role: "research", title: "AMD revenue", summary: "Up 20%.", grounding: "tako", confidence: 0.85 },
    { id: "other", type: "text", role: "synthesis", title: "Unrelated EVs", summary: "Tesla stuff.", grounding: "tako", confidence: 0.9 },
  ],
  edges: [
    { id: "e1", from: "rq_nvda", to: "synth", kind: "derived_from" },
    { id: "e2", from: "rq_amd", to: "synth", kind: "derived_from" },
  ],
} as any;

const baseReq = (over: any): AgentRequest => ({
  canvasId: "c", message: "dig into margins", surface: "main",
  canvasState: treeState, providerId: "tako", history: [], ...over,
});

describe("scopedCtxBlock", () => {
  it("with a selection, includes the selected node's whole tree but not unrelated trees", () => {
    const out = scopedCtxBlock(baseReq({ selection: { nodeIds: ["rq_nvda"], nodes: [] } }));
    expect(out).toContain("Nvidia revenue");
    expect(out).toContain("AMD revenue");   // sibling in the same tree
    expect(out).toContain("Chip leaders");  // the tree root (ancestor)
    expect(out).not.toContain("Unrelated EVs"); // a different tree
  });

  it("with no selection, lists all nodes' front-facing info but no chart data", () => {
    const out = scopedCtxBlock(baseReq({ selection: undefined }));
    expect(out).toContain("Nvidia revenue");
    expect(out).toContain("Unrelated EVs");
    expect(out).not.toContain("chart(");   // no raw chart points
    expect(out).not.toContain("2024:60");  // no data points
  });
});

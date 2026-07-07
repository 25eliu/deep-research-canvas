import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

// takoAnswer mock mirrors the real client: it invokes opts.onCall with call meta.
vi.mock("../../tako", () => ({
  takoAnswer: vi.fn(async (q: string, opts: any = {}) => {
    const cards = [{ cardId: "amd", title: "AMD rev", embedUrl: "https://e/amd", webpageUrl: "https://w/amd", source: "Tako" }];
    opts.onCall?.({ query: q, endpoint: "/v1/answer", effort: opts.effort ?? "fast", web: false, ms: 2, cards });
    return { answer: "AMD grew revenue.", cards };
  }),
}));

vi.mock("../../llm", () => ({
  streamAnswer: vi.fn(async (opts: any) => {
    const chunks = ["**AMD** ", "grew."];
    for (const c of chunks) opts.onToken(c);
    return chunks.join("");
  }),
}));

import { runTakoFollowup } from "./followup";

const req = {
  canvasId: "c", message: "how did AMD do?", surface: "main" as const,
  canvasState: { nodes: [], edges: [] }, providerId: "tako" as const, takoAnswerEnabled: true,
  history: [],
};

beforeEach(() => vi.clearAllMocks());

describe("runTakoFollowup — trace parity", () => {
  it("emits tako_call + synthesis events and records calls on the trace", async () => {
    const events: AgentEvent[] = [];
    const result = await runTakoFollowup(req, (e) => events.push(e));

    const takoCalls = events.filter((e) => e.type === "tako_call") as any[];
    expect(takoCalls).toHaveLength(1);
    expect(takoCalls[0].call.endpoint).toBe("/v1/answer");
    expect(takoCalls[0].call.nodeId).toBe("followup");
    expect(takoCalls[0].call.cards[0].id).toBe("amd");

    const synth = events.filter((e) => e.type === "synthesis") as any[];
    expect(synth.some((s) => s.phase === "start")).toBe(true);
    expect(synth.some((s) => s.phase === "end")).toBe(true);

    // authoritative trace carries the flat calls list (no research tree on this path)
    expect(result.trace.calls?.length).toBe(1);
    expect(result.trace.calls?.[0].endpoint).toBe("/v1/answer");
  });
});

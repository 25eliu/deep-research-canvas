import { describe, it, expect } from "vitest";
import { buildHistory } from "./sessions";
import type { Session } from "./sessions";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1", title: "t", createdAt: 0, state: { nodes: [], edges: [] },
    messages: [], provider: "tako", takoAnswer: false, graphy: false, view: { x: 0, y: 0, scale: 1 },
    ...over,
  };
}

describe("buildHistory", () => {
  it("maps messages to wire turns, dropping trace/steps and legacy tool chips", () => {
    const s = session({
      messages: [
        { id: "m1", role: "user", text: "hi", surface: "main" },
        { id: "m2", role: "agent", text: "hello", surface: "main", trace: {} as any, steps: [] },
        { id: "m3", role: "user", text: "chip", surface: "side_chat", focus: ["NVDA"], kind: "tool", icon: "x" } as any,
      ],
    });
    const turns = buildHistory(s);
    expect(turns).toEqual([
      { id: "m1", role: "user", text: "hi", surface: "main", focus: undefined },
      { id: "m2", role: "agent", text: "hello", surface: "main", focus: undefined },
    ]);
  });

  it("only returns turns after summaryUpToId", () => {
    const s = session({
      summaryUpToId: "m1",
      messages: [
        { id: "m1", role: "user", text: "old", surface: "main" },
        { id: "m2", role: "agent", text: "kept", surface: "main" },
      ],
    });
    expect(buildHistory(s).map((t) => t.id)).toEqual(["m2"]);
  });
});

import { describe, it, expect, vi } from "vitest";
import { foldHistory, renderTurns } from "./memory";
import type { ChatTurn } from "../../schema";

const turn = (id: string, text: string): ChatTurn => ({ id, role: "user", text, surface: "main" });

describe("foldHistory", () => {
  it("passes short threads through verbatim without summarizing", async () => {
    const turns = [turn("a", "one"), turn("b", "two")];
    const summarize = vi.fn();
    const r = await foldHistory({ turns }, summarize, 8);
    expect(summarize).not.toHaveBeenCalled();
    expect(r.windowTurns).toEqual(turns);
    expect(r.summary).toBeUndefined();
    expect(r.summarizedThrough).toBeUndefined();
    expect(r.historyText).toContain("one");
    expect(r.historyText).toContain("two");
  });

  it("folds turns older than the window into the summary", async () => {
    const turns = Array.from({ length: 5 }, (_, i) => turn(`m${i}`, `msg${i}`));
    const summarize = vi.fn(async () => "SUMMARY_TEXT");
    const r = await foldHistory({ turns, priorSummary: "PRIOR" }, summarize, 3);
    expect(summarize).toHaveBeenCalledTimes(1);
    // older = m0,m1 (5 - window 3); newest folded id = m1
    expect(summarize.mock.calls[0][1]).toBe("PRIOR");
    expect(r.summarizedThrough).toBe("m1");
    expect(r.windowTurns.map((t) => t.id)).toEqual(["m2", "m3", "m4"]);
    expect(r.summary).toBe("SUMMARY_TEXT");
    expect(r.historyText).toContain("SUMMARY_TEXT");
    expect(r.historyText).toContain("msg4");
  });

  it("includes the prior summary in the prompt block when nothing new is folded", async () => {
    const r = await foldHistory({ turns: [turn("a", "hi")], priorSummary: "EARLIER" }, vi.fn(), 8);
    expect(r.historyText).toContain("EARLIER");
  });
});

describe("renderTurns", () => {
  it("labels roles and appends focus for side_chat", () => {
    const out = renderTurns([
      { id: "1", role: "user", text: "q", surface: "side_chat", focus: ["NVDA", "AMD"] },
      { id: "2", role: "agent", text: "a", surface: "main" },
    ]);
    expect(out).toContain("USER (focused on NVDA, AMD): q");
    expect(out).toContain("ASSISTANT: a");
  });
});

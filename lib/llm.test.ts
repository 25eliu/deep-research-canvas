import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { generateWithTools } from "./llm";

function toolLoopModel() {
  let call = 0;
  return new MockLanguageModelV1({
    doGenerate: async () => {
      call++;
      if (call === 1) {
        return {
          finishReason: "tool-calls" as const,
          usage: { promptTokens: 1, completionTokens: 1 },
          toolCalls: [{
            toolCallType: "function" as const, toolCallId: "t1",
            toolName: "get_card_contents", args: JSON.stringify({ cardId: "nvda" }),
          }],
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        finishReason: "stop" as const,
        usage: { promptTokens: 1, completionTokens: 1 },
        text: "gathered nvda",
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

describe("generateWithTools", () => {
  it("executes tools across steps and returns the final text", async () => {
    const fetched: string[] = [];
    const res = await generateWithTools({
      provider: "openai", system: "s", prompt: "p",
      languageModel: toolLoopModel(),
      maxSteps: 3,
      tools: {
        get_card_contents: tool({
          description: "fetch csv",
          parameters: z.object({ cardId: z.string() }),
          execute: async ({ cardId }) => { fetched.push(cardId); return "Timestamp,V\n2024,1"; },
        }),
      },
    });
    expect(fetched).toEqual(["nvda"]);
    expect(res.text).toBe("gathered nvda");
    expect(res.steps).toBe(2);
  });
});

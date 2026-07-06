// LLM layer built on the Vercel AI SDK. Output is schema-validated (generateObject),
// so callers get typed, structurally-valid objects — no manual JSON salvage.
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, type LanguageModel } from "ai";
import type { z } from "zod";

export type LlmProvider = "openai" | "anthropic";

export function getModel(provider: LlmProvider): LanguageModel {
  if (provider === "openai") {
    return openai(process.env.OPENAI_MODEL || "gpt-5.4-mini");
  }
  return anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5");
}

export async function generateStructured<T>(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}): Promise<T> {
  const { object } = await generateObject({
    model: getModel(opts.provider),
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
    temperature: 0.2,
  });
  return object;
}

export async function generateFreeText(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
}): Promise<string> {
  const { text } = await generateText({
    model: getModel(opts.provider),
    system: opts.system,
    prompt: opts.prompt,
    temperature: 0.2,
  });
  return text;
}

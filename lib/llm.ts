// LLM layer built on the Vercel AI SDK. Output is schema-validated (generateObject),
// so callers get typed, structurally-valid objects — no manual JSON salvage.
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, type LanguageModel } from "ai";
import type { z } from "zod";

export type LlmProvider = "openai" | "anthropic";

export function getModel(provider: LlmProvider): LanguageModel {
  if (provider === "openai") {
    // structuredOutputs: false avoids OpenAI's strict json_schema mode, which
    // requires every schema property to be listed in `required` and rejects
    // the `.optional()` fields our Zod schemas rely on (see lib/schema.ts).
    return openai(process.env.OPENAI_MODEL || "gpt-5.4-mini", {
      structuredOutputs: false,
    });
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
    mode: "json",
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

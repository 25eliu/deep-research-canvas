// LLM layer built on the Vercel AI SDK. Output is schema-validated (generateObject),
// so callers get typed, structurally-valid objects — no manual JSON salvage.
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, streamText, type LanguageModel } from "ai";
import type { z } from "zod";
import { startTimer, preview } from "./log";

export type LlmProvider = "openai" | "anthropic";

export function modelId(provider: LlmProvider): string {
  return provider === "openai"
    ? process.env.OPENAI_MODEL || "gpt-5.4-mini"
    : process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
}

// `model` overrides the provider's default model id (e.g. a deeper GPT for the
// root synthesis while sub-agents stay on the fast mini model).
export function getModel(provider: LlmProvider, model?: string): LanguageModel {
  if (provider === "openai") {
    // structuredOutputs: false avoids OpenAI's strict json_schema mode, which
    // requires every schema property to be listed in `required` and rejects
    // the `.optional()` fields our Zod schemas rely on (see lib/schema.ts).
    return openai(model || modelId("openai"), {
      structuredOutputs: false,
    });
  }
  return anthropic(model || modelId("anthropic"));
}

export async function generateStructured<T>(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  label?: string;
  model?: string; // override the provider's default model
}): Promise<T> {
  const model = opts.model || modelId(opts.provider);
  const timer = startTimer("llm", `generateObject ${opts.label ?? ""}`.trim(), {
    provider: opts.provider,
    model,
    prompt: preview(opts.prompt),
  });
  try {
    const { object, usage } = await generateObject({
      model: getModel(opts.provider, opts.model),
      schema: opts.schema,
      system: opts.system,
      prompt: opts.prompt,
      temperature: 0.2,
      // OpenAI: JSON mode (with structuredOutputs:false, see getModel). Anthropic
      // doesn't support json-mode object generation — it uses tool-call mode.
      mode: opts.provider === "anthropic" ? "tool" : "json",
    });
    timer.done(`generateObject ${opts.label ?? ""}`.trim(), {
      tokens: usage?.totalTokens,
    });
    return object;
  } catch (e: unknown) {
    timer.fail(`generateObject ${opts.label ?? ""} failed`.trim(), {
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

// Streams prose token-by-token via onToken, and returns the full text once done.
// Used for the final answer synthesis so the client can render tokens as they arrive.
export async function streamAnswer(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
  onToken: (chunk: string) => void;
  label?: string;
  model?: string; // override the provider's default model (e.g. a deeper GPT for the root synthesis)
}): Promise<string> {
  const model = opts.model || modelId(opts.provider);
  const timer = startTimer("llm", `streamText ${opts.label ?? ""}`.trim(), {
    provider: opts.provider,
    model,
    prompt: preview(opts.prompt),
  });
  try {
    const { textStream } = streamText({
      model: getModel(opts.provider, opts.model),
      system: opts.system,
      prompt: opts.prompt,
      temperature: 0.2,
    });
    let full = "";
    for await (const chunk of textStream) {
      full += chunk;
      opts.onToken(chunk);
    }
    timer.done(`streamText ${opts.label ?? ""}`.trim(), { chars: full.length });
    return full;
  } catch (e: unknown) {
    timer.fail(`streamText ${opts.label ?? ""} failed`.trim(), {
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

export async function generateFreeText(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
  label?: string;
}): Promise<string> {
  const model = modelId(opts.provider);
  const timer = startTimer("llm", `generateText ${opts.label ?? ""}`.trim(), {
    provider: opts.provider,
    model,
    prompt: preview(opts.prompt),
  });
  try {
    const { text, usage } = await generateText({
      model: getModel(opts.provider),
      system: opts.system,
      prompt: opts.prompt,
      temperature: 0.2,
    });
    timer.done(`generateText ${opts.label ?? ""}`.trim(), {
      tokens: usage?.totalTokens,
    });
    return text;
  } catch (e: unknown) {
    timer.fail(`generateText ${opts.label ?? ""} failed`.trim(), {
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

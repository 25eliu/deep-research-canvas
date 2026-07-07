import type { AgentRequest, AgentResponse } from "../../schema";
import type { EmitFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { researchWeb, type WebResearch } from "../../research";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { zAgentBody } from "../shared/schemas";
import { BASELINE_SYSTEM } from "./prompts";

export async function runBaseline(
  model: "openai" | "anthropic",
  req: AgentRequest,
  emit?: EmitFn,
): Promise<AgentResponse> {
  emit?.({ type: "trace", stage: "routing", note: `baseline:${model}` });

  // Retrieve first, then structure: the baseline searches the live web with the
  // provider's native tool, and we feed the findings into the structured call.
  emit?.({ type: "trace", stage: "searching the web", note: req.message });
  const research = await researchWeb({ provider: model, query: req.message });
  emit?.({
    type: "trace",
    stage: research.sources.length
      ? `found ${research.sources.length} sources`
      : "no web results — using model knowledge",
  });

  const prompt = research.text ? `${ctxBlock(req)}\n\n${researchBlock(research)}` : ctxBlock(req);
  const body = await generateStructured({
    provider: model,
    system: BASELINE_SYSTEM,
    prompt,
    schema: zAgentBody,
    label: `baseline:${model}`,
  });
  emit?.({ type: "trace", stage: "laying out", note: `${body.canvasOps.length} ops` });
  // Only URLs we actually retrieved this turn are trusted as citations; sanitize
  // strips any model-invented source and relabels unverifiable cards "model".
  const validSourceUrls = new Set(research.sources.map((s) => s.url));
  const ops = finalizeOps(
    req.canvasState,
    sanitizeOps(body.canvasOps, { allowTako: false, validSourceUrls }),
  );
  return { canvasOps: ops, narration: body.narration, sideReply: body.sideReply };
}

// Serialize the web research + its sources into a prompt block the model grounds on.
function researchBlock(research: WebResearch): string {
  const sources = research.sources
    .map((s, i) => `  [${i + 1}] ${s.title ? `${s.title} — ` : ""}${s.url}`)
    .join("\n");
  return [
    "WEB_RESEARCH (you just gathered this from a live web search — build the canvas from it):",
    research.text,
    sources ? `SOURCES:\n${sources}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

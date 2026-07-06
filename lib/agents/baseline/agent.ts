import type { AgentRequest, AgentResponse } from "../../schema";
import type { TraceFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { zAgentBody } from "../shared/schemas";
import { BASELINE_SYSTEM } from "./prompts";

export async function runBaseline(
  model: "openai" | "anthropic",
  req: AgentRequest,
  onTrace?: TraceFn,
): Promise<AgentResponse> {
  onTrace?.({ stage: "routing", note: `baseline:${model}` });
  const body = await generateStructured({
    provider: model,
    system: BASELINE_SYSTEM,
    prompt: ctxBlock(req),
    schema: zAgentBody,
  });
  onTrace?.({ stage: "laying out", note: `${body.canvasOps.length} ops` });
  const ops = finalizeOps(req.canvasState, sanitizeOps(body.canvasOps, { allowTako: false }));
  return { canvasOps: ops, narration: body.narration, sideReply: body.sideReply };
}

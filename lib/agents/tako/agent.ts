import type { AgentRequest, AgentResponse } from "../../schema";
import type { TraceFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { ROUTER, zRoute } from "../shared/router";
import { runTakoInitial } from "./pipeline";
import { runTakoFollowup } from "./followup";

const OPENAI = "openai" as const;

export async function runTako(req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse> {
  // Route first (fast, cheap).
  onTrace?.({ stage: "routing" });
  const hasBoard = req.canvasState.nodes.length > 0;
  const route = await generateStructured({
    provider: OPENAI,
    system: `${ROUTER}\nReturn { action, reason }.`,
    prompt: ctxBlock(req),
    schema: zRoute,
  });
  // NEW_BOARD when empty board regardless of model guess.
  const action = hasBoard ? route.action : "NEW_BOARD";

  const isFollowup = action === "EXPLAIN" || action === "AUGMENT" || action === "REPLACE";
  const { body, validCardIds, trace } = isFollowup
    ? await runTakoFollowup(req, onTrace)
    : await runTakoInitial(req, onTrace);

  const ops = finalizeOps(req.canvasState, sanitizeOps(body.canvasOps, { allowTako: true, validCardIds }));
  return {
    canvasOps: ops,
    narration: body.narration,
    sideReply: body.sideReply,
    trace: { action, provider: "tako", queries: [], cards: [], opsApplied: ops.length, notes: [], ms: 0, ...trace } as any,
  };
}

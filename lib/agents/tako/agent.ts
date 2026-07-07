import type { AgentRequest, AgentResponse } from "../../schema";
import type { EmitFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { ROUTER, zRoute } from "../shared/router";
import { foldHistory, summarizeTurns } from "../shared/memory";
import { runTakoInitial } from "./pipeline";
import { runTakoFollowup } from "./followup";
import { graphStrategy, type QueryStrategy } from "./strategy";

const OPENAI = "openai" as const;

export async function runTako(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<AgentResponse> {
  // Fold conversation history first — feeds routing AND the follow-up answer.
  const folded = await foldHistory({ turns: req.history ?? [], priorSummary: req.historySummary }, summarizeTurns);
  const historyText = folded.historyText;

  // Route first (fast, cheap).
  emit?.({ type: "trace", stage: "routing" });
  const hasBoard = req.canvasState.nodes.length > 0;
  const route = await generateStructured({
    provider: OPENAI,
    system: `${ROUTER}\nReturn { action, reason }.`,
    prompt: ctxBlock(req, historyText),
    schema: zRoute,
    label: "route",
  });
  // NEW_BOARD when empty board regardless of model guess.
  const action = hasBoard ? route.action : "NEW_BOARD";

  const isFollowup = action === "EXPLAIN" || action === "AUGMENT" || action === "REPLACE";
  const result = isFollowup
    ? await runTakoFollowup(req, action, historyText, emit)
    : await runTakoInitial(req, emit, strategy);

  // Node ops were already streamed; sanitize + provenance-filter them, then let
  // relate.ts append the structural edges. The result carries the authoritative
  // full op set (idempotent with the streamed ops on the client).
  const sanitized = sanitizeOps(result.nodeOps, { allowTako: true, validCardIds: result.validCardIds });
  const provenanced = sanitized.filter(
    (o) => (o.op !== "add_node" && o.op !== "upsert_node") || result.allowedNodeIds.has(o.node.id),
  );
  const ops = finalizeOps(req.canvasState, provenanced);

  return {
    canvasOps: ops,
    narration: result.narration,
    sideReply: result.sideReply,
    memory: { summary: folded.summary, summarizedThrough: folded.summarizedThrough },
    trace: { action, provider: req.providerId, queries: [], cards: [], opsApplied: ops.length, notes: [], ms: 0, ...result.trace } as any,
  };
}

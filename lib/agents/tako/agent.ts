import type { AgentRequest, AgentResponse } from "../../schema";
import type { EmitFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { ROUTER, zRoute } from "../shared/router";
import { runTakoInitial } from "./pipeline";
import { runTakoFollowup } from "./followup";
import { graphStrategy, type QueryStrategy } from "./strategy";

const OPENAI = "openai" as const;

export async function runTako(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<AgentResponse> {
  // Route first (fast, cheap).
  emit?.({ type: "trace", stage: "routing" });
  const hasBoard = req.canvasState.nodes.length > 0;
  const route = await generateStructured({
    provider: OPENAI,
    system: `${ROUTER}\nReturn { action, reason }.`,
    prompt: ctxBlock(req),
    schema: zRoute,
    label: "route",
  });
  // NEW_BOARD when empty board regardless of model guess.
  const action = hasBoard ? route.action : "NEW_BOARD";

  const isFollowup = action === "EXPLAIN" || action === "AUGMENT" || action === "REPLACE";
  const result = isFollowup ? await runTakoFollowup(req, emit) : await runTakoInitial(req, emit, strategy);

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
    trace: { action, provider: "tako", queries: [], cards: [], opsApplied: ops.length, notes: [], ms: 0, ...result.trace } as any,
  };
}

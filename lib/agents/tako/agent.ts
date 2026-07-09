import type { AgentRequest, AgentResponse } from "../../schema";
import type { EmitFn, RouteAction } from "../shared/types";
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

// Route the turn. An empty board deterministically runs the initial pipeline —
// no router LLM call. A router hard-failure defaults to EXPLAIN (answer the
// turn from board context; never kill it).
async function routeTurn(req: AgentRequest, historyText: string, emit?: EmitFn): Promise<RouteAction> {
  if (req.canvasState.nodes.length === 0) return "REPLACE";
  emit?.({ type: "trace", stage: "routing" });
  try {
    const route = await generateStructured({
      provider: OPENAI,
      system: `${ROUTER}\nReturn { action, reason }.`,
      prompt: ctxBlock(req, historyText),
      schema: zRoute,
      label: "route",
    });
    return route.action;
  } catch {
    return "EXPLAIN";
  }
}

export async function runTako(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<AgentResponse> {
  // Fold conversation history first — feeds routing AND the lanes.
  const folded = await foldHistory({ turns: req.history ?? [], priorSummary: req.historySummary }, summarizeTurns);
  const historyText = folded.historyText;

  const action = await routeTurn(req, historyText, emit);

  // Staged wiring: EXPLAIN/AUGMENT/GENERATE still answer via the legacy
  // follow-up (GENERATE behaves as AUGMENT); the answer/research lanes replace
  // this in the lane tasks. REPLACE (and the empty board) rebuilds via the
  // initial research-tree pipeline.
  const result = action === "REPLACE"
    ? await runTakoInitial(req, emit, strategy)
    : await runTakoFollowup(req, action === "GENERATE" ? "AUGMENT" : action, historyText, emit);

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

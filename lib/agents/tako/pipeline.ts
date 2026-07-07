import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings } from "../shared/types";
import { FindingLedger } from "./findings";
import { research, newResearchCtx, toNodeSources, SYNTH_ID } from "./research";
import { composeReport } from "./compose";
import { log } from "../../log";
import { graphStrategy, type QueryStrategy } from "./strategy";

// Initial-turn Tako pipeline: builds a recursive research tree (see research.ts)
// and returns the authoritative op set. All node/edge ops are streamed live via
// emit; the root answer streams into the "synth" block, sub-answers into their
// own research nodes.
export async function runTakoInitial(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const ledger = new FindingLedger();
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();

  // Record ops locally (for the authoritative result) AND stream them live.
  const push = (ops: CanvasOp[]) => {
    for (const op of ops) {
      nodeOps.push(op);
      if (op.op === "add_node" || op.op === "upsert_node") allowedNodeIds.add(op.node.id);
    }
    if (ops.length) emit?.({ type: "ops", ops });
  };

  const ctx = newResearchCtx(req, ledger, push, emit, strategy);
  const rootResult = await research(req.message, 0, ctx, { root: true });

  // No evidence anywhere → no synth node; fall back to a plain chat answer.
  let narration = "";
  if (!rootResult.nodeId) {
    narration = "I couldn't find structured data for this question in Tako.";
    emit?.({ type: "token", text: narration });
  } else {
    // Final layer: Claude reconciles the evidence into a composed answer report
    // (verdict + validated table/chart/tiles/prose), stored on the synth block.
    emit?.({ type: "synthesis", phase: "start", nodeId: SYNTH_ID, kind: "root" });
    const t = Date.now();
    const report = await composeReport(ctx, req.message);
    ctx.timings.stream = Math.max(ctx.timings.stream, Date.now() - t);
    emit?.({ type: "synthesis", phase: "end", nodeId: SYNTH_ID, kind: "root" });
    if (report) {
      // The root answer's "see sources" = every website used across the whole tree.
      const rootSources = toNodeSources(ctx.webSources);
      push([{ op: "update_node", id: SYNTH_ID, patch: {
        title: report.verdict.slice(0, 90), summary: report.verdict, report,
        ...(rootSources.length ? { sources: rootSources } : {}),
      } }]);
    }
  }

  log("tako", "research run", {
    findings: ledger.size,
    treeNodes: ctx.tree.length,
    ...ctx.timings,
  });

  return {
    nodeOps,
    narration,
    sideReply: null,
    validCardIds: new Set(ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      graph: { resolved: ctx.resolved, related: ctx.related },
      queries: ctx.queries,
      cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      notes: ctx.notes,
      tree: ctx.tree,
      // Flat authoritative views — the ctx accumulators capture every call/reasoning
      // step, including those on pruned (0-finding) leaves the tree dropped.
      calls: ctx.calls,
      reasoning: ctx.reasoning,
      timings: { ...ctx.timings, total: 0 } as Timings,
    },
  };
}

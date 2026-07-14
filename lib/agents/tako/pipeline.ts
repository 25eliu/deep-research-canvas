import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings } from "../shared/types";
import { FindingLedger } from "./findings";
import { research, newResearchCtx, toNodeSources } from "./research";
import type { ResearchCtx } from "./flow";
import { composeReport } from "./compose";
import { runGapRound } from "./gaps";
import { log } from "../../log";
import { graphStrategy, type QueryStrategy } from "./strategy";

// Card titles must never be chopped mid-word: take the first sentence when it is
// short enough, otherwise cut at the last word boundary and mark the cut with an
// ellipsis. (The full verdict still renders in the card body — this is only the header.)
const TITLE_MAX = 140;
export function titleFrom(text: string): string {
  const t = text.trim();
  const sentence = t.match(/^[^.!?]{10,}?[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length <= TITLE_MAX) return sentence;
  if (t.length <= TITLE_MAX) return t;
  const cut = t.slice(0, TITLE_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 80))}…`;
}

// Build the standard record-and-stream push plus the op/id tracking sets a research
// ctx needs. Reused by the initial pipeline and the additive expand lane.
export function trackingPush(emit?: EmitFn): {
  push: (ops: CanvasOp[]) => void; nodeOps: CanvasOp[]; allowedNodeIds: Set<string>;
} {
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const push = (ops: CanvasOp[]) => {
    for (const op of ops) {
      nodeOps.push(op);
      if (op.op === "add_node" || op.op === "upsert_node") allowedNodeIds.add(op.node.id);
    }
    if (ops.length) emit?.({ type: "ops", ops });
  };
  return { push, nodeOps, allowedNodeIds };
}

// Run a full research tree on an already-built ctx (rootId + ctxText owned by the
// caller): recursive research (research.ts) → one gap-fill round → composed report
// on the synth block. All node/edge ops stream live via ctx.push; the returned
// PipelineResult carries the authoritative op set + trace. Additive trees reuse this
// verbatim — only the ctx (rootId, ctxText, seeded usedIds) differs.
export async function runResearchTree(
  req: AgentRequest, ctx: ResearchCtx, nodeOps: CanvasOp[], allowedNodeIds: Set<string>, emit?: EmitFn,
): Promise<PipelineResult> {
  const push = ctx.push;
  const runStart = Date.now(); // the synth node's true wall-clock spans research + gap round + compose
  const rootResult = await research(req.message, 0, ctx, { root: true });

  // No evidence anywhere → no synth node; fall back to a plain chat answer.
  let narration = "";
  if (!rootResult.nodeId) {
    narration = "I couldn't find structured data for this question in Tako.";
    emit?.({ type: "token", text: narration });
  } else {
    // One gap-fill round: review the gathered evidence, fetch what's missing.
    await runGapRound(ctx, req.message);
    emit?.({ type: "trace", stage: "composing report" });
    // Final layer: Claude reconciles the evidence into a composed answer report
    // (verdict + validated table/chart/tiles/prose), stored on the synth block.
    emit?.({ type: "synthesis", phase: "start", nodeId: ctx.rootId, kind: "root" });
    const t = Date.now();
    const report = await composeReport(ctx, req.message);
    const composeMs = Date.now() - t;
    ctx.timings.stream = Math.max(ctx.timings.stream, composeMs);
    emit?.({ type: "synthesis", phase: "end", nodeId: ctx.rootId, kind: "root" });
    // The composer's get_card_contents calls landed in ctx.calls AFTER the root
    // tree node's calls[] snapshot was pushed. The finalized trace renders only
    // per-node calls (buildTree ignores the flat list), so without this merge the
    // contents fetches vanish the moment the live steps are replaced. Dedup by
    // callId: on a leaf-only run the root node already carries its own contents calls.
    // The same patch stamps the synth node's timing: its tree entry was pushed before
    // the gap round + compose ran, so its totalMs is re-based to the whole run here.
    ctx.tree = ctx.tree.map((n) => {
      if (n.nodeId !== ctx.rootId) return n;
      const seen = new Set((n.calls ?? []).map((c) => c.callId));
      const synthContents = ctx.calls.filter(
        (c) => c.nodeId === ctx.rootId && c.endpoint === "/v1/contents" && !seen.has(c.callId),
      );
      return {
        ...n,
        ...(synthContents.length ? { calls: [...(n.calls ?? []), ...synthContents] } : {}),
        totalMs: Date.now() - runStart,
        composeMs,
      };
    });
    // The root answer's "see sources" = every website used across the whole tree.
    const rootSources = toNodeSources(ctx.webSources);
    if (report) {
      push([{ op: "update_node", id: ctx.rootId, patch: {
        title: titleFrom(report.verdict), summary: report.verdict, report,
        ...(rootSources.length ? { sources: rootSources } : {}),
      } }]);
    } else {
      // The composer failed (or found nothing to reconcile), but evidence was
      // gathered — never leave the synth node stuck on "Synthesizing…"; patch it
      // with a degraded summary built straight from the branch claims so the user
      // still gets an answer.
      const claims = ctx.branchResults.map((b) => b.claim).filter((c) => c.length > 0);
      const title = titleFrom(claims[0] || req.message);
      const summary = claims.length
        ? `The final report could not be composed — here is what the research found:\n${claims.map((c) => `- ${c}`).join("\n")}`
        : "The final report could not be composed.";
      push([{ op: "update_node", id: ctx.rootId, patch: {
        title, summary,
        ...(rootSources.length ? { sources: rootSources } : {}),
      } }]);
    }
  }

  log("tako", "research run", {
    findings: ctx.ledger.size,
    treeNodes: ctx.tree.length,
    ...ctx.timings,
  });

  return {
    nodeOps,
    narration,
    sideReply: null,
    validCardIds: new Set(ctx.ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      graph: { resolved: ctx.resolved, related: ctx.related },
      // The root decompose was actually grounded by a /v1/answer this turn (provenance
      // flag; an attempted-but-empty/failed grounding stays false).
      answerUsed: ctx.answerGrounded,
      queries: ctx.queries,
      cards: ctx.ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      notes: ctx.notes,
      tree: ctx.tree,
      // Flat authoritative views — the ctx accumulators capture every call/reasoning
      // step, including those on pruned (0-finding) leaves the tree dropped.
      calls: ctx.calls,
      reasoning: ctx.reasoning,
      ...(ctx.graphyTrace ? { graphy: ctx.graphyTrace } : {}),
      timings: { ...ctx.timings, total: 0 } as Timings,
    },
  };
}

// Initial-turn Tako pipeline: builds a recursive research tree from a fresh ctx (root
// id = SYNTH_ID, full-board context) and returns the authoritative op set.
export async function runTakoInitial(
  req: AgentRequest, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const ledger = new FindingLedger();
  const { push, nodeOps, allowedNodeIds } = trackingPush(emit);
  const ctx = newResearchCtx(req, ledger, push, emit, strategy);
  return runResearchTree(req, ctx, nodeOps, allowedNodeIds, emit);
}

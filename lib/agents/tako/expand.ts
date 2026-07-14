// The RESEARCH lane: grow a NEW research tree beside the existing board. Mirrors the
// initial pipeline (research → gap round → composed report) via runResearchTree, but
// additively — a unique synth root, existing ids reserved, scoped planning context,
// no board-clear, and an anchor edge to the selection's tree. Edges stay strictly
// structural (parent→child within the tree + the anchor); no LLM-proposed links.
// Empty evidence degrades to the answer lane so a turn never dies.
import type { AgentRequest } from "../../schema";
import type { EmitFn, PipelineResult } from "../shared/types";
import { FindingLedger } from "./findings";
import { newResearchCtx } from "./research";
import { derivedEdge, type ResearchCtx } from "./flow";
import { runResearchTree, trackingPush } from "./pipeline";
import { scopedCtxBlock } from "../shared/ctx";
import { getAncestors } from "../../lineage";
import { runAnswerLane } from "./chat";
import { graphStrategy, type QueryStrategy } from "./strategy";
import { log } from "../../log";

// A unique synthesis root id for the new tree, reserved against existing board ids.
function newRootId(req: AgentRequest, existing: Set<string>): string {
  const slug = req.message.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
  const base = `synth_${slug || "x"}`;
  let id = base, i = 2;
  while (existing.has(id)) id = `${base}_${i++}`;
  return id;
}

// The root of the selected node's tree (topmost synthesis/consensus ancestor), else
// the selected node itself — what the new tree anchors beside.
function selectionTreeRoot(req: AgentRequest): string | undefined {
  const first = req.selection?.nodeIds?.[0];
  if (!first) return undefined;
  const ancestors = getAncestors(first, req.canvasState.edges ?? []);
  const root = req.canvasState.nodes.find(
    (n) => ancestors.has(n.id) && (n.role === "synthesis" || n.role === "consensus"),
  );
  return root?.id ?? first;
}

export async function runTakoExpand(
  req: AgentRequest, historyText: string, emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const existing = new Set(req.canvasState.nodes.map((n) => n.id));
  const rootId = newRootId(req, existing);
  const ctxText = scopedCtxBlock(req, historyText);

  const ledger = new FindingLedger();
  const { push, nodeOps, allowedNodeIds } = trackingPush(emit);
  const ctx: ResearchCtx = newResearchCtx(req, ledger, push, emit, strategy, { rootId, ctxText });
  // Existing board ids can never be reused by the new tree's research nodes.
  for (const id of existing) ctx.usedIds.add(id);

  const result = await runResearchTree(req, ctx, nodeOps, allowedNodeIds, emit);

  // No structured data anywhere → the tree's root was never minted. Degrade to the
  // answer lane (never a dead turn), carrying this lane's notes for the trace.
  const mintedRoot = nodeOps.some((o) => (o.op === "add_node" || o.op === "upsert_node") && o.node.id === rootId);
  if (!mintedRoot) {
    log("tako", "expand degraded — no tree minted", { message: req.message.slice(0, 60) });
    const fallback = await runAnswerLane(req, historyText, emit);
    return { ...fallback, trace: { ...fallback.trace, notes: ["research found no data — answered instead", ...(fallback.trace.notes ?? [])] } };
  }

  // Anchor the new tree beside what the user was looking at: the selected node's tree root.
  const anchor = selectionTreeRoot(req);
  if (anchor && anchor !== rootId && existing.has(anchor)) push([derivedEdge(rootId, anchor)]);

  log("tako", "expand lane", { rootId, findings: ledger.size, anchor: anchor ?? null });
  return result;
}

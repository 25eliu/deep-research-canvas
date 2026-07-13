// The RESEARCH lane: grow a NEW research tree beside the existing board. Mirrors the
// initial pipeline (research → gap round → composed report) via runResearchTree, but
// additively — a unique synth root, existing ids reserved, scoped planning context,
// no board-clear, an anchor edge to the selection's tree, and LLM-proposed semantic
// cross-links to directly-related existing nodes. Empty evidence degrades to the
// answer lane so a turn never dies.
import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult } from "../shared/types";
import { generateStructured } from "../../llm";
import { FindingLedger } from "./findings";
import { newResearchCtx } from "./research";
import { derivedEdge, supportsEdge, type ResearchCtx } from "./flow";
import { runResearchTree, trackingPush } from "./pipeline";
import { scopedCtxBlock } from "../shared/ctx";
import { zCrossLinks } from "../shared/schemas";
import { CROSSLINK_SYSTEM } from "./prompts";
import { getAncestors } from "../../lineage";
import { runAnswerLane } from "./chat";
import { graphStrategy, type QueryStrategy } from "./strategy";
import { log } from "../../log";

const OPENAI = "openai" as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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

// One cheap structured call: propose 0-3 semantic edges from the new tree's root to
// directly-related existing nodes. The model returns the sentinel "SELF_ROOT" as the
// source; we rewrite it to the real root and drop any edge whose target isn't a real
// existing node. finalizeOps/validateGraph downstream drop dupes + cycles. Never fatal.
async function proposeCrossLinks(
  req: AgentRequest, rootId: string, existing: Set<string>, ctx: ResearchCtx, push: (ops: CanvasOp[]) => void,
): Promise<void> {
  const newLeaves = ctx.tree.filter((n) => n.nodeId !== rootId).map((n) => n.question);
  const existingNodes = req.canvasState.nodes
    .filter((n) => n.type !== "entity_section" && n.role !== "header")
    .map((n) => ({ id: n.id, title: n.title, summary: n.summary ?? "" }));
  if (existingNodes.length === 0) return;
  try {
    const out = await generateStructured({
      provider: OPENAI, system: CROSSLINK_SYSTEM,
      prompt: `NEW_TREE: ${JSON.stringify({ question: req.message, subQuestions: newLeaves })}\n\nEXISTING_NODES: ${JSON.stringify(existingNodes)}`,
      schema: zCrossLinks, label: "crosslink",
    });
    const ops: CanvasOp[] = [];
    for (const link of out.links) {
      if (!existing.has(link.to) || link.to === rootId) continue; // must target a real, different node
      ops.push(link.kind === "contradicts"
        ? { op: "add_edge", edge: { id: `contradicts:${rootId}->${link.to}`, from: rootId, to: link.to, kind: "contradicts" } }
        : supportsEdge(rootId, link.to));
    }
    if (ops.length) { ctx.notes.push(`cross-linked to ${ops.length} existing node(s)`); push(ops); }
  } catch (e: unknown) {
    ctx.notes.push(`cross-link step failed — ${errorMessage(e)}`);
  }
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

  // Connect the new tree to any directly-related existing nodes.
  await proposeCrossLinks(req, rootId, existing, ctx, push);

  log("tako", "expand lane", { rootId, findings: ledger.size, anchor: anchor ?? null });
  return result;
}

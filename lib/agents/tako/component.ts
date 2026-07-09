// Research lane (GENERATE / AUGMENT): distill the request into ONE researchable
// sub-question + entity-first lookup, run the existing researchLeaf (graph search +
// related → cards → streamed mini-synthesis) to mint a subquery answer node on the
// board, and anchor it beside the selection. Every failure degrades to the answer
// lane — never a dead turn.
import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings } from "../shared/types";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zComponentPlan, type ComponentPlan, type GraphLookup } from "../shared/schemas";
import { FindingLedger } from "./findings";
import { newResearchCtx, researchLeaf, uniqueResearchId, derivedEdge } from "./flow";
import { COMPONENT_DISTILL_SYSTEM } from "./prompts";
import { runAnswerLane } from "./chat";
import { graphStrategy, type QueryStrategy } from "./strategy";
import { log } from "../../log";

const OPENAI = "openai" as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Distill with one corrective retry (the established decompose pattern). Null when
// both attempts fail — the caller degrades to the answer lane.
async function distillPlan(req: AgentRequest, historyText: string, notes: string[]): Promise<ComponentPlan | null> {
  const prompt = `${ctxBlock(req, historyText)}\n\nREQUEST: ${req.message}`;
  try {
    return await generateStructured({
      provider: OPENAI, system: COMPONENT_DISTILL_SYSTEM, prompt,
      schema: zComponentPlan, label: "component-distill",
    });
  } catch (e: unknown) {
    notes.push(`component distill invalid — retrying once (${errorMessage(e).slice(0, 100)})`);
    try {
      return await generateStructured({
        provider: OPENAI, system: COMPONENT_DISTILL_SYSTEM,
        prompt: `${prompt}\n\nSCHEMA_REMINDER: Your previous response did not match the required schema.` +
          ` Return { question, rationale, entities (1-3 candidate name strings), subtype?, metricFilters (1-5 short metric-name fragments) }.`,
        schema: zComponentPlan, label: "component-distill",
      });
    } catch (e2: unknown) {
      notes.push(`component distill failed — ${errorMessage(e2).slice(0, 100)}`);
      return null;
    }
  }
}

// Any-failure escape hatch: answer the turn via the answer lane, carrying the
// research lane's notes so the trace explains the degradation.
async function degrade(req: AgentRequest, historyText: string, notes: string[], emit?: EmitFn): Promise<PipelineResult> {
  const fallback = await runAnswerLane(req, historyText, emit);
  return { ...fallback, trace: { ...fallback.trace, notes: [...notes, ...(fallback.trace.notes ?? [])] } };
}

export async function runComponentLane(
  req: AgentRequest, action: "AUGMENT" | "GENERATE", historyText: string,
  emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): Promise<PipelineResult> {
  const notes: string[] = [];
  emit?.({ type: "trace", stage: "planning component" });
  const plan = await distillPlan(req, historyText, notes);
  if (!plan) return degrade(req, historyText, notes, emit);

  const ledger = new FindingLedger();
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const push = (ops: CanvasOp[]) => {
    for (const op of ops) {
      nodeOps.push(op);
      if (op.op === "add_node" || op.op === "upsert_node") allowedNodeIds.add(op.node.id);
    }
    if (ops.length) emit?.({ type: "ops", ops });
  };
  const ctx = newResearchCtx(req, ledger, push, emit, strategy);
  ctx.notes.push(...notes);
  // Existing board ids can never be reused by the new research node.
  for (const n of req.canvasState.nodes) ctx.usedIds.add(n.id);

  const nodeId = uniqueResearchId(ctx, plan.question);
  const lookup: GraphLookup = {
    entities: plan.entities,
    ...(plan.subtype ? { subtype: plan.subtype } : {}),
    metricFilters: plan.metricFilters,
  };
  emit?.({
    type: "reasoning", nodeId, depth: 1, question: plan.question, kind: "leaf",
    rationale: plan.rationale, entities: lookup.entities, subtype: lookup.subtype, metrics: lookup.metricFilters,
  });

  const result = await researchLeaf(plan.question, 1, nodeId, false, ctx, lookup, plan.rationale);
  if (!result.nodeId) {
    ctx.notes.push(`no data found for "${plan.question.slice(0, 80)}" — answering instead`);
    return degrade(req, historyText, ctx.notes, emit);
  }

  // Anchor the new subquery node beside what the user was looking at: the first
  // selected node, else the board's synthesis node, else unanchored.
  const anchor = req.selection?.nodeIds?.[0]
    ?? req.canvasState.nodes.find((n) => n.role === "synthesis")?.id;
  if (anchor) push([derivedEdge(result.nodeId, anchor)]);

  const toBoard = req.surface !== "side_chat";
  const text = `Added **${plan.question}** to the board.\n\n${result.synthesis}`;
  if (toBoard) emit?.({ type: "token", text });
  log("tako", "component lane", { action, question: plan.question, findings: result.findingCount, anchor: anchor ?? null });

  return {
    nodeOps,
    narration: toBoard ? text : "",
    sideReply: toBoard ? null : text,
    validCardIds: new Set(ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      queries: ctx.queries,
      answerUsed: false,
      cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      calls: ctx.calls,
      notes: ctx.notes,
      tree: ctx.tree,
      graph: { resolved: ctx.resolved, related: ctx.related },
      reasoning: ctx.reasoning,
      groundedIn: {
        nodes: [],
        takoAnswerUsed: false,
        cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      },
      timings: { ...ctx.timings, total: 0 } as Timings,
    },
  };
}

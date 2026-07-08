// One-round gap analysis + fill: after the research tree completes, a deep-model
// review of the gathered evidence lists what still BLOCKS a decisive answer; each
// gap runs the standard leaf flow (visible on canvas with gapFill:true) so its
// findings land in the same ctx accumulators the composer reads.
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zGapPlan, type GapPlan } from "../shared/schemas";
import { GAP_SYSTEM } from "./prompts";
import { SYNTH_ID, derivedEdge, researchLeaf, uniqueResearchId, type ResearchCtx } from "./flow";

const MAX_GAPS = 4;
const deepModel = () => process.env.SYNTH_MODEL || "gpt-5.4";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface GapRoundResult { ran: boolean; gaps: GapPlan["gaps"]; filled: number }

export async function runGapRound(ctx: ResearchCtx, question: string): Promise<GapRoundResult> {
  if (ctx.budget.researchNodes >= ctx.budget.maxNodes) {
    ctx.notes.push("gap round skipped — research budget exhausted");
    return { ran: false, gaps: [], filled: 0 };
  }
  ctx.emit?.({ type: "trace", stage: "analyzing gaps" });

  const digest = {
    subAnswers: ctx.branchResults.map((b) => ({ question: b.question, claim: b.claim, confidence: b.confidence })),
    figures: ctx.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity })),
    cards: ctx.ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, source: f.source })),
  };

  let plan: GapPlan;
  try {
    plan = await generateStructured({
      provider: "openai", model: deepModel(),
      system: GAP_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nEVIDENCE: ${JSON.stringify(digest)}`,
      schema: zGapPlan, label: "gap-analysis",
      reasoningEffort: "high",
    });
  } catch (e: unknown) {
    ctx.notes.push(`gap analysis failed — ${errorMessage(e)}`);
    return { ran: false, gaps: [], filled: 0 };
  }

  if (plan.sufficient || plan.gaps.length === 0) {
    ctx.notes.push(`gap analysis: sufficient — ${plan.rationale}`);
    return { ran: true, gaps: [], filled: 0 };
  }

  const room = ctx.budget.maxNodes - ctx.budget.researchNodes;
  const gaps = plan.gaps.slice(0, Math.min(MAX_GAPS, room));
  ctx.budget.researchNodes += gaps.length; // reserve before the parallel fills
  ctx.emit?.({ type: "trace", stage: `filling gaps (${gaps.length})` });

  const results = await Promise.all(gaps.map(async (g) => {
    const nodeId = uniqueResearchId(ctx, g.question);
    ctx.emit?.({
      type: "reasoning", nodeId, depth: 1, question: g.question, kind: "gap",
      rationale: g.why, entities: [g.entity], metrics: [g.metric],
    });
    ctx.reasoning.push({ nodeId, question: g.question, rationale: g.why });
    try {
      return await researchLeaf(g.question, 1, nodeId, false, ctx, [g.entity], [g.metric], g.why, { gapFill: true });
    } catch (e: unknown) {
      // A single gap-fill leaf failing (e.g. leaf-synth's streamAnswer rethrowing)
      // must not take down an otherwise-complete turn — note it and drop it, same
      // as the "found nothing" exclusion below.
      ctx.notes.push(`gap fill failed for "${g.question}" — ${errorMessage(e)}`);
      return { nodeId: null, findingCount: 0 };
    }
  }));

  let filled = 0;
  for (const r of results) {
    if (!r.nodeId || r.findingCount === 0) continue;
    filled++;
    ctx.push([derivedEdge(r.nodeId, SYNTH_ID)]); // gap answer feeds the synthesis
  }
  return { ran: true, gaps, filled };
}

import { z } from "zod";
import { zCanvasOps } from "../../schema";

// The composed answer report lives in schema.ts (it's a canvas-node field); re-export
// here so agent code has one import site for all agent schemas.
export { zAnswerBlock, zAnswerReport } from "../../schema";
export type { AnswerBlock, AnswerReport } from "../../schema";

// The board-diff body every agent returns (before sanitize/relate/consensus).
export const zAgentBody = z.object({
  canvasOps: zCanvasOps,
  narration: z.string(),
  sideReply: z.string().nullable(),
});
export type AgentBody = z.infer<typeof zAgentBody>;

// Tako pipeline sub-steps
export const zBreakdown = z.object({
  entities: z.array(z.string()),
  metrics: z.array(z.string()),
  subtypes: z.record(z.string()).optional(),
});
export const zQueries = z.object({ queries: z.array(z.string()) });

// Web-source usefulness filter: the indices of the candidates worth keeping.
export const zWebFilter = z.object({ useful: z.array(z.number()) });

// Metric filter: from the metrics Tako's graph actually has for a resolved entity,
// keep the ones that answer THIS (sub)question. Queries are then composed only from
// confirmed entity×metric pairs — no ungrounded/overview/duplicate queries.
export const zMetricFilter = z.object({ keep: z.array(z.string()) });

// Structured result each branch/leaf returns (in addition to its prose node), so
// the final layer can RECONCILE evidence rather than concatenate prose.
export const zBranchResult = z.object({
  claim: z.string(), // the branch's one-line answer to its sub-question
  keyFigures: z.array(z.object({
    label: z.string(),
    value: z.string(),
    entity: z.string().optional(),
  })).default([]),
  confidence: z.number().min(0).max(1),
});
export type BranchResult = z.infer<typeof zBranchResult>;


// Recursive decompose step: the LLM decides whether a research question is atomic
// (fetch data directly) or should split into distinct sub-questions (branch).
// Every question — the plan itself and each sub-question — is a validated LOOKUP PAIR:
// exactly ONE entity term (searched only in the graph's entity namespace) + ONE metric
// term (searched only in the metric namespace). Singular fields are deliberate: they
// force the one-target-per-question model on the LLM, and a missing/empty half fails
// validation so generateObject retries instead of proceeding half-grounded.
export const zResearchPlan = z.object({
  atomic: z.boolean(),
  // 1-2 sentences: WHY this question is atomic or splits into these sub-questions.
  // Surfaced to the user as the "reasoning" step for this research node.
  rationale: z.string(),
  // The lookup pair for THIS question (leaf fetch / broad-view grounding).
  entity: z.string().min(1),
  metric: z.string().min(1),
  subQuestions: z.array(z.object({
    question: z.string(),
    rationale: z.string().optional(), // why this facet matters (optional per-sub reasoning)
    entity: z.string().min(1),
    metric: z.string().min(1),
  })).optional(),
});

// Stage 5 "structure": the LLM only names/summarizes sections + a board headline.
// It cannot mint nodes — section summaries become update_node patches, the
// headline seeds the streamed answer.
export const zStructure = z.object({
  headline: z.string(),
  sections: z.array(z.object({ entity: z.string(), summary: z.string() })).optional(),
});

// Gap-analysis output: what the evidence review says is still missing before the
// final report can answer decisively. Each gap is a ready-to-run lookup PAIR.
export const zGapPlan = z.object({
  sufficient: z.boolean(),
  rationale: z.string(),
  gaps: z.array(z.object({
    question: z.string().min(1),
    entity: z.string().min(1),
    metric: z.string().min(1),
    why: z.string(),
  })),
});
export type GapPlan = z.infer<typeof zGapPlan>;

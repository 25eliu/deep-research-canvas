import { z } from "zod";
import { zCanvasOps } from "../../schema";
import { GRAPH_ENTITY_SUBTYPES } from "./graph-subtypes";

// The composed answer report lives in schema.ts (it's a canvas-node field); re-export
// here so agent code has one import site for all agent schemas.
export { zAnswerBlock, zAnswerReport, zAnswerReportEmit, zGraphyBlock, zGraphyConfig } from "../../schema";
export type { AnswerBlock, AnswerReport } from "../../schema";

// The board-diff body every agent returns (before sanitize/relate/consensus).
export const zAgentBody = z.object({
  canvasOps: zCanvasOps,
  narration: z.string(),
  sideReply: z.string().nullable(),
});
export type AgentBody = z.infer<typeof zAgentBody>;

// Tako pipeline sub-steps
export const zQueries = z.object({ queries: z.array(z.string()) });

// Cohort resolution: a class-of-entities question ("emerging infrastructure startups")
// is answered per-MEMBER, never per-class. The members come ONLY from a grounded tako
// answer (never invented); min(1) so an empty extraction fails validation and the
// caller falls back to the ungrounded plan instead of proceeding with nobody.
export const zCohortMembers = z.object({
  entities: z.array(z.string().min(1)).min(1),
  rationale: z.string(),
});
export type CohortMembers = z.infer<typeof zCohortMembers>;

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


// Entity-first graph lookup carried by every research question: 1-3 COMPLETELY
// DIFFERENT candidate names the graph might register the SAME subject under
// ("Google", "Alphabet"), an optional entity-class filter for graph/search's
// `subtype` param (z.enum = the schema guarantee; .nullable().optional() because
// OpenAI strict structured outputs is off — see CLAUDE.md — and Zod + auto-retry
// enforce it instead), and 1-5 short substring filters for the related-metrics
// fetch's case-insensitive `q` param ("revenue", "sales", "margin") — a LIST of
// name-fragment variants, so one filter missing how a series is actually named
// doesn't blank the whole lookup.
const zLookup = {
  entities: z.array(z.string().min(1)).min(1).max(3),
  subtype: z.enum(GRAPH_ENTITY_SUBTYPES).nullable().optional(),
  metricFilters: z.array(z.string().min(1)).min(1).max(5),
};

// The plain-object shape of zLookup that flows through the pipeline (subtype
// normalized to undefined; strategy/flow/gaps all consume this).
export interface GraphLookup {
  entities: string[];
  subtype?: string;
  metricFilters: string[];
  // Pre-resolved graph node (e.g. a cohort-roster member): resolveGraph skips the
  // entity search and fans out metrics for exactly this node. Set ONLY by code —
  // never part of an LLM-facing Zod schema (ids must be un-hallucinatable).
  node?: { id: string; name: string };
}

// Recursive decompose step: the LLM decides whether a research question is atomic
// (fetch data directly) or should split into distinct sub-questions (branch).
// Every question — the plan itself and each sub-question — carries a validated
// entity-first lookup (zLookup above). A missing/empty half fails validation so
// generateObject retries instead of proceeding half-grounded.
export const zResearchPlan = z.object({
  atomic: z.boolean(),
  // 1-2 sentences: WHY this question is atomic or splits into these sub-questions.
  // Surfaced to the user as the "reasoning" step for this research node.
  rationale: z.string(),
  // The lookup for THIS question (leaf fetch / broad-view grounding).
  ...zLookup,
  // Set when the question's subject is a CLASS of entities ("emerging infrastructure
  // startups") rather than a nameable one — the caller resolves real members via a
  // grounded tako answer, then re-decomposes per member (root-level only).
  cohort: z.string().optional(),
  // Root only: the split itself depends on discovering CURRENT data (live drivers,
  // unknown current members/rankings) — the caller grounds via /v1/answer and re-plans.
  needsFreshContext: z.boolean().optional(),
  subQuestions: z.array(z.object({
    question: z.string(),
    rationale: z.string().optional(), // why this facet matters (optional per-sub reasoning)
    ...zLookup,
  })).optional(),
});

// The research lane's distilled plan: ONE researchable sub-question + the same
// entity-first lookup researchLeaf consumes (see zLookup docs above).
export const zComponentPlan = z.object({
  question: z.string().min(1),
  rationale: z.string(),
  ...zLookup,
});
export type ComponentPlan = z.infer<typeof zComponentPlan>;

// Stage 5 "structure": the LLM only names/summarizes sections + a board headline.
// It cannot mint nodes — section summaries become update_node patches, the
// headline seeds the streamed answer.
export const zStructure = z.object({
  headline: z.string(),
  sections: z.array(z.object({ entity: z.string(), summary: z.string() })).optional(),
});

// Gap-analysis output: what the evidence review says is still missing before the
// final report can answer decisively. Each gap is a ready-to-run entity-first lookup.
export const zGapPlan = z.object({
  sufficient: z.boolean(),
  rationale: z.string(),
  gaps: z.array(z.object({
    question: z.string().min(1),
    ...zLookup,
    why: z.string(),
  })),
});
export type GapPlan = z.infer<typeof zGapPlan>;

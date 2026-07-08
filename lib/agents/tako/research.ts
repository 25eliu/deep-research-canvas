// Recursive research engine. A question becomes a tree: at each node the LLM
// decides whether to DECOMPOSE into sub-questions (branch) or fetch data directly
// (leaf). A leaf pulls Tako findings and writes a mini-synthesis; a branch
// synthesizes over its children's syntheses ("consensus of consensus"). The root's
// synthesis is the main answer. Every node streams its synthesis live into its own
// canvas node (findings → leaf, child → parent, top → root, via feeds/derived_from).
import type { TakoCallRecord, GraphCallRecord } from "../shared/types";
import { generateStructured, streamAnswer } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zResearchPlan } from "../shared/schemas";
import type { Finding } from "./findings";
import {
  DECOMPOSE_SYSTEM, BRANCH_SYNTH_SYSTEM,
} from "./prompts";
import {
  SYNTH_ID, synthNode, researchNode, derivedEdge, toNodeSources, extractFigures,
  runSearches, firstSentence, researchLeaf, uniqueResearchId,
  type ResearchCtx, type ResearchResult,
} from "./flow";

export {
  SYNTH_ID, synthNode, newResearchCtx, toNodeSources,
} from "./flow";
export type { ResearchCtx, GatheredFigure, WebSource, ResearchResult } from "./flow";

const OPENAI = "openai" as const;

// Decomposition allows at most TWO levels. The root may split into distinct sub-questions,
// and a sub-question may split ONE more time — but ONLY when it genuinely contains 2+ SEPARATE
// subjects (e.g. "energy and gasoline prices" → energy, gasoline), never for adjacent metrics/
// facets of one subject. MAX_DEPTH=2 is the ceiling; the deepest level gets a strict "separate
// subjects only" brake (see decomposePrompt) so it can't spam the canvas with near-duplicates.
const MAX_DEPTH = 2;
const MAX_CHILDREN = 8; // safety ceiling on sub-questions per level — NOT a target; the prompt drives the real count (one per genuinely distinct facet)

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The pressure toward decomposition decays with depth: the top-level question is the most likely to
// warrant splitting; each level down leans harder toward atomic. This is the brake that stops recursive
// re-decomposition into near-duplicate sub-questions. Structured as a per-depth ladder so it stays correct
// if MAX_DEPTH is ever raised (higher depth → stronger atomic pressure).
export function depthLean(depth: number): string {
  if (depth === 0) {
    // Top level — lenient: lean TOWARD splitting anything that isn't already one pair.
    return `TOP-LEVEL — LEAN TOWARD SPLITTING: this is the user's overarching question. A research question` +
      ` can target ONE entity + ONE metric at a time, so DECOMPOSE anything that names more: every comparison,` +
      ` every "versus", basically every "and" — one sub-question per entity, per metric facet. Also split broad,` +
      ` multi-faceted questions into their distinct drivers. Stay atomic ONLY when the question is already a` +
      ` single entity + single metric lookup. The overarching/broad view is fetched by this parent — do NOT` +
      ` create a sub-question for the general/overview topic.`;
  }
  // Deeper level — atomic only once the question is down to one entity + one metric.
  return `DEEPER LEVEL: split this sub-question again ONLY if ITS OWN TEXT still names 2+ entities or` +
    ` 2+ metrics ("X vs Y", "X and Y" → one sub-question each). It is ATOMIC when exactly one entity + one` +
    ` metric remain ("energy prices" alone, "Nvidia revenue growth"). NEVER introduce an entity or metric` +
    ` this sub-question does not itself name — siblings already cover the rest of the parent question.` +
    ` Never split a single entity+metric pair further, and never reword the same pair twice. If in doubt, atomic.`;
}

function decomposePrompt(maxChildren: number, depth: number): string {
  const base = DECOMPOSE_SYSTEM.replace(/{MAX}/g, String(maxChildren));
  return `${base}\n${depthLean(depth)}`;
}

interface ResearchOpts { root: boolean; entities?: string[]; metrics?: string[] }

export async function research(question: string, depth: number, ctx: ResearchCtx, opts: ResearchOpts): Promise<ResearchResult> {
  const root = opts.root;
  const nodeId = root ? SYNTH_ID : uniqueResearchId(ctx, question);
  ctx.emit?.({ type: "trace", stage: depth === 0 ? "planning research" : `researching: ${question.slice(0, 60)}` });

  // ---- decide: branch or leaf ----
  let atomic = true;
  // Each (sub-)question carries a validated lookup PAIR (one entity term + one metric
  // term); downstream plumbing stays array-shaped, so the pair maps to 1-element arrays.
  let subs: { question: string; entities?: string[]; metrics?: string[] }[] = [];
  let entities = opts.entities ?? [];
  let metrics = opts.metrics ?? [];
  let rationale: string | undefined; // the LLM's reasoning for this node's plan
  const canBranch = depth < MAX_DEPTH && ctx.budget.researchNodes < ctx.budget.maxNodes;
  if (canBranch) {
    const maxChildren = MAX_CHILDREN;
    const t = Date.now();
    try {
      const plan = await generateStructured({
        provider: OPENAI, system: decomposePrompt(maxChildren, depth),
        prompt: `${ctxBlock(ctx.req)}\n\nRESEARCH_QUESTION: ${question}`, schema: zResearchPlan, label: "decompose",
      });
      atomic = plan.atomic || !plan.subQuestions?.length;
      // Deterministic re-split brake: a sub-question that merely restates THIS question
      // (the model sometimes re-splits a sub-question into itself + an invented sibling)
      // is dropped; if fewer than 2 genuine subs remain, the node stays a leaf.
      subs = (plan.subQuestions ?? [])
        .filter((s) => s.question.trim().toLowerCase() !== question.trim().toLowerCase())
        .slice(0, maxChildren)
        .map((s) => ({ question: s.question, entities: [s.entity], metrics: [s.metric] }));
      rationale = plan.rationale;
      if (plan.entity) entities = [plan.entity];
      if (plan.metric) metrics = [plan.metric];
    } catch (e: unknown) {
      ctx.notes.push(`decompose failed — ${errorMessage(e)}`);
    }
    ctx.timings.decompose = Math.max(ctx.timings.decompose, Date.now() - t);
  }

  const willBranch = !atomic && subs.length >= 2
    && ctx.budget.researchNodes + subs.length <= ctx.budget.maxNodes;

  // Live reasoning step: one per research node, once the branch/leaf decision is final.
  ctx.emit?.({
    type: "reasoning", nodeId, depth, question,
    kind: willBranch ? "branch" : "leaf",
    rationale,
    entities: entities.length ? entities : undefined,
    metrics: metrics.length ? metrics : undefined,
    subQuestions: willBranch ? subs.map((s) => s.question) : undefined,
  });
  if (rationale) ctx.reasoning.push({ nodeId, question, rationale }); // survives pruning

  if (!willBranch) return researchLeaf(question, depth, nodeId, root, ctx, entities, metrics, rationale);

  // ---- branch ----
  ctx.budget.researchNodes += subs.length; // reserve before recursing so siblings can't overshoot
  if (!root) ctx.push([{ op: "add_node", node: researchNode(nodeId, question, "") }]);

  const kids = await Promise.all(
    subs.map((s) => research(s.question, depth + 1, ctx, { root: false, entities: s.entities ?? [], metrics: s.metrics ?? [] })),
  );
  const live = kids.filter((k) => k.nodeId && (k.findingCount > 0 || k.children.length > 0));

  // Whole subtree came back empty → fetch directly instead of an empty branch.
  if (live.length === 0) return researchLeaf(question, depth, nodeId, root, ctx, entities, metrics, rationale);

  ctx.push(live.map((k) => derivedEdge(k.nodeId!, nodeId))); // children feed this node

  // The overarching (root) agent owns the BROAD view: it fetches the overview data
  // itself so sub-agents don't each re-fetch the general graph.
  const children = live.map((k) => k.nodeId!);

  // Root: fetch the broad view, then DEFER — the composed answer report (Claude,
  // at the end) is the answer; no streamed root prose.
  if (root) {
    ctx.push([{ op: "add_node", node: synthNode("", "") }]);
    const bf = await broadFetch(question, nodeId, ctx, entities, metrics);
    ctx.figures.push(...extractFigures(bf.findings));
    ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: bf.findings.length, children, queries: bf.queries, rationale, entities, metrics: bf.metrics ?? metrics, graph: bf.graph, calls: bf.calls, graphCalls: bf.graphCalls, graphMs: bf.graphMs });
    return { nodeId, title: question, synthesis: "", findingCount: bf.findings.length, children, depth, kind: "branch" };
  }

  // Non-root branch: reconcile its children's mini-answers into a sub-answer.
  const menu = live.map((k) => ({ q: k.title, answer: k.synthesis }));
  ctx.emit?.({ type: "synthesis", phase: "start", nodeId, kind: "branch", inputs: { fromNodeIds: children } });
  const t = Date.now();
  const prose = await streamAnswer({
    provider: OPENAI, system: BRANCH_SYNTH_SYSTEM,
    prompt: `${ctxBlock(ctx.req)}\n\nCHILDREN: ${JSON.stringify(menu)}`,
    label: "branch-synth",
    onToken: (c) => ctx.emit?.({ type: "token", text: c, nodeId }),
  });
  ctx.timings.stream = Math.max(ctx.timings.stream, Date.now() - t);
  ctx.emit?.({ type: "synthesis", phase: "end", nodeId, kind: "branch" });

  const claim = firstSentence(prose);
  ctx.branchResults.push({ question, claim, confidence: 0.75, figures: [] });
  // A branch's "see sources" = the union of its children's web sources.
  const childSources = children.flatMap((id) => ctx.sourcesByNode.get(id) ?? []);
  ctx.sourcesByNode.set(nodeId, childSources);
  const branchSources = toNodeSources(childSources);
  ctx.push([{ op: "update_node", id: nodeId, patch: {
    summary: prose, title: question,
    ...(branchSources.length ? { sources: branchSources } : {}),
  } }]);
  ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: 0, children, rationale, entities, metrics });
  return { nodeId, title: question, synthesis: prose, findingCount: 0, children, depth, kind: "branch", claim, confidence: 0.75 };
}

// The root's broad/overview fetch: 1-2 high-level queries whose cards attach to
// the synth node, so the overarching answer is grounded in the general view.
async function broadFetch(
  question: string, nodeId: string, ctx: ResearchCtx, entities: string[], metrics: string[],
): Promise<{ findings: Finding[]; queries: string[]; calls: TakoCallRecord[]; graph: { entity: string; related: string[] }[]; metrics?: string[]; graphCalls?: GraphCallRecord[]; graphMs?: number }> {
  const { queries, graph, metrics: planMetrics, graphCalls, graphMs } = await ctx.strategy.broadQueries(ctx, question, entities, metrics);
  ctx.queries.push(...queries);

  // Broad chart cards feed the synth; broad web sources are filtered into ctx.webSources.
  const { dataFindings, calls } = await runSearches(question, nodeId, queries, ctx);
  return { findings: dataFindings, queries, calls, graph, metrics: planMetrics, graphCalls, graphMs };
}

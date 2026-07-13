// Recursive research engine. A question becomes a tree: at each node the LLM
// decides whether to DECOMPOSE into sub-questions (branch) or fetch data directly
// (leaf). A leaf pulls Tako findings and writes a mini-synthesis; a branch
// synthesizes over its children's syntheses ("consensus of consensus"). The root's
// synthesis is the main answer. Every node streams its synthesis live into its own
// canvas node (findings → leaf, child → parent, top → root, via feeds/derived_from).
import type { TakoCallRecord, GraphCallRecord } from "../shared/types";
import { generateStructured, streamAnswer } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zResearchPlan, zCohortMembers, type GraphLookup } from "../shared/schemas";
import { takoAnswer, type TakoCard } from "../../tako";
import type { Finding } from "./findings";
import type { CohortRoster, RosterGroup, RosterMember } from "./strategy";
import {
  DECOMPOSE_SYSTEM, BRANCH_SYNTH_SYSTEM, COHORT_RESOLVE_SYSTEM,
} from "./prompts";
import {
  SYNTH_ID, synthNode, researchNode, derivedEdge, feedsEdge, toNodeSources, extractFigures,
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
    // Top level — lenient: lean TOWARD splitting anything that isn't already one subject+measure.
    return `TOP-LEVEL — LEAN TOWARD SPLITTING: this is the user's overarching question. A research question` +
      ` can target ONE subject + ONE measure at a time, so DECOMPOSE anything that names more: every comparison,` +
      ` every "versus", basically every "and" — one sub-question per subject, per measure facet. Also split broad,` +
      ` multi-faceted questions into their distinct drivers. Stay atomic ONLY when the question is already a` +
      ` single subject + single measure lookup. The overarching/broad view is fetched by this parent — do NOT` +
      ` create a sub-question for the general/overview topic.`;
  }
  // Deeper level — atomic only once the question is down to one subject + one measure.
  return `DEEPER LEVEL: split this sub-question again ONLY if ITS OWN TEXT still names 2+ subjects or` +
    ` 2+ measures ("X vs Y", "X and Y" → one sub-question each). It is ATOMIC when exactly one subject + one` +
    ` measure remain ("energy prices" alone, "Nvidia revenue growth"). NEVER introduce a subject or measure` +
    ` this sub-question does not itself name — siblings already cover the rest of the parent question.` +
    ` Never split a single subject+measure lookup further, and never reword the same lookup twice. If in doubt, atomic.`;
}

function decomposePrompt(maxChildren: number, depth: number): string {
  const base = DECOMPOSE_SYSTEM.replace(/{MAX}/g, String(maxChildren));
  return `${base}\n${depthLean(depth)}`;
}

const COHORT_MEMBER_CAP = 6;
const ANSWER_EXCERPT = 3000; // chars of the tako answer prose handed to decompose / the cohort resolver

export interface GroundedAnswer { answer: string; cards: TakoCard[] }

// Ground a question with a real tako answer (/v1/answer prose + cards) BEFORE
// planning: the answer feeds the decompose prompt, and its cards land on the board
// as broad evidence for the synth node. Returns null on ANY failure or when the
// answer came back empty — grounding may never kill the turn.
async function groundWithAnswer(ctx: ResearchCtx, question: string): Promise<GroundedAnswer | null> {
  ctx.emit?.({ type: "trace", stage: "grounding question via tako answer" });
  try {
    const t0 = Date.now();
    const { answer, cards } = await takoAnswer(question, { effort: "fast" });
    const call: TakoCallRecord = {
      callId: `${SYNTH_ID}:answer:${ctx.calls.length}`, nodeId: SYNTH_ID,
      query: question, endpoint: "/v1/answer", effort: "fast", ms: Date.now() - t0,
      cards: cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
    };
    ctx.calls.push(call);
    ctx.emit?.({ type: "tako_call", call });

    // The answer's cards are real grounded evidence — node them onto the broad view.
    for (const c of cards) {
      const f = ctx.ledger.add(c, SYNTH_ID);
      if (f && f.kind === "data_card") {
        ctx.push([{ op: "add_node", node: ctx.ledger.toNode(f) }, feedsEdge(f.nodeId, SYNTH_ID)]);
      }
    }
    if (!answer && cards.length === 0) {
      ctx.notes.push(`answer grounding found no evidence for "${question.slice(0, 80)}"`);
      return null;
    }
    ctx.answerGrounded = true;
    return { answer, cards };
  } catch (e: unknown) {
    ctx.notes.push(`answer grounding failed — ${errorMessage(e)}`);
    return null;
  }
}

// The decompose-prompt block carrying the grounded answer ("" when ungrounded).
function groundedBlock(grounded: GroundedAnswer | null): string {
  if (!grounded) return "";
  return `\n\nGROUNDED_ANSWER: ${grounded.answer.slice(0, ANSWER_EXCERPT)}\n\nCARD_TITLES: ${JSON.stringify(grounded.cards.map((c) => c.title))}`;
}

// Resolve an entity CLASS into concrete member names from the root's grounded tako
// answer. Returns null on ANY failure — the caller proceeds with the ungrounded
// plan; cohort resolution may never kill the turn.
async function resolveCohort(ctx: ResearchCtx, question: string, cohort: string, grounded: GroundedAnswer): Promise<string[] | null> {
  ctx.emit?.({ type: "trace", stage: `resolving cohort: ${cohort.slice(0, 50)}` });
  try {
    const members = await generateStructured({
      provider: OPENAI, system: COHORT_RESOLVE_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nCOHORT: ${cohort}\n\nGROUNDED_ANSWER: ${grounded.answer.slice(0, ANSWER_EXCERPT)}\n\nCARD_TITLES: ${JSON.stringify(grounded.cards.map((c) => c.title))}`,
      schema: zCohortMembers, label: "cohort-resolve",
    });
    const names = members.entities.slice(0, COHORT_MEMBER_CAP);
    ctx.notes.push(`cohort "${cohort}" resolved to: ${names.join(", ")} — ${members.rationale}`);
    return names;
  } catch (e: unknown) {
    ctx.notes.push(`cohort resolution failed — ${errorMessage(e)}`);
    return null;
  }
}

interface ResearchOpts { root: boolean; lookup?: GraphLookup }

// Normalize a plan/sub-question's lookup fields into the pipeline's GraphLookup shape
// (subtype null → undefined; the schema guarantees the arrays are 1-3 non-empty strings).
function toLookup(p: { entities: string[]; subtype?: string | null; metricFilters: string[] }): GraphLookup {
  return { entities: p.entities, ...(p.subtype ? { subtype: p.subtype } : {}), metricFilters: p.metricFilters };
}

// CI match of a sub-question's candidate entities against a roster member's
// name/aliases — how LLM-returned verbatim names become node ids (the LLM never
// sees or emits ids; an unmatched name survives as a plain name-only lookup).
function matchMember(entities: string[], groups: RosterGroup[]): { member: RosterMember; group: RosterGroup } | null {
  const wanted = entities.map((e) => e.trim().toLowerCase());
  for (const group of groups) {
    for (const member of group.members) {
      const names = [member.name, ...member.aliases].map((s) => s.trim().toLowerCase());
      if (wanted.some((w) => w && names.includes(w))) return { member, group };
    }
  }
  return null;
}

// Attach roster node ids to the second-pass subs (new objects — no mutation),
// infer the chosen group (most member matches; tie → overview order), and drill
// the full roster into a note when the group is bigger than its inline members.
async function groundSubsWithRoster(
  ctx: ResearchCtx, subs: { question: string; lookup: GraphLookup }[], roster: CohortRoster,
): Promise<{ question: string; lookup: GraphLookup }[]> {
  const matches = new Map<string, number>();
  const grounded = subs.map((s) => {
    const hit = matchMember(s.lookup.entities, roster.groups);
    if (!hit) return s;
    matches.set(hit.group.key, (matches.get(hit.group.key) ?? 0) + 1);
    return { ...s, lookup: { ...s.lookup, node: { id: hit.member.id, name: hit.member.name } } };
  });
  let chosen: RosterGroup | null = null;
  for (const g of roster.groups) {
    const n = matches.get(g.key) ?? 0;
    if (n > 0 && n > (chosen ? matches.get(chosen.key) ?? 0 : 0)) chosen = g;
  }
  if (chosen) {
    ctx.notes.push(`cohort grounded to graph group "${chosen.label}" (${chosen.totalCapped ? ">" : ""}${chosen.total} members) on ${roster.anchor.name}`);
    if (chosen.total > chosen.members.length) {
      try {
        const full = await roster.expand(chosen.key);
        if (full.length) ctx.notes.push(`full "${chosen.label}" roster (${full.length}): ${full.slice(0, 40).map((m) => m.name).join(", ")}`);
      } catch (e: unknown) {
        ctx.notes.push(`cohort roster drill failed — ${errorMessage(e)}`);
      }
    }
  }
  return grounded;
}

export async function research(question: string, depth: number, ctx: ResearchCtx, opts: ResearchOpts): Promise<ResearchResult> {
  const root = opts.root;
  const nodeId = root ? SYNTH_ID : uniqueResearchId(ctx, question);
  ctx.emit?.({ type: "trace", stage: depth === 0 ? "planning research" : `researching: ${question.slice(0, 60)}` });

  // ---- decide: branch or leaf ----
  let atomic = true;
  // Each (sub-)question carries a validated entity-first lookup (candidate names +
  // optional subtype + metric substring filters).
  let subs: { question: string; lookup: GraphLookup }[] = [];
  let lookup: GraphLookup = opts.lookup ?? { entities: [], metricFilters: [] };
  let rationale: string | undefined; // the LLM's reasoning for this node's plan
  let cohortGraphCalls: GraphCallRecord[] = []; // roster's graph calls → root tree entry (trace drill-down)
  const canBranch = depth < MAX_DEPTH && ctx.budget.researchNodes < ctx.budget.maxNodes;
  if (canBranch) {
    const maxChildren = MAX_CHILDREN;
    // Deterministic re-split brake: a sub-question that merely restates THIS question
    // (the model sometimes re-splits a sub-question into itself + an invented sibling)
    // is dropped; if fewer than 2 genuine subs remain, the node stays a leaf.
    const toSubs = (plan: { subQuestions?: { question: string; entities: string[]; subtype?: string | null; metricFilters: string[] }[] }) =>
      (plan.subQuestions ?? [])
        .filter((s) => s.question.trim().toLowerCase() !== question.trim().toLowerCase())
        .slice(0, maxChildren)
        .map((s) => ({ question: s.question, lookup: toLookup(s) }));
    // Every ROOT decompose is grounded by a real tako answer first: the plan chooses
    // entities/metrics/facets from evidence Tako demonstrably has, not from the question
    // text alone. Gated by the same takoAnswerEnabled kill-switch as the follow-up path.
    const grounded = (root && ctx.req.takoAnswerEnabled !== false)
      ? await groundWithAnswer(ctx, question) : null;
    const t = Date.now();
    try {
      const basePrompt = `${ctxBlock(ctx.req)}\n\nRESEARCH_QUESTION: ${question}${groundedBlock(grounded)}`;
      // A schema-invalid response THROWS (generateObject does not self-heal on
      // validation failure — observed with cohort questions omitting the required
      // lookup fields). One corrective retry with the violation named keeps a
      // flubbed plan from degrading the whole turn to an empty board.
      const decomposeCall = async (extra = "") => {
        try {
          return await generateStructured({
            provider: OPENAI, system: decomposePrompt(maxChildren, depth),
            prompt: `${basePrompt}${extra}`,
            schema: zResearchPlan, label: "decompose",
          });
        } catch (e: unknown) {
          ctx.notes.push(`decompose returned an invalid plan — retrying once (${errorMessage(e).slice(0, 100)})`);
          return await generateStructured({
            provider: OPENAI, system: decomposePrompt(maxChildren, depth),
            prompt: `${basePrompt}${extra}\n\nSCHEMA_REMINDER: Your previous response did not match the required schema.` +
              ` EVERY plan must include entities (1-3 candidate name strings — for a class question use the class` +
              ` phrase and/or the question's geography/market) AND metricFilters (1-5 short metric-name fragments),` +
              ` plus atomic and rationale; each subQuestion carries the same entities/subtype/metricFilters fields.`,
            schema: zResearchPlan, label: "decompose",
          });
        }
      };
      let plan = await decomposeCall();
      // Class-of-entities question: FIRST try the graph — the anchor's relation
      // groups enumerate real members with node ids (exhaustive, un-hallucinatable).
      // Fall back to extracting members from the grounded answer's prose only when
      // the graph has nothing (no anchor node, no cohort-shaped groups, provider
      // without a graph). Root-only; a failed second pass keeps the FIRST plan.
      let roster: CohortRoster | null = null;
      if (root && plan.cohort) {
        roster = plan.entities?.length
          ? (await ctx.strategy.cohortRoster?.(ctx, plan.cohort, toLookup(plan), nodeId)) ?? null
          : null;
        if (roster) cohortGraphCalls = roster.graphCalls;
        if (roster) {
          const promptGroups = roster.groups.map((g) => ({
            label: g.label, total: g.totalCapped ? `>${g.total}` : g.total,
            members: g.members.map((m) => m.name),
          }));
          try {
            plan = await decomposeCall(`\n\nCOHORT_GROUPS: ${JSON.stringify(promptGroups)}`);
          } catch (e: unknown) {
            roster = null; // second pass failed — don't ground subs against it
            ctx.notes.push(`cohort graph second-pass decompose failed — proceeding with the first plan (${errorMessage(e).slice(0, 80)})`);
          }
        } else if (grounded) {
          const members = await resolveCohort(ctx, question, plan.cohort, grounded);
          if (members?.length) {
            try {
              plan = await decomposeCall(`\n\nCOHORT_MEMBERS: ${JSON.stringify(members)}`);
            } catch (e: unknown) {
              ctx.notes.push(`cohort second-pass decompose failed — proceeding with the first plan (${errorMessage(e).slice(0, 80)})`);
            }
          }
        }
      }
      // Unresolvable cohort (no grounding, resolution failed/empty, or a misapplied
      // cohort on a question that names its own subjects): a silent leaf here left
      // the gap round doing the real research. Re-plan ONCE from the question text;
      // adopt the re-plan only when it's usable (a real split or a concrete lookup).
      if (plan.cohort && toSubs(plan).length === 0) {
        ctx.notes.push(`cohort "${plan.cohort.slice(0, 50)}" could not be resolved — re-planning from the question text`);
        try {
          const replanned = await decomposeCall(
            `\n\nCOHORT_UNAVAILABLE: Member resolution is unavailable this turn — do NOT set cohort. If the` +
            ` question itself names its subjects, split into one sub-question per named subject; otherwise` +
            ` split into the question's canonical facets — or return atomic:true with the best concrete lookup.`,
          );
          if (!replanned.cohort && (toSubs(replanned).length >= 2 || replanned.entities?.length)) plan = replanned;
        } catch (e: unknown) {
          ctx.notes.push(`cohort re-plan failed — proceeding with the original plan (${errorMessage(e).slice(0, 80)})`);
        }
      }
      subs = toSubs(plan);
      if (roster && subs.length) subs = await groundSubsWithRoster(ctx, subs, roster);
      // Split-intent guard: a plan that DECLARES a split (atomic:false, no cohort signal)
      // but returns no/1 sub-questions would silently collapse to a leaf — the observed
      // "What's driving inflation?" failure. One corrective retry naming the violation;
      // if it persists, fall through to the leaf (which keeps the top-level lookup).
      if (!plan.atomic && !plan.cohort && subs.length < 2) {
        ctx.notes.push(`decompose declared a split without sub-questions — retrying once`);
        // A failed correction keeps the original plan (leaf with its lookup) —
        // it must not take down the node.
        try {
          const corrected = await generateStructured({
            provider: OPENAI, system: decomposePrompt(maxChildren, depth),
            prompt: `${basePrompt}\n\nCORRECTION: Your previous plan set atomic:false ("${plan.rationale.slice(0, 200)}")` +
              ` but returned ${plan.subQuestions?.length ?? 0} subQuestions, which is INVALID. Return the split's` +
              ` subQuestions (2 to ${maxChildren}, one per facet, each with its own entities/subtype/metricFilters,` +
              ` each question different from the RESEARCH_QUESTION itself) — or atomic:true if the question` +
              ` genuinely is one subject + one measure.`,
            schema: zResearchPlan, label: "decompose",
          });
          const correctedSubs = toSubs(corrected);
          if (correctedSubs.length >= 2 || corrected.atomic) {
            plan = corrected;
            subs = correctedSubs;
          }
        } catch (e: unknown) {
          ctx.notes.push(`decompose correction failed — ${errorMessage(e).slice(0, 80)}`);
        }
        if (!plan.atomic && subs.length < 2) {
          ctx.notes.push(`decompose split-intent unresolved — proceeding as leaf`);
        }
      }
      // Trust the subs over the flag: 2+ genuine sub-questions ARE the split (a
      // contradictory atomic:true must not discard the decomposition work); fewer
      // than 2 is a leaf regardless of what the flag claims.
      atomic = subs.length < 2;
      rationale = plan.rationale;
      if (plan.entities?.length) lookup = toLookup(plan);
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
    entities: lookup.entities.length ? lookup.entities : undefined,
    subtype: lookup.subtype,
    metrics: lookup.metricFilters.length ? lookup.metricFilters : undefined,
    subQuestions: willBranch ? subs.map((s) => s.question) : undefined,
  });
  if (rationale) ctx.reasoning.push({ nodeId, question, rationale }); // survives pruning

  if (!willBranch) return researchLeaf(question, depth, nodeId, root, ctx, lookup, rationale);

  // ---- branch ----
  ctx.budget.researchNodes += subs.length; // reserve before recursing so siblings can't overshoot
  if (!root) ctx.push([{ op: "add_node", node: researchNode(nodeId, question, "") }]);

  const kids = await Promise.all(
    subs.map((s) => research(s.question, depth + 1, ctx, { root: false, lookup: s.lookup })),
  );
  const live = kids.filter((k) => k.nodeId && (k.findingCount > 0 || k.children.length > 0));

  // Whole subtree came back empty → fetch directly instead of an empty branch.
  if (live.length === 0) {
    ctx.notes.push(`all ${subs.length} sub-questions found nothing — refetching "${question.slice(0, 60)}" as a single leaf`);
    return researchLeaf(question, depth, nodeId, root, ctx, lookup, rationale);
  }

  ctx.push(live.map((k) => derivedEdge(k.nodeId!, nodeId))); // children feed this node

  // The overarching (root) agent owns the BROAD view: it fetches the overview data
  // itself so sub-agents don't each re-fetch the general graph.
  const children = live.map((k) => k.nodeId!);

  // Root: fetch the broad view, then DEFER — the composed answer report (Claude,
  // at the end) is the answer; no streamed root prose.
  if (root) {
    ctx.push([{ op: "add_node", node: synthNode("", "") }]);
    const bf = await broadFetch(question, nodeId, ctx, lookup);
    ctx.figures.push(...extractFigures(bf.findings));
    ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: bf.findings.length, children, queries: bf.queries, rationale, entities: lookup.entities, subtype: lookup.subtype, metrics: bf.metrics ?? lookup.metricFilters, graph: bf.graph, calls: bf.calls, graphCalls: [...cohortGraphCalls, ...(bf.graphCalls ?? [])], graphMs: bf.graphMs });
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
  ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: 0, children, rationale, entities: lookup.entities, subtype: lookup.subtype, metrics: lookup.metricFilters });
  return { nodeId, title: question, synthesis: prose, findingCount: 0, children, depth, kind: "branch", claim, confidence: 0.75 };
}

// The root's broad/overview fetch: 1-2 high-level queries whose cards attach to
// the synth node, so the overarching answer is grounded in the general view.
async function broadFetch(
  question: string, nodeId: string, ctx: ResearchCtx, lookup: GraphLookup,
): Promise<{ findings: Finding[]; queries: string[]; calls: TakoCallRecord[]; graph: { entity: string; related: string[] }[]; metrics?: string[]; graphCalls?: GraphCallRecord[]; graphMs?: number }> {
  const { queries, graph, metrics: planMetrics, graphCalls, graphMs } = await ctx.strategy.broadQueries(ctx, question, lookup, nodeId);
  ctx.queries.push(...queries);

  // Broad chart cards feed the synth; broad web sources are filtered into ctx.webSources.
  const { dataFindings, calls } = await runSearches(question, nodeId, queries, ctx);
  return { findings: dataFindings, queries, calls, graph, metrics: planMetrics, graphCalls, graphMs };
}

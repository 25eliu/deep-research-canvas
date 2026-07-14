// Recursive research engine. A question becomes a tree: at each node the LLM
// decides whether to DECOMPOSE into sub-questions (branch) or fetch data directly
// (leaf). A leaf pulls Tako findings and writes a mini-synthesis; a branch
// synthesizes over its children's syntheses ("consensus of consensus"). The root's
// synthesis is the main answer. Every node streams its synthesis live into its own
// canvas node (findings → leaf, child → parent, top → root, via feeds/derived_from).
import type { TakoCallRecord, GraphCallRecord } from "../shared/types";
import { generateStructured, streamAnswer } from "../../llm";
import { zResearchPlan, zCohortMembers, type GraphLookup } from "../shared/schemas";
import { takoAnswer, type TakoCard } from "../../tako";
import {
  DECOMPOSE_SYSTEM, BRANCH_SYNTH_SYSTEM, COHORT_RESOLVE_SYSTEM,
} from "./prompts";
import {
  SYNTH_ID, synthNode, researchNode, derivedEdge, toNodeSources,
  firstSentence, researchLeaf, uniqueResearchId,
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
const MAX_CHILDREN = 6; // safety ceiling on sub-questions per level — NOT a target; the prompt drives the real count (one per genuinely distinct facet). Matches COHORT_MEMBER_CAP so member coverage is never the constraint.

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The pressure toward decomposition decays with depth: the top-level question is the most likely to
// warrant splitting; each level down leans harder toward atomic. This is the brake that stops recursive
// re-decomposition into near-duplicate sub-questions. Structured as a per-depth ladder so it stays correct
// if MAX_DEPTH is ever raised (higher depth → stronger atomic pressure).
export function depthLean(depth: number): string {
  if (depth === 0) {
    // Top level — decomposition is the DEFAULT: nearly every top-level question splits;
    // the brake is on OVERLAP and padding, not on covering the question's real facets.
    return `TOP-LEVEL — DECOMPOSITION IS THE DEFAULT: this is the user's overarching question; expect to` +
      ` return atomic:false with 2+ facet sub-questions for nearly every question, and before answering` +
      ` atomic, actively LOOK for the question's distinct facets. DECOMPOSE multi-subject questions — every` +
      ` comparison, every "versus": one sub-question per DISTINCT subject — and single-subject broad/` +
      ` multi-faceted questions ("research X", "how is X doing", "what's driving X") into their distinct` +
      ` facets/drivers. Do not drop a real facet the answer needs; just don't over-split: each sub-question` +
      ` must be SPECIFIC and cover a surface NO sibling covers (typically 2-5 subs), and closely-related` +
      ` measures of one subject fold into one sub-question's metricFilters instead of splitting. Atomic is` +
      ` legitimate ONLY for a genuinely single-lookup question — one subject + one measure and nothing else` +
      ` asked ("Nvidia's current stock price"). The overarching/broad view` +
      ` is fetched by this parent — do NOT create a sub-question for the general/overview topic.`;
  }
  // Deeper level — atomic only once the question is down to one subject + one measure.
  return `DEEPER LEVEL: split this sub-question again ONLY if ITS OWN TEXT still names 2+ subjects or` +
    ` 2+ measures — and then the split is an EXACT PARTITION of its own text: one sub-question per named` +
    ` component and NOTHING ELSE ("production and sales figures" → production / sales — NEVER a third sub` +
    ` that recombines, paraphrases, or summarizes the components, like "production and sales trends").` +
    ` It is ATOMIC when exactly one subject + one measure remain ("energy prices" alone, "Nvidia revenue` +
    ` growth"). NEVER introduce a subject or measure this sub-question does not itself name — siblings` +
    ` already cover the rest of the parent question. Never split a single subject+measure lookup further,` +
    ` and never reword the same lookup twice. If in doubt, atomic.`;
}

function decomposePrompt(maxChildren: number, depth: number): string {
  const base = DECOMPOSE_SYSTEM.replace(/{MAX}/g, String(maxChildren));
  return `${base}\n${depthLean(depth)}`;
}

// Normalized token set for near-duplicate detection ("What's driving inflation?" ≈
// "what is driving inflation") — lowercase, alphanumerics only.
function questionTokens(q: string): Set<string> {
  return new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean));
}

// Token-set Jaccard similarity — 1.0 when two questions are word-for-word rewordings.
export function questionOverlap(a: string, b: string): number {
  const ta = questionTokens(a), tb = questionTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

// Deterministic near-duplicate brakes for LLM-returned sub-questions. Deliberately
// strict thresholds: they catch REWORDINGS (punctuation/contraction/minor word swaps),
// not semantic overlap — judging "shelter costs" vs "housing costs" is the decompose
// prompt's cumulative-contribution check, not string similarity's.
const PARENT_RESTATE_THRESHOLD = 0.95; // sub ≈ the question being split → re-researches the parent, drop
const SIBLING_DUP_THRESHOLD = 0.9; // sub ≈ an earlier sibling → the same lookup twice, drop

const COHORT_MEMBER_CAP = 6;
const ANSWER_EXCERPT = 3000; // chars of the tako answer prose handed to decompose / the cohort resolver

export interface GroundedAnswer { answer: string; cards: TakoCard[] }

// Ground a question with a real WEB-sourced tako answer (/v1/answer with sources.web
// → current-article prose + web cards) so the DECOMPOSE prompt / cohort resolver can
// plan from up-to-date evidence. Called lazily, ONLY when the planner asked for fresh
// context (needsFreshContext) or the plan is a cohort — never unconditionally. Web is
// deliberate: the whole point of grounding is to discover the real sub-question
// subjects (a cohort's member companies) from CURRENT articles, not from whatever
// entity happens to hold a structured card. The result feeds the decompose prompt alone
// (GROUNDED_ANSWER + CARD_TITLES); its cards are NOT noded onto the board — the
// synthesis node's evidence comes from the research tree, not from planning aids.
// Returns null on ANY failure or when the answer came back empty — grounding may
// never kill the turn.
async function groundWithAnswer(ctx: ResearchCtx, question: string, nodeId: string = ctx.rootId): Promise<GroundedAnswer | null> {
  ctx.emit?.({ type: "trace", stage: "grounding the research plan via tako answer" });
  try {
    const t0 = Date.now();
    // web:true — grounding must plan from CURRENT ARTICLES, not the structured-data
    // default (which over-weights whatever entity holds a Tako card and mis-grounds
    // cohort discovery). See takoAnswer's web note.
    const { answer, cards } = await takoAnswer(question, { effort: "fast", web: true });
    const call: TakoCallRecord = {
      callId: `${nodeId}:answer:${ctx.calls.length}`, nodeId,
      query: question, endpoint: "/v1/answer", effort: "fast", ms: Date.now() - t0,
      cards: cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
    };
    ctx.calls.push(call);
    ctx.emit?.({ type: "tako_call", call });
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
      prompt: `${ctx.ctxText}\n\nQUESTION: ${question}\n\nCOHORT: ${cohort}\n\nGROUNDED_ANSWER: ${grounded.answer.slice(0, ANSWER_EXCERPT)}\n\nCARD_TITLES: ${JSON.stringify(grounded.cards.map((c) => c.title))}`,
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

// siblings = the OTHER sub-questions of this node's parent: the deeper decompose is
// told (and deterministically checked) not to re-answer or re-split into surfaces a
// sibling researcher already owns — without it, a child re-reads the broad user
// message from the context block and criss-crosses into its siblings' topics.
interface ResearchOpts { root: boolean; lookup?: GraphLookup; siblings?: string[] }

// Normalize a plan/sub-question's lookup fields into the pipeline's GraphLookup shape
// (label null → undefined; the schema guarantees the arrays are 1-3 non-empty strings).
function toLookup(p: { entities: string[]; label?: string | null; metricFilters: string[] }): GraphLookup {
  return { entities: p.entities, ...(p.label ? { label: p.label } : {}), metricFilters: p.metricFilters };
}

export async function research(question: string, depth: number, ctx: ResearchCtx, opts: ResearchOpts): Promise<ResearchResult> {
  const startedAt = Date.now(); // this node's whole wall-clock (decompose + subtree/leaf work)
  const root = opts.root;
  const nodeId = root ? ctx.rootId : uniqueResearchId(ctx, question);
  ctx.emit?.({ type: "trace", stage: depth === 0 ? "planning research" : `researching: ${question.slice(0, 60)}` });

  // ---- decide: branch or leaf ----
  let atomic = true;
  // Each (sub-)question carries a validated entity-first lookup (candidate names +
  // optional NER label + metric substring filters).
  let subs: { question: string; lookup: GraphLookup }[] = [];
  let lookup: GraphLookup = opts.lookup ?? { entities: [], metricFilters: [] };
  let rationale: string | undefined; // the LLM's reasoning for this node's plan
  const canBranch = depth < MAX_DEPTH && ctx.budget.researchNodes < ctx.budget.maxNodes;
  if (canBranch) {
    const maxChildren = MAX_CHILDREN;
    // Deterministic re-split brakes: a sub-question that merely restates THIS question
    // (the model sometimes re-splits a sub-question into itself + an invented sibling)
    // or rewords an earlier sibling is dropped; if fewer than 2 genuine subs remain,
    // the node stays a leaf.
    const toSubs = (plan: { subQuestions?: { question: string; entities: string[]; label?: string | null; metricFilters: string[] }[] }) => {
      const kept: { question: string; lookup: GraphLookup }[] = [];
      for (const s of plan.subQuestions ?? []) {
        if (kept.length >= maxChildren) break;
        if (questionOverlap(s.question, question) >= PARENT_RESTATE_THRESHOLD) continue;
        if (kept.some((k) => questionOverlap(s.question, k.question) >= SIBLING_DUP_THRESHOLD)) continue;
        // A grandchild that rewords one of THIS node's siblings re-researches a lane
        // another researcher already owns.
        if (opts.siblings?.some((sib) => questionOverlap(s.question, sib) >= SIBLING_DUP_THRESHOLD)) continue;
        kept.push({ question: s.question, lookup: toLookup(s) });
      }
      return kept;
    };
    // The split decision comes FIRST: the root decomposes from the question text
    // alone. Grounding (/v1/answer) runs lazily AFTER the first plan, and only when
    // the planner asked for fresh context or cohort resolution needs the fallback —
    // its result feeds a decompose re-plan, nothing else. Gated by the same
    // takoAnswerEnabled kill-switch as the follow-up path.
    const canGround = root && ctx.req.takoAnswerEnabled !== false;
    // Cohort resolution grounds at ANY depth (the multi-sector example splits into
    // per-sector sub-questions, each itself a cohort) — so its grounding gate is NOT
    // root-scoped, only the takoAnswerEnabled kill-switch.
    const canGroundCohort = ctx.req.takoAnswerEnabled !== false;
    let grounded: GroundedAnswer | null = null;
    // A lazy grounding /v1/answer call would stream before this node's reasoning
    // step exists and mint an "(unnamed step)" in the live trace — seed the step
    // with the question first; the authoritative reasoning event below refines it.
    const seedTraceStep = () => ctx.emit?.({ type: "reasoning", nodeId, depth, question, kind: "branch" });
    const t = Date.now();
    try {
      // The prompt reads the CURRENT `grounded` so a re-plan after lazy grounding
      // automatically carries the GROUNDED_ANSWER block. SIBLING_QUESTIONS fences a
      // deeper decompose into its own lane: the context block still shows the broad
      // user message, and without the fence a child re-splits toward the overall
      // goal, duplicating surfaces its siblings already research.
      const siblingBlock = opts.siblings?.length
        ? `\n\nSIBLING_QUESTIONS (other researchers already cover these — your plan must NOT re-answer,` +
          ` restate, or split into any of them):\n${opts.siblings.map((s) => `- ${s}`).join("\n")}`
        : "";
      const basePrompt = () => `${ctx.ctxText}\n\nRESEARCH_QUESTION: ${question}${siblingBlock}${groundedBlock(grounded)}`;
      // A schema-invalid response THROWS (generateObject does not self-heal on
      // validation failure — observed with cohort questions omitting the required
      // lookup fields). One corrective retry with the violation named keeps a
      // flubbed plan from degrading the whole turn to an empty board.
      // lastExtra survives across calls so LATER retries (the split-intent CORRECTION
      // below) keep the cohort's COHORT_MEMBERS block — without it a correction was
      // asked to produce per-member subs WITHOUT the member list and reliably failed.
      let lastExtra = "";
      const decomposeCall = async (extra = "") => {
        lastExtra = extra;
        try {
          return await generateStructured({
            provider: OPENAI, system: decomposePrompt(maxChildren, depth),
            prompt: `${basePrompt()}${extra}`,
            schema: zResearchPlan, label: "decompose",
          });
        } catch (e: unknown) {
          ctx.notes.push(`decompose returned an invalid plan — retrying once (${errorMessage(e).slice(0, 100)})`);
          return await generateStructured({
            provider: OPENAI, system: decomposePrompt(maxChildren, depth),
            prompt: `${basePrompt()}${extra}\n\nSCHEMA_REMINDER: Your previous response did not match the required schema.` +
              ` EVERY plan must include entities (1-3 candidate name strings — for a class question use the class` +
              ` phrase and/or the question's geography/market) AND metricFilters (1-5 short metric-name fragments),` +
              ` plus atomic and rationale; each subQuestion carries the same entities/label/metricFilters fields.`,
            schema: zResearchPlan, label: "decompose",
          });
        }
      };
      let plan = await decomposeCall();
      // The planner decided the split depends on CURRENT data (live drivers, moving
      // rankings): ground with a real tako answer and re-plan from it. Root-only, and
      // cohort plans skip it — a cohort grounds via its own answer resolution below.
      if (canGround && plan.needsFreshContext && !plan.cohort) {
        seedTraceStep();
        grounded = await groundWithAnswer(ctx, question);
        if (grounded) {
          try {
            plan = await decomposeCall();
          } catch (e: unknown) {
            ctx.notes.push(`grounded re-plan failed — proceeding with the ungrounded plan (${errorMessage(e).slice(0, 80)})`);
          }
        }
      }
      // Class-of-entities question (INCLUDING a sector/industry in a region): the
      // members are unknowable from the question text, so resolve them from a real
      // Tako answer (prose + card titles) and re-decompose one sub-question per member.
      // Runs at ANY depth — the multi-sector example splits into per-sector
      // sub-questions, each itself a cohort resolved on its OWN node. A failed second
      // pass keeps the FIRST plan; the answer call attaches to THIS node's trace.
      let cohortMembers: string[] | null = null; // resolved member names — powers the deterministic split fallback below
      let cohortFilters: string[] = []; // the cohort plan's own measure fragments (the fallback subs reuse them)
      let cohortLabel: string | undefined; // NER label boost from the cohort plan, if it set one
      if (plan.cohort && canGroundCohort) {
        if (!grounded) {
          seedTraceStep();
          grounded = await groundWithAnswer(ctx, question, nodeId);
        }
        cohortFilters = plan.metricFilters ?? [];
        cohortLabel = plan.label?.trim() || undefined;
        const members = grounded ? await resolveCohort(ctx, question, plan.cohort, grounded) : null;
        if (members?.length) {
          cohortMembers = members;
          try {
            plan = await decomposeCall(`\n\nCOHORT_MEMBERS: ${JSON.stringify(members)}`);
          } catch (e: unknown) {
            ctx.notes.push(`cohort second-pass decompose failed — proceeding with the first plan (${errorMessage(e).slice(0, 80)})`);
          }
        }
      }
      // Unresolvable cohort (no grounding, resolution failed/empty, or a misapplied
      // cohort on a question that names its own subjects): a silent leaf here left
      // the gap round doing the real research. Re-plan ONCE from the question text;
      // adopt the re-plan only when it's usable (a real split or a concrete lookup).
      // Resolved cohorts never take this path — their fallback is the deterministic
      // per-member split below, and this message would be untrue for them.
      if (plan.cohort && !cohortMembers && toSubs(plan).length === 0) {
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
      // Deterministic cohort fallback: the members are ALREADY resolved, so a
      // per-member split is mechanical — never let a flubbed second-pass response
      // (split rationale, missing/short subQuestions — the observed "two concrete
      // companies to research one-by-one" leaf) collapse a resolved cohort. Built in
      // code from real member names: no extra LLM round-trip, un-hallucinatable.
      if (cohortMembers && cohortMembers.length >= 2 && subs.length < 2) {
        ctx.notes.push(`cohort second pass returned ${subs.length} usable sub-questions — split rebuilt deterministically from ${cohortMembers.length} resolved members`);
        subs = cohortMembers.slice(0, maxChildren).map((m) => ({
          question: `${m}: ${question}`,
          lookup: {
            entities: [m],
            ...(cohortLabel ? { label: cohortLabel } : {}),
            metricFilters: cohortFilters.length ? cohortFilters : lookup.metricFilters,
          },
        }));
        plan = { ...plan, atomic: false };
      }
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
            // lastExtra keeps any COHORT_MEMBERS/COHORT_GROUPS block in the correction —
            // without it the retry can't name the members its subs must cover.
            prompt: `${basePrompt()}${lastExtra}\n\nCORRECTION: Your previous plan set atomic:false ("${plan.rationale.slice(0, 200)}")` +
              ` but returned ${plan.subQuestions?.length ?? 0} subQuestions, which is INVALID. Return the split's` +
              ` subQuestions (2 to ${maxChildren}, one per facet, each with its own entities/label/metricFilters,` +
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
      // Adopt the child plan's own lookup — but PRESERVE a parent-assigned pre-resolved
      // node id when one was passed down: the child re-words candidate names for the
      // SAME one subject, and dropping the id would silently resurrect entity search.
      if (plan.entities?.length) {
        lookup = { ...toLookup(plan), ...(opts.lookup?.node ? { node: opts.lookup.node } : {}) };
      }
    } catch (e: unknown) {
      ctx.notes.push(`decompose failed — ${errorMessage(e)}`);
    }
    ctx.timings.decompose = Math.max(ctx.timings.decompose, Date.now() - t);
  }

  const willBranch = !atomic && subs.length >= 2
    && ctx.budget.researchNodes + subs.length <= ctx.budget.maxNodes;
  // A valid split suppressed ONLY by budget must be visible in the trace — otherwise
  // a budget-leaf is indistinguishable from a failed decompose when debugging.
  if (!atomic && subs.length >= 2 && !willBranch) {
    ctx.notes.push(`split of ${subs.length} suppressed — research budget exhausted (${ctx.budget.researchNodes}/${ctx.budget.maxNodes})`);
  }

  // Live reasoning step: one per research node, once the branch/leaf decision is final.
  ctx.emit?.({
    type: "reasoning", nodeId, depth, question,
    kind: willBranch ? "branch" : "leaf",
    rationale,
    entities: lookup.entities.length ? lookup.entities : undefined,
    label: lookup.label,
    metrics: lookup.metricFilters.length ? lookup.metricFilters : undefined,
    subQuestions: willBranch ? subs.map((s) => s.question) : undefined,
  });
  if (rationale) ctx.reasoning.push({ nodeId, question, rationale }); // survives pruning

  if (!willBranch) return researchLeaf(question, depth, nodeId, root, ctx, lookup, rationale, { startedAt });

  // ---- branch ----
  ctx.budget.researchNodes += subs.length; // reserve before recursing so siblings can't overshoot
  if (!root) ctx.push([{ op: "add_node", node: researchNode(nodeId, question, "") }]);

  const kids = await Promise.all(
    subs.map((s) => research(s.question, depth + 1, ctx, {
      root: false, lookup: s.lookup,
      siblings: subs.filter((x) => x !== s).map((x) => x.question),
    })),
  );
  const live = kids.filter((k) => k.nodeId && (k.findingCount > 0 || k.children.length > 0));

  // Whole subtree came back empty → fetch directly instead of an empty branch.
  if (live.length === 0) {
    ctx.notes.push(`all ${subs.length} sub-questions found nothing — refetching "${question.slice(0, 60)}" as a single leaf`);
    return researchLeaf(question, depth, nodeId, root, ctx, lookup, rationale, { startedAt });
  }

  ctx.push(live.map((k) => derivedEdge(k.nodeId!, nodeId))); // children feed this node

  const children = live.map((k) => k.nodeId!);

  // Root: the synthesis node does NO graph resolving or searching of its own — that
  // is what makes it DIFFERENT from every research node. Its children own the
  // per-facet data, the gap round fetches anything still missing, and the composed
  // answer report (at the end) is the answer; a root "broad fetch" only re-found
  // series the leaves already had. DEFER — no streamed root prose either.
  if (root) {
    ctx.push([{ op: "add_node", node: synthNode(ctx.rootId, "", "") }]);
    ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: 0, children, rationale, entities: lookup.entities, label: lookup.label, metrics: lookup.metricFilters, graphCalls: [], totalMs: Date.now() - startedAt });
    return { nodeId, title: question, synthesis: "", findingCount: 0, children, depth, kind: "branch" };
  }

  // Non-root branch: reconcile its children's mini-answers into a sub-answer.
  const menu = live.map((k) => ({ q: k.title, answer: k.synthesis }));
  ctx.emit?.({ type: "synthesis", phase: "start", nodeId, kind: "branch", inputs: { fromNodeIds: children } });
  const t = Date.now();
  const prose = await streamAnswer({
    provider: OPENAI, system: BRANCH_SYNTH_SYSTEM,
    prompt: `${ctx.ctxText}\n\nCHILDREN: ${JSON.stringify(menu)}`,
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
  ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: 0, children, rationale, entities: lookup.entities, label: lookup.label, metrics: lookup.metricFilters, totalMs: Date.now() - startedAt });
  return { nodeId, title: question, synthesis: prose, findingCount: 0, children, depth, kind: "branch", claim, confidence: 0.75 };
}

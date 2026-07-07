// Recursive research engine. A question becomes a tree: at each node the LLM
// decides whether to DECOMPOSE into sub-questions (branch) or fetch data directly
// (leaf). A leaf pulls Tako findings and writes a mini-synthesis; a branch
// synthesizes over its children's syntheses ("consensus of consensus"). The root's
// synthesis is the main answer. Every node streams its synthesis live into its own
// canvas node (findings → leaf, child → parent, top → root, via feeds/derived_from).
import type { AgentRequest, CanvasOp, CanvasNode } from "../../schema";
import type { EmitFn, TraceTreeNode, TakoCallRecord } from "../shared/types";
import { generateStructured, streamAnswer } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zResearchPlan, zQueries, zWebFilter, zMetricFilter } from "../shared/schemas";
import { graphSearch, graphRelated } from "./graph";
import { takoSearch, takoContents } from "../../tako";
import { FindingLedger, type Finding } from "./findings";
import { diversifyQueries } from "./queries";
import {
  DECOMPOSE_SYSTEM, COMPOSE_SYSTEM, BROAD_COMPOSE_SYSTEM, WEB_FILTER_SYSTEM, METRIC_FILTER_SYSTEM,
  LEAF_SYNTH_SYSTEM, BRANCH_SYNTH_SYSTEM,
} from "./prompts";

const OPENAI = "openai" as const;

export const SYNTH_ID = "synth";
// Decomposition allows at most TWO levels. The root may split into distinct sub-questions,
// and a sub-question may split ONE more time — but ONLY when it genuinely contains 2+ SEPARATE
// subjects (e.g. "energy and gasoline prices" → energy, gasoline), never for adjacent metrics/
// facets of one subject. MAX_DEPTH=2 is the ceiling; the deepest level gets a strict "separate
// subjects only" brake (see decomposePrompt) so it can't spam the canvas with near-duplicates.
const MAX_DEPTH = 2;
const MAX_CHILDREN = 3; // hard cap of 3 sub-questions at EVERY level
const TOTAL_RESEARCH_CAP = 12; // non-root research nodes (safety bound on a deep tree)
const LEAF_QUERY_CAP = 3; // 1-3 independent searches per sub-question (no similar/general spam)
const CONTENTS_CAP = 12; // max tako-contents (CSV/text) fetches per turn — bounds cost + latency
const CSV_EXCERPT = 1800; // chars of a card's CSV series handed to the synthesis LLM

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
}

export function synthNode(headline: string, summary: string): CanvasNode {
  return { id: SYNTH_ID, type: "text", role: "synthesis", title: headline || "Synthesis", summary, grounding: "tako", confidence: 0.9 };
}

function researchNode(id: string, question: string, summary: string): CanvasNode {
  // section:id groups this node's findings beneath it in the tree layout.
  return { id, type: "text", role: "research", section: id, title: question, summary, grounding: "tako", confidence: 0.85 };
}

function feedsEdge(from: string, to: string): CanvasOp {
  return { op: "add_edge", edge: { id: `feeds:${from}->${to}`, from, to, kind: "feeds" } };
}
function derivedEdge(from: string, to: string): CanvasOp {
  return { op: "add_edge", edge: { id: `derives:${from}->${to}`, from, to, kind: "derived_from" } };
}
// Web-source → the node that used it. `supports` keeps them out of the finding grid
// (they render in the left "Web sources" column) while still drawing a provenance line.
function supportsEdge(from: string, to: string): CanvasOp {
  return { op: "add_edge", edge: { id: `supports:${from}->${to}`, from, to, kind: "supports" } };
}

export interface WebSource { title: string; source?: string; url?: string; summary?: string; content?: string }

const WEB_CONTENT_CAP = 1500; // per-source excerpt of full page content handed to the synthesis LLM

// A node's "see sources" list: {url, title} entries deduped by url, for CanvasNode.sources.
export function toNodeSources(webs: WebSource[]): { url: string; title?: string }[] {
  const seen = new Set<string>();
  const out: { url: string; title?: string }[] = [];
  for (const w of webs) {
    const url = w.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: w.title || w.source });
  }
  return out;
}

export interface GatheredFigure { label: string; value: string; entity?: string; source?: string }

export interface ResearchResult {
  nodeId: string | null; // null = pruned (0 findings / all-empty subtree)
  title: string;
  synthesis: string;
  findingCount: number;
  children: string[];
  depth: number;
  kind: "branch" | "leaf";
  claim?: string; // the branch's decisive one-line answer (for reconciliation)
  confidence?: number;
}

// Pull the most meaningful real number verbatim from a finding's title/description
// (never invented). Prefers currency / percentage / unit-suffixed magnitudes; only
// falls back to a bare number, and never picks a standalone 4-digit year.
const STRONG_FIGURE_RE = /(\$\s?\d[\d,]*\.?\d*\s?(?:bn|billion|million|trillion|B|M|T|K)?|\d[\d,]*\.?\d*\s?%|\d[\d,]*\.?\d*\s?(?:bn|billion|million|trillion|B|M|T|K|bps|x))/gi;
const BARE_NUM_RE = /\b\d[\d,]*\.?\d+\b|\b\d{1,3}(?:,\d{3})+\b/g;
const isYear = (s: string) => /^\d{4}$/.test(s.trim()) && +s >= 1900 && +s <= 2099;

function pickFigure(text: string): string | undefined {
  const strong = text.match(STRONG_FIGURE_RE)?.map((s) => s.trim()).filter((s) => !isYear(s));
  if (strong?.length) return strong[0];
  const bare = text.match(BARE_NUM_RE)?.map((s) => s.trim()).filter((s) => !isYear(s) && s.length > 1);
  return bare?.[0];
}

function extractFigures(findings: Finding[]): GatheredFigure[] {
  const out: GatheredFigure[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    // Prefer the description (where Tako puts the headline value), then the title.
    const value = pickFigure(f.card.description || "") || pickFigure(f.title);
    if (!value) continue;
    const key = `${f.title}|${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: f.title, value, entity: f.section, source: f.source });
  }
  return out;
}

// Keep the CSV header + the most RECENT rows (latest data is what "now" questions need),
// capped by chars — so the synthesis reads the real series without blowing the token budget.
function excerptCsv(csv: string): string {
  const lines = csv.split("\n").filter(Boolean);
  if (lines.length <= 2) return csv.slice(0, CSV_EXCERPT);
  const [header, ...rows] = lines;
  return [header, ...rows.slice(-24)].join("\n").slice(0, CSV_EXCERPT);
}

// The most recent numeric data point from a card's CSV, as a gathered figure — so the
// report can cite an up-to-date real value and it passes numeric validation.
function csvLatestFigure(csv: string, label: string, entity?: string, source?: string): GatheredFigure | null {
  const rows = csv.split("\n").filter(Boolean);
  if (rows.length < 2) return null;
  const cells = rows[rows.length - 1].split(",");
  const value = cells[cells.length - 1]?.trim();
  if (!value || !/\d/.test(value)) return null;
  return { label, value, entity, source };
}

// Fetch the underlying data behind a card/web URL via the Tako contents API — deduped
// per turn (cache) and capped (budget). A card URL → its CSV series; a web URL → page text.
// Returns "" on cache-miss-with-no-budget or on error (never throws — content is a bonus).
async function fetchContents(ctx: ResearchCtx, url?: string): Promise<string> {
  if (!url) return "";
  const cache = ctx.contents.cache;
  const hit = cache.get(url);
  if (hit !== undefined) return hit;
  if (ctx.contents.fetched >= ctx.contents.cap) return "";
  ctx.contents.fetched++;
  try {
    const c = await takoContents(url, { mode: "inline" });
    const text = c.csv || c.text || "";
    cache.set(url, text);
    return text;
  } catch (e: unknown) {
    ctx.notes.push(`contents fetch failed for ${url} — ${errorMessage(e)}`);
    cache.set(url, "");
    return "";
  }
}

export interface ResearchCtx {
  req: AgentRequest;
  ledger: FindingLedger;
  push: (ops: CanvasOp[]) => void;
  emit?: EmitFn;
  budget: { researchNodes: number; readonly maxNodes: number };
  usedIds: Set<string>;
  notes: string[];
  tree: TraceTreeNode[];
  resolved: { query: string; node: string }[];
  related: { node: string; items: string[] }[];
  queries: string[];
  webSources: WebSource[]; // filtered web sources used across the tree (for the root synthesis)
  seenSourceUrls: Set<string>; // dedup web sources by url across branches
  sourcesByNode: Map<string, WebSource[]>; // web sources used per answer node → rendered as its "see sources"
  contents: { fetched: number; cap: number; cache: Map<string, string> }; // tako-contents (CSV/text) fetch cache + budget
  figures: GatheredFigure[]; // every real number gathered this turn — the answer report validates against this
  branchResults: { question: string; claim: string; confidence: number; figures: GatheredFigure[] }[];
  // Flat authoritative accumulators — every Tako call and every reasoning step,
  // INCLUDING those on nodes that were later pruned (0-finding leaves). The tree
  // holds per-node copies for drill-down; these guarantee nothing is lost.
  calls: TakoCallRecord[];
  reasoning: { nodeId: string; question: string; rationale: string }[];
  timings: { graph: number; search: number; decompose: number; stream: number };
}

export function newResearchCtx(req: AgentRequest, ledger: FindingLedger, push: ResearchCtx["push"], emit?: EmitFn): ResearchCtx {
  return {
    req, ledger, push, emit,
    budget: { researchNodes: 0, maxNodes: TOTAL_RESEARCH_CAP },
    usedIds: new Set([SYNTH_ID]),
    notes: [], tree: [], resolved: [], related: [], queries: [],
    webSources: [], seenSourceUrls: new Set(), sourcesByNode: new Map(),
    contents: { fetched: 0, cap: CONTENTS_CAP, cache: new Map() },
    figures: [], branchResults: [],
    calls: [], reasoning: [],
    timings: { graph: 0, search: 0, decompose: 0, stream: 0 },
  };
}

function uniqueResearchId(ctx: ResearchCtx, question: string): string {
  const base = `rq_${slug(question)}` || "rq";
  let id = base, i = 2;
  while (ctx.usedIds.has(id)) id = `${base}_${i++}`;
  ctx.usedIds.add(id);
  return id;
}

function decomposePrompt(maxChildren: number, depth: number): string {
  const base = DECOMPOSE_SYSTEM.replace(/{MAX}/g, String(maxChildren));
  // At the deepest level that may still split, split ONLY for genuinely separate subjects —
  // this is the brake that stops recursive re-decomposition into near-duplicate sub-questions.
  if (depth >= MAX_DEPTH - 1) {
    return base +
      `\nDEEPEST LEVEL: split this question ONE more time ONLY if it EXPLICITLY names 2+ different subjects` +
      ` joined together (e.g. "energy AND gasoline prices" → "energy prices", "gasoline prices"). A SINGLE` +
      ` subject — even a broad one like "energy prices" or "revenue growth" — is ATOMIC: answer it directly,` +
      ` never split it further. If in doubt, atomic.`;
  }
  return base;
}

interface ResearchOpts { root: boolean; entities?: string[]; metrics?: string[] }

export async function research(question: string, depth: number, ctx: ResearchCtx, opts: ResearchOpts): Promise<ResearchResult> {
  const root = opts.root;
  const nodeId = root ? SYNTH_ID : uniqueResearchId(ctx, question);
  ctx.emit?.({ type: "trace", stage: depth === 0 ? "planning research" : `researching: ${question.slice(0, 60)}` });

  // ---- decide: branch or leaf ----
  let atomic = true;
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
      subs = (plan.subQuestions ?? []).slice(0, maxChildren);
      rationale = plan.rationale;
      if (plan.entities?.length) entities = plan.entities;
      if (plan.metrics?.length) metrics = plan.metrics;
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

  if (!willBranch) return leaf(question, depth, nodeId, root, ctx, entities, metrics, rationale);

  // ---- branch ----
  ctx.budget.researchNodes += subs.length; // reserve before recursing so siblings can't overshoot
  if (!root) ctx.push([{ op: "add_node", node: researchNode(nodeId, question, "") }]);

  const kids = await Promise.all(
    subs.map((s) => research(s.question, depth + 1, ctx, { root: false, entities: s.entities ?? [], metrics: s.metrics ?? [] })),
  );
  const live = kids.filter((k) => k.nodeId && (k.findingCount > 0 || k.children.length > 0));

  // Whole subtree came back empty → fetch directly instead of an empty branch.
  if (live.length === 0) return leaf(question, depth, nodeId, root, ctx, entities, metrics, rationale);

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
    ctx.tree.push({ nodeId, depth, question, kind: "branch", findingCount: bf.findings.length, children, queries: bf.queries, rationale, entities, metrics, graph: bf.graph, calls: bf.calls });
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

async function leaf(
  question: string, depth: number, nodeId: string, root: boolean, ctx: ResearchCtx,
  entities: string[], metrics: string[], rationale?: string,
): Promise<ResearchResult> {
  const resolved = await resolveGraph(ctx, entities, metrics, question);
  // What the graph actually resolved for this node (shown per answer query in the trace).
  const graph = resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name) }));
  const queries = await groundedQueries(ctx, question, resolved, entities, metrics);
  ctx.queries.push(...queries);

  // The empty research node must exist before any of its finding/token ops.
  if (!root) ctx.push([{ op: "add_node", node: researchNode(nodeId, question, "") }]);

  const { dataFindings, webSources, calls } = await runSearches(question, nodeId, queries, ctx);
  const found = dataFindings.length + webSources.length;

  if (found === 0) {
    if (!root) ctx.push([{ op: "remove_node", id: nodeId, cascade: true }]); // prune empty leaf
    return { nodeId: null, title: question, synthesis: "", findingCount: 0, children: [], depth, kind: "leaf" };
  }

  const figures = extractFigures(dataFindings);
  ctx.figures.push(...figures);

  // Consider what Tako actually has FIRST: pull the real underlying series (CSV) behind each
  // graph card via the Tako contents API. The latest data point becomes a gathered figure
  // (so the report can cite an up-to-date value), and the series feeds the leaf synthesis.
  const csvByFinding = new Map<string, string>();
  await Promise.all(dataFindings.map(async (f) => {
    const csv = await fetchContents(ctx, f.card.webpageUrl);
    if (!csv) return;
    csvByFinding.set(f.nodeId, csv);
    const fig = csvLatestFigure(csv, f.title, f.section, f.source);
    if (fig) ctx.figures.push(fig);
  }));

  // Root: never stream prose — the composed answer report (Claude, at the end)
  // is the answer. Create the empty synth block and record this leaf's material.
  if (root) {
    ctx.push([{ op: "add_node", node: synthNode("", "") }]);
    ctx.branchResults.push({ question, claim: "", confidence: found > 0 ? 0.8 : 0.3, figures });
    ctx.tree.push({ nodeId, depth, question, kind: "leaf", findingCount: found, children: [], queries, rationale, entities, metrics, graph, calls });
    return { nodeId, title: question, synthesis: "", findingCount: found, children: [], depth, kind: "leaf" };
  }

  const menu = dataFindings.map((f) => {
    const csv = csvByFinding.get(f.nodeId);
    return {
      title: f.title, source: f.source, kind: f.kind, summary: f.card.description,
      ...(csv ? { data: excerptCsv(csv) } : {}),
    };
  });
  const webMenu = webSources.map((f) => ({
    title: f.title, source: f.source, snippet: f.card.description,
    content: (f.card.content || f.card.description || "").slice(0, WEB_CONTENT_CAP),
  }));
  ctx.emit?.({ type: "synthesis", phase: "start", nodeId, kind: "leaf", inputs: { findingTitles: [...dataFindings, ...webSources].map((f) => f.title) } });
  const st = Date.now();
  const prose = await streamAnswer({
    provider: OPENAI, system: LEAF_SYNTH_SYSTEM,
    prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}\n\nFINDINGS: ${JSON.stringify(menu)}\n\nWEB_SOURCES: ${JSON.stringify(webMenu)}`,
    label: "leaf-synth",
    onToken: (c) => ctx.emit?.({ type: "token", text: c, nodeId }),
  });
  ctx.timings.stream = Math.max(ctx.timings.stream, Date.now() - st);
  ctx.emit?.({ type: "synthesis", phase: "end", nodeId, kind: "leaf" });

  const claim = firstSentence(prose);
  ctx.branchResults.push({ question, claim, confidence: 0.8, figures });
  const leafSources = toNodeSources(ctx.sourcesByNode.get(nodeId) ?? []);
  ctx.push([{ op: "update_node", id: nodeId, patch: {
    summary: prose, title: question,
    ...(queries.length ? { searches: queries } : {}),
    ...(leafSources.length ? { sources: leafSources } : {}),
  } }]);
  ctx.tree.push({ nodeId, depth, question, kind: "leaf", findingCount: found, children: [], queries, rationale, entities, metrics, graph, calls });
  return { nodeId, title: question, synthesis: prose, findingCount: found, children: [], depth, kind: "leaf", claim, confidence: 0.8 };
}

function firstSentence(prose: string): string {
  const clean = prose.replace(/\*\*/g, "").trim();
  const m = clean.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : clean).trim().slice(0, 240);
}

// The root's broad/overview fetch: 1-2 high-level queries whose cards attach to
// the synth node, so the overarching answer is grounded in the general view.
async function broadFetch(
  question: string, nodeId: string, ctx: ResearchCtx, entities: string[], metrics: string[],
): Promise<{ findings: Finding[]; queries: string[]; calls: TakoCallRecord[]; graph: { entity: string; related: string[] }[] }> {
  const resolved = await resolveGraph(ctx, entities, metrics, question);
  const graph = resolved.map((r) => ({ entity: r.entity, related: r.related.map((m) => m.name) }));
  const resolvedInfo = resolved
    .map((r) => `${r.entity}: ${r.related.slice(0, 5).map((m) => `${m.name} [${m.aliases.join(", ")}]`).join("; ")}`)
    .join("\n");
  let queries: string[] = [];
  try {
    const composed = await generateStructured({
      provider: OPENAI, system: BROAD_COMPOSE_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nRESOLVED:\n${resolvedInfo || "(none)"}`,
      schema: zQueries, label: "broad-compose",
    });
    queries = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean).slice(0, 2);
  } catch (e: unknown) {
    ctx.notes.push(`broad compose failed — ${errorMessage(e)}`);
  }
  ctx.queries.push(...queries);

  // Broad chart cards feed the synth; broad web sources are filtered into ctx.webSources.
  const { dataFindings, calls } = await runSearches(question, nodeId, queries, ctx);
  return { findings: dataFindings, queries, calls, graph };
}

// Keep only the web sources genuinely useful for the question (LLM gate).
async function filterWebSources(question: string, candidates: Finding[], ctx: ResearchCtx): Promise<Finding[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= 2) return candidates; // too few to be worth an LLM call
  try {
    const menu = candidates.map((f, i) => ({ i, title: f.title, source: f.source, snippet: f.card.description }));
    const res = await generateStructured({
      provider: OPENAI, system: WEB_FILTER_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nSOURCES: ${JSON.stringify(menu)}`,
      schema: zWebFilter, label: "web-filter",
    });
    const keep = new Set(res.useful.filter((n) => n >= 0 && n < candidates.length).slice(0, 4));
    const filtered = candidates.filter((_, i) => keep.has(i));
    return filtered.length ? filtered : candidates.slice(0, 3);
  } catch (e: unknown) {
    ctx.notes.push(`web filter failed — ${errorMessage(e)}`);
    return candidates.slice(0, 3);
  }
}

// Run the searches for a node: chart cards node immediately (feeds → finding grid);
// web results are filtered to the useful ones and noded as left-column source nodes
// (supports → provenance line). Both are returned for the node's synthesis prompt.
async function runSearches(
  question: string, nodeId: string, queries: string[], ctx: ResearchCtx,
): Promise<{ dataFindings: Finding[]; webSources: Finding[]; calls: TakoCallRecord[] }> {
  const dataFindings: Finding[] = [];
  const webCandidates: Finding[] = [];
  const calls: TakoCallRecord[] = []; // one record per Tako call, in issue order
  const t = Date.now();
  // All queries are dispatched in the same tick, but the runtime (Next's patched fetch)
  // serializes them, so each `m.ms` (elapsed since the shared dispatch) balloons with the
  // time spent queued behind earlier calls. onCall fires in completion order, so the true
  // in-flight time of the just-completed call is its elapsed minus the previous completion's.
  let prevElapsed = 0;
  await Promise.allSettled(
    queries.map(async (q) => {
      try {
        const cards = await takoSearch(q, {
          effort: "fast", count: 3, web: true,
          // Capture the query → cards linkage this node issued, and mirror it live.
          onCall: (m) => {
            const serviceMs = Math.max(0, Math.round(m.ms - prevElapsed)); // strip queue-wait
            prevElapsed = m.ms;
            const call: TakoCallRecord = {
              callId: `${nodeId}:${calls.length}`, nodeId,
              query: m.query, endpoint: m.endpoint, effort: m.effort, web: m.web, ms: serviceMs,
              cards: m.cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
              error: m.error,
            };
            calls.push(call);
            ctx.calls.push(call); // flat superset — survives leaf pruning
            ctx.emit?.({ type: "tako_call", call });
          },
        });
        for (const c of cards) {
          const f = ctx.ledger.add(c, nodeId);
          if (!f) {
            // Dedup hit: a prior branch already has this card. For a data card, reuse the ONE
            // node with a `supports` link to THIS branch and include it in findings so this
            // branch's synthesis still reasons over it. For a web source (no node), just route
            // it to this branch's candidates so it still counts toward THIS answer's sources.
            const existing = ctx.ledger.lookup(c);
            if (existing && existing.nodeId !== nodeId) {
              if (existing.kind === "data_card") {
                ctx.push([supportsEdge(existing.nodeId, nodeId)]);
                dataFindings.push(existing);
              } else {
                webCandidates.push(existing);
              }
            }
            continue;
          }
          if (f.kind === "data_card") {
            // Tag the card with its originating query so the canvas can show it.
            ctx.push([{ op: "add_node", node: { ...ctx.ledger.toNode(f), searches: [q] } }, feedsEdge(f.nodeId, nodeId)]);
            dataFindings.push(f);
          } else {
            webCandidates.push(f); // recorded as a source (not a node) after the usefulness filter
          }
        }
      } catch (e: unknown) {
        ctx.notes.push(`search failed for "${q}" — ${errorMessage(e)}`);
      }
    }),
  );
  ctx.timings.search = Math.max(ctx.timings.search, Date.now() - t);

  const useful = await filterWebSources(question, webCandidates, ctx);
  // Web-source numbers count as gathered evidence too, so the composed report can cite
  // them AND they pass numeric validation (attributed to the publisher). Without this,
  // validateBlock would drop any web-derived figure as "untraceable".
  ctx.figures.push(...extractFigures(useful));
  // Web sources are NO LONGER canvas nodes. Each used source is recorded against THIS
  // answer node (→ its clickable "see sources" list) and into the tree-wide accumulator
  // (→ the root answer's sources + the report composer's WEB_SOURCES input).
  const nodeSources = ctx.sourcesByNode.get(nodeId) ?? [];
  for (const f of useful) {
    const url = f.url || "";
    if (!url) continue;
    const web: WebSource = { title: f.title, source: f.source, url, summary: f.card.description, content: f.card.content };
    nodeSources.push(web);
    if (!ctx.seenSourceUrls.has(url)) {
      ctx.seenSourceUrls.add(url);
      ctx.webSources.push(web);
    }
  }
  ctx.sourcesByNode.set(nodeId, nodeSources);
  return { dataFindings, webSources: useful, calls };
}

interface ResolvedEntity { entity: string; node: string; related: { name: string; aliases: string[]; description?: string }[] }

// Resolve each entity to its Tako graph node and pull the metrics Tako ACTUALLY has
// for it (graphRelated). Records provenance in ctx.resolved/ctx.related.
async function resolveGraph(ctx: ResearchCtx, entities: string[], metrics: string[], topic: string): Promise<ResolvedEntity[]> {
  const t = Date.now();
  const out: ResolvedEntity[] = [];
  await Promise.all(
    entities.slice(0, 3).map(async (name) => {
      try {
        const nodes = await graphSearch(name, { types: "entity" });
        const node = nodes[0];
        if (!node) { ctx.notes.push(`No graph node for "${name}"`); return; }
        ctx.resolved.push({ query: name, node: node.name });
        const q = metrics[0] || topic || name;
        const items = await graphRelated(node.id, { relationType: "metric", q });
        ctx.related.push({ node: node.name, items: items.map((i) => i.name) });
        out.push({ entity: node.name, node: node.id, related: items.map((i) => ({ name: i.name, aliases: i.aliases || [], description: i.description })) });
      } catch (e: unknown) {
        ctx.notes.push(`graph lookup failed for "${name}" — ${errorMessage(e)}`);
      }
    }),
  );
  ctx.timings.graph = Math.max(ctx.timings.graph, Date.now() - t);
  return out;
}

const includesCi = (a: string, b: string) => a.toLowerCase().includes(b.toLowerCase());

// Collapse repeated words (case-insensitive, first occurrence wins) so a composed query
// like "US gasoline prices gasoline price level" doesn't stutter into "...gasoline...gasoline...".
function dedupeWords(s: string): string {
  const seen = new Set<string>();
  return s
    .split(/\s+/)
    .filter((w) => { const k = w.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
    .join(" ");
}

// Deterministic fallback query composer (used when the graph confirms no metrics). Pairs each
// SUBJECT entity with each metric, but guards the malformed queries a raw cross-product makes:
//   - Subjects exclude any entity already named inside a metric — a context/target noun like
//     "inflation" that leaked into `entities` (and appears in "contribution to inflation") is
//     dropped, so we never emit "inflation contribution to inflation".
//   - Degenerate pairs (entity ⊆ metric or metric ⊆ entity) are skipped.
//   - Duplicate words are collapsed; exact duplicates removed; capped to LEAF_QUERY_CAP.
// Metric-outer ordering gives every subject the primary metric before the cap is spent, so
// multi-entity coverage survives. NOT jaccard-diversified — per-subject queries differ only by
// the subject name and must not collapse into one.
export function fallbackQueries(entities: string[], metrics: string[]): string[] {
  const ents = entities.map((e) => e.trim()).filter(Boolean);
  const mets = metrics.map((m) => m.trim()).filter(Boolean);
  const subjects = ents.filter((e) => !mets.some((m) => includesCi(m, e)));
  const use = subjects.length ? subjects : ents; // if every entity got filtered, keep them all
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of mets) {
    for (const e of use) {
      if (includesCi(m, e) || includesCi(e, m)) continue; // degenerate pair
      const q = dedupeWords(`${e} ${m}`);
      const k = q.toLowerCase();
      if (q && !seen.has(k)) { seen.add(k); out.push(q); }
    }
  }
  return out.slice(0, LEAF_QUERY_CAP);
}

// Compose grounded queries: for each resolved entity, an LLM FILTER picks the
// related metrics that answer THIS question, and we emit exactly one query per
// confirmed entity×metric pair. No overview/ungrounded/duplicate queries. Falls
// back to a free-form compose only when nothing resolved from the graph.
async function groundedQueries(
  ctx: ResearchCtx, question: string, resolved: ResolvedEntity[],
  entities: string[] = [], metrics: string[] = [],
): Promise<string[]> {
  const queries: string[] = [];
  for (const r of resolved) {
    if (r.related.length === 0) { ctx.notes.push(`Tako has no related metrics for "${r.entity}"`); continue; }
    let keep: string[] = [];
    try {
      const res = await generateStructured({
        provider: OPENAI, system: METRIC_FILTER_SYSTEM,
        // Pass name + aliases + description so the filter understands each metric and
        // picks DISTINCT concepts (not near-duplicate variants of one measure).
        prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nENTITY: ${r.entity}\n\nRELATED_METRICS: ${JSON.stringify(r.related.map((m) => ({ name: m.name, aliases: m.aliases, description: m.description })))}`,
        schema: zMetricFilter, label: "metric-filter",
      });
      const avail = new Set(r.related.map((m) => m.name.toLowerCase()));
      keep = res.keep.filter((m) => avail.has(m.toLowerCase())).slice(0, LEAF_QUERY_CAP);
    } catch (e: unknown) {
      ctx.notes.push(`metric filter failed for "${r.entity}" — ${errorMessage(e)}`);
    }
    if (keep.length === 0) { ctx.notes.push(`No answer-relevant Tako metric for "${r.entity}"`); continue; }
    for (const m of keep) queries.push(`${r.entity} ${m}`); // one grounded query per confirmed pair
  }
  // Backstop: drop near-duplicate queries the filter may have let through, and hard-cap
  // to 1-3 independent searches per sub-question. threshold 0.6 = fairly aggressive.
  if (queries.length) {
    return diversifyQueries(Array.from(new Set(queries)), { threshold: 0.6, max: LEAF_QUERY_CAP });
  }
  // Disciplined fallback: the graph confirmed no metrics, but decomposition already assigned
  // this leaf its entities + metric(s). fallbackQueries composes clean, subject-grounded
  // queries (dropping context nouns, degenerate pairs, and word stutter) — so we get
  // "gasoline prices contribution to inflation", never "inflation contribution to inflation".
  if (entities.length && metrics.length) {
    const fb = fallbackQueries(entities, metrics);
    if (fb.length) return fb;
  }

  // Last resort: no entities/metrics either → compose from the question directly,
  // still diversified and capped to 1-3.
  try {
    const composed = await generateStructured({
      provider: OPENAI, system: COMPOSE_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nSUB_QUESTION: ${question}\n\nRESOLVED:\n(none — compose from the question directly)`,
      schema: zQueries, label: "compose",
    });
    const dq = Array.from(new Set(composed.queries.map((q) => q.trim()))).filter(Boolean);
    return diversifyQueries(dq, { threshold: 0.6, max: LEAF_QUERY_CAP });
  } catch (e: unknown) {
    ctx.notes.push(`compose fallback failed — ${errorMessage(e)}`);
    return [];
  }
}

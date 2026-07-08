// Reusable leaf research flow: strategy → queries → searches → card noding → CSV contents → figures → mini-synthesis. Called by the research tree (research.ts) and the gap-fill round (gaps.ts).
import type { AgentRequest, CanvasOp, CanvasNode } from "../../schema";
import type { EmitFn, TraceTreeNode, TakoCallRecord, GraphCallRecord } from "../shared/types";
import { generateStructured, streamAnswer } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zWebFilter } from "../shared/schemas";
import { takoSearch, takoContents } from "../../tako";
import { FindingLedger, type Finding } from "./findings";
import {
  WEB_FILTER_SYSTEM, LEAF_SYNTH_SYSTEM,
} from "./prompts";
import { graphStrategy, type QueryStrategy } from "./strategy";

const OPENAI = "openai" as const;

export const SYNTH_ID = "synth";
const TOTAL_RESEARCH_CAP = 20; // non-root research nodes (global backstop: ~8 root subs + ~12 descendants)
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

export function researchNode(id: string, question: string, summary: string): CanvasNode {
  // section:id groups this node's findings beneath it in the tree layout.
  return { id, type: "text", role: "research", section: id, title: question, summary, grounding: "tako", confidence: 0.85 };
}

export function feedsEdge(from: string, to: string): CanvasOp {
  return { op: "add_edge", edge: { id: `feeds:${from}->${to}`, from, to, kind: "feeds" } };
}
export function derivedEdge(from: string, to: string): CanvasOp {
  return { op: "add_edge", edge: { id: `derives:${from}->${to}`, from, to, kind: "derived_from" } };
}
// Web-source → the node that used it. `supports` keeps them out of the finding grid
// (they render in the left "Web sources" column) while still drawing a provenance line.
export function supportsEdge(from: string, to: string): CanvasOp {
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

export function extractFigures(findings: Finding[]): GatheredFigure[] {
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
export function excerptCsv(csv: string, chars = CSV_EXCERPT, rows = 24): string {
  const lines = csv.split("\n").filter(Boolean);
  if (lines.length <= 2) return csv.slice(0, chars);
  const [header, ...dataRows] = lines;
  return [header, ...dataRows.slice(-rows)].join("\n").slice(0, chars);
}

// The most recent numeric data point from a card's CSV, as a gathered figure — so the
// report can cite an up-to-date real value and it passes numeric validation.
export function csvLatestFigure(csv: string, label: string, entity?: string, source?: string): GatheredFigure | null {
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
export async function fetchContents(ctx: ResearchCtx, url?: string): Promise<string> {
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
  strategy: QueryStrategy;
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

export function newResearchCtx(
  req: AgentRequest, ledger: FindingLedger, push: ResearchCtx["push"],
  emit?: EmitFn, strategy: QueryStrategy = graphStrategy,
): ResearchCtx {
  return {
    req, ledger, push, emit, strategy,
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

export function uniqueResearchId(ctx: ResearchCtx, question: string): string {
  const base = `rq_${slug(question)}` || "rq";
  let id = base, i = 2;
  while (ctx.usedIds.has(id)) id = `${base}_${i++}`;
  ctx.usedIds.add(id);
  return id;
}

export async function researchLeaf(
  question: string, depth: number, nodeId: string, root: boolean, ctx: ResearchCtx,
  entities: string[], metrics: string[], rationale?: string,
): Promise<ResearchResult> {
  const { queries, graph, metrics: planMetrics, graphCalls, graphMs } = await ctx.strategy.leafQueries(ctx, question, entities, metrics);
  // The strategy may have enriched the planner's metric guesses with graph-confirmed
  // canonical names — the tree records the enriched list as the authoritative one.
  const treeMetrics = planMetrics ?? metrics;
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
    ctx.tree.push({ nodeId, depth, question, kind: "leaf", findingCount: found, children: [], queries, rationale, entities, metrics: treeMetrics, graph, calls, graphCalls, graphMs });
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
  ctx.tree.push({ nodeId, depth, question, kind: "leaf", findingCount: found, children: [], queries, rationale, entities, metrics: treeMetrics, graph, calls, graphCalls, graphMs });
  return { nodeId, title: question, synthesis: prose, findingCount: found, children: [], depth, kind: "leaf", claim, confidence: 0.8 };
}

export function firstSentence(prose: string): string {
  const clean = prose.replace(/\*\*/g, "").trim();
  const m = clean.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : clean).trim().slice(0, 240);
}

// Keep only the web sources genuinely useful for the question (LLM gate).
export async function filterWebSources(question: string, candidates: Finding[], ctx: ResearchCtx): Promise<Finding[]> {
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
export async function runSearches(
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

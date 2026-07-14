// Final answer layer. Gather is DETERMINISTIC: the CSVs the leaves already pulled
// this turn are served straight from the per-turn cache into CARD_CONTENTS — no LLM
// in the loop. Only when NOTHING is cached (but data cards exist) does a fallback
// tool loop (fast model, get_card_contents / get_web_content, budgeted fetches) run.
// The emit (deep model, low reasoning effort by default) composes a PROSE-FIRST
// "answer report" (verdict + insight prose; numeric blocks only when every value is
// backed by evidence). Every number is validated against the gathered figures + the
// FULL per-turn CSV cache — untraceable numbers are PRUNED (dead table columns/rows
// dropped, value-less leaderboards converted to prose rosters, degenerate charts
// removed) and logged, so the report never shows a hallucinated value or a "—" cell.
import type { AnswerReport, AnswerBlock, GraphyBlock } from "../../schema";
import type { TakoCallRecord } from "../shared/types";
import { generateStructured, generateWithTools, type ReasoningEffort } from "../../llm";
import { tool } from "ai";
import { z } from "zod";
import { zAnswerReportEmit } from "../shared/schemas";
import { composeGraphyHero } from "./graphy";
import { REPORT_SYSTEM, REPORT_GATHER_SYSTEM } from "./prompts";
import { log } from "../../log";
import { fetchContents, excerptCsv, type ResearchCtx, type GatheredFigure } from "./flow";

const deepModel = () => process.env.SYNTH_MODEL || "gpt-5.4";
// Low by default: the emit is the latency tail, and the report is prose-first now —
// deep reconciliation can be bought back per-deploy via SYNTH_REASONING_EFFORT.
const synthEffort = (): ReasoningEffort =>
  (process.env.SYNTH_REASONING_EFFORT as ReasoningEffort) || "low";
const COMPOSER_CONTENTS_BUDGET = 3; // extra fetch headroom for the fallback gather (cache hits are free)
const COMPOSER_MAX_STEPS = 4;
const COMPOSER_CSV_EXCERPT = 1600; // larger than leaf excerpts — the composer charts real series
const COMPOSER_CSV_ROWS = 32;
// Phase B prompt bounds: the report emit is the latency tail, and its time scales with
// input size — the emit reads a cumulative digest, never the whole evidence corpus.
const FIGURES_PROMPT_CAP = 40; // deduped figures beyond the sub-answers' own keyFigures
const WEB_PROMPT_CAP = 10; // web snippets (full text stayed behind the gather tool)
const WEB_SNIPPET_CAP = 240;
const CARD_CONTENTS_PROMPT_CAP = 8; // series excerpts handed to the emit (gather may read more; validation sees all)
const WEB_TOOL_CONTENT_CAP = 3000; // full-page excerpt served by get_web_content (already in memory)

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Parse a numeric magnitude from a value string ("$75.2B" → 75.2e9, "71%" → 71,
// "5,780" → 5780). Returns null when there's no number.
export function numericMagnitude(s: string): number | null {
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  const suffix = String(s).toLowerCase();
  if (/\bt(rillion)?\b|t\b/.test(suffix) && /\dt/.test(suffix)) n *= 1e12;
  else if (/b(illion)?\b|\db/.test(suffix)) n *= 1e9;
  else if (/m(illion)?\b|\dm/.test(suffix)) n *= 1e6;
  else if (/\dk\b/.test(suffix)) n *= 1e3;
  return n;
}

const CSV_FIGURES_CAP = 500; // bound memory on very long series

// Every numeric cell of a fetched card CSV becomes an allowed figure, so real
// chart points the composer copies from card contents pass validation.
export function csvFigures(csv: string, label: string): GatheredFigure[] {
  const lines = csv.split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const out: GatheredFigure[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    for (let i = 1; i < cells.length; i++) {
      const v = cells[i]?.trim();
      if (!v || !/\d/.test(v)) continue;
      out.push({ label: `${label} ${header[i]?.trim() ?? ""}`.trim(), value: v });
      if (out.length >= CSV_FIGURES_CAP) return out;
    }
  }
  return out;
}

export function allowedSets(figures: GatheredFigure[]): { strings: Set<string>; mags: number[] } {
  const strings = new Set<string>();
  const mags: number[] = [];
  for (const f of figures) {
    const v = f.value.replace(/\s+/g, "").toLowerCase();
    strings.add(v);
    const mag = numericMagnitude(f.value);
    if (mag !== null) mags.push(mag);
  }
  return { strings, mags };
}

// A value cell is traceable if it has no number (pure text) OR its number matches
// a gathered figure (by normalized string or by magnitude within 0.5%).
export function traceable(value: string, allowed: { strings: Set<string>; mags: number[] }): boolean {
  const mag = numericMagnitude(value);
  if (mag === null) return true; // pure text label
  const norm = value.replace(/\s+/g, "").toLowerCase();
  if (allowed.strings.has(norm)) return true;
  return allowed.mags.some((a) => Math.abs(a - mag) <= Math.max(1, Math.abs(a) * 0.005));
}

// Drop untraceable numbers from a block; return null if the block is emptied.
export function validateBlock(block: AnswerBlock, allowed: { strings: Set<string>; mags: number[] }, drop: (why: string) => void): AnswerBlock | null {
  switch (block.kind) {
    case "prose":
      return block; // reasoning; numbers were drawn from the given figures per prompt
    case "tiles": {
      const tiles = block.tiles.filter((t) => {
        const ok = traceable(t.value, allowed);
        if (!ok) drop(`tile "${t.label}: ${t.value}"`);
        return ok;
      });
      return tiles.length ? { ...block, tiles } : null;
    }
    case "table": {
      // Prune, don't blank: dead value columns and dead rows disappear entirely, and a
      // table that lost most of its numbers is dropped — a grid of "—" placeholders is
      // worse than no table (the Tako embeds on the canvas already carry the data).
      const bad = block.rows.map((row) => row.map((cell, c) => c > 0 && !traceable(cell, allowed)));
      let numericCount = 0, badCount = 0;
      block.rows.forEach((row, r) => row.forEach((cell, c) => {
        if (c === 0) return;
        if (numericMagnitude(cell) !== null) numericCount++;
        if (bad[r][c]) badCount++;
      }));
      if (badCount === 0) return block;
      drop(`table "${block.columns.join(",")}" — ${badCount}/${numericCount} numeric cells untraceable`);
      if (badCount * 2 > numericCount) return null;
      const keepCol = block.columns.map((_, c) => c === 0 || block.rows.some((_, r) => !bad[r][c]));
      const keepRow = block.rows.map((row, r) => row.some((_, c) => c > 0 && keepCol[c] && !bad[r][c]));
      const columns = block.columns.filter((_, c) => keepCol[c]);
      const rows = block.rows
        .map((row, r) => ({ row, r }))
        .filter(({ r }) => keepRow[r])
        // Isolated stragglers (live row × live column, untraceable cell) still blank.
        .map(({ row, r }) => row.map((cell, c) => (bad[r][c] ? "—" : cell)).filter((_, c) => keepCol[c]));
      if (columns.length < 2 || rows.length === 0) return null;
      return { ...block, columns, rows };
    }
    case "chart": {
      const series = block.chartSpec.series
        .map((s) => ({ ...s, points: s.points.filter((p) => {
          const ok = traceable(String(p.y), allowed);
          if (!ok) drop(`chart point ${s.label}:${p.y}`);
          return ok;
        }) }))
        .filter((s) => s.points.length > 0);
      // A chart with fewer than 2 surviving points adds nothing over prose — drop it.
      if (series.reduce((n, s) => n + s.points.length, 0) < 2) return null;
      return { ...block, chartSpec: { ...block.chartSpec, series } };
    }
    case "comparison": {
      const series = block.series
        .map((s) => ({ ...s, points: s.points.filter((p) => {
          const ok = traceable(String(p.y), allowed);
          if (!ok) drop(`comparison point ${s.label}:${p.y}`);
          return ok;
        }) }))
        .filter((s) => s.points.length > 0);
      // Same degenerate-block rule as "chart": under 2 surviving points isn't a comparison.
      if (series.reduce((n, s) => n + s.points.length, 0) < 2) return null;
      return { ...block, series };
    }
    case "leaderboard": {
      // The ranked roster IS the block's substance — dropping a row breaks the ranking
      // (a "top 5" rendering as one orphaned row). A minority of untraceable values
      // blanks to "—" (ranks stay intact); when MOST values are unverifiable — common
      // for private-company financials Tako can't fetch — the whole board would be
      // dashes, so the roster converts to a prose ranked list instead (traceable
      // values kept inline, unverifiable ones simply omitted).
      const okValues = block.rows.map((r) => {
        const ok = traceable(r.value, allowed);
        if (!ok) drop(`leaderboard value "${r.entity}: ${r.value}"`);
        return ok;
      });
      const untraceableCount = okValues.filter((ok) => !ok).length;
      if (untraceableCount * 3 > block.rows.length) {
        const lines = block.rows.map((r, i) => {
          const value = okValues[i] ? ` (${r.value})` : "";
          const detail = r.detail?.md ? ` — ${r.detail.md}` : "";
          return `${r.rank}. **${r.entity}**${value}${detail}`;
        });
        const title = block.title ? `**${block.title}**\n\n` : "";
        return { kind: "prose", md: title + lines.join("\n") };
      }
      const rows = block.rows.map((r, i) => {
        const stats = r.detail?.stats?.filter((s) => {
          const ok = traceable(s.value, allowed);
          if (!ok) drop(`leaderboard stat "${s.label}: ${s.value}"`);
          return ok;
        });
        return {
          ...r,
          value: okValues[i] ? r.value : "—",
          ...(r.detail ? { detail: { ...r.detail, ...(stats ? { stats } : {}) } } : {}),
        };
      });
      return { ...block, rows };
    }
    case "sections": {
      const sections = block.sections.map((s) => {
        let next = s;
        if (s.figure && !traceable(s.figure.value, allowed)) {
          drop(`section figure "${s.figure.label}: ${s.figure.value}"`);
          const { figure: _f, ...rest } = next;
          next = rest;
        }
        if (next.chartSpec) {
          const series = next.chartSpec.series
            .map((se) => ({ ...se, points: se.points.filter((p) => traceable(String(p.y), allowed)) }))
            .filter((se) => se.points.length > 0);
          const { chartSpec: _c, ...rest } = next;
          next = series.length ? { ...rest, chartSpec: { ...next.chartSpec, series } } : rest;
        }
        return next;
      });
      return { ...block, sections };
    }
    case "timeline": {
      const events = block.events.map((e) => {
        if (e.value && !traceable(e.value, allowed)) {
          drop(`timeline value "${e.title}: ${e.value}"`);
          const { value: _v, ...rest } = e;
          return rest;
        }
        return e;
      });
      return { ...block, events };
    }
    default:
      // Unknown/future block kind — fail closed.
      return null;
  }
}

// FALLBACK gather tool loop — runs only when no card CSV was cached during research
// (the common path serves cached CSVs deterministically, no LLM involved). The model
// sees only CATALOGS — no raw data inlined — and reads the series/page content the
// report will need. A cached card is served from the per-turn cache instantly with
// no synthetic /v1/contents call; an uncached card costs a real, budgeted fetch.
// Returns the analyst note + everything the model read; failure returns whatever was
// read so far (compose proceeds without extra card contents — never throws).
async function gatherCardContents(
  ctx: ResearchCtx, question: string,
  catalog: { id: string; title: string; entity?: string; source?: string; description?: string; cached: boolean }[],
  webs: { url: string; title: string; publisher?: string; snippet?: string }[],
): Promise<{ notes: string; fetched: Map<string, string> }> {
  const fetched = new Map<string, string>();
  if (catalog.length === 0 && webs.length === 0) return { notes: "", fetched };
  ctx.contents.cap = ctx.contents.fetched + COMPOSER_CONTENTS_BUDGET;
  try {
    // No reasoningEffort here: OpenAI rejects function tools + reasoning_effort on
    // /v1/chat/completions for gpt-5.4 (verified live). No deep model either — the
    // gather phase is a read decision, not analysis; deep reasoning stays on the
    // tool-free report emit below, and numeric validation guards the output.
    const res = await generateWithTools({
      provider: "openai",
      system: REPORT_GATHER_SYSTEM,
      prompt: `${ctx.ctxText}\n\nQUESTION: ${question}\n\nCARD_CATALOG: ${JSON.stringify(catalog)}\n\nWEB_SOURCES: ${JSON.stringify(webs)}\n\nSUB_ANSWERS: ${JSON.stringify(ctx.branchResults.map((b) => ({ question: b.question, claim: b.claim })))}`,
      maxSteps: COMPOSER_MAX_STEPS, label: "report-gather",
      tools: {
        get_card_contents: tool({
          description: "Read the real underlying data series (CSV) behind a Tako card from CARD_CATALOG. cached:true cards return instantly; cached:false cards cost a slow, budgeted network fetch.",
          parameters: z.object({ cardId: z.string() }),
          execute: async ({ cardId }) => {
            // Already read this loop: answer from hand.
            const had = fetched.get(cardId);
            if (had) return excerptCsv(had, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS);
            const f = ctx.ledger.list().find((x) => x.card.cardId === cardId);
            if (!f) return "unknown cardId";
            // Cache hit (a leaf already pulled this series): serve from the per-turn
            // cache — no network, no synthetic /v1/contents call in the trace.
            const cached = f.card.webpageUrl ? ctx.contents.cache.get(f.card.webpageUrl) : undefined;
            if (cached) {
              fetched.set(cardId, cached);
              return excerptCsv(cached, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS);
            }
            const t0 = Date.now();
            const csv = await fetchContents(ctx, f.card.webpageUrl);
            const call: TakoCallRecord = {
              callId: `${ctx.rootId}:contents:${ctx.calls.length}`, nodeId: ctx.rootId,
              query: f.title, endpoint: "/v1/contents", effort: "fast", ms: Date.now() - t0,
              cards: [{ id: cardId, title: f.title, source: f.source, url: f.url }],
              ...(csv ? {} : { error: "no data available" }),
            };
            ctx.calls.push(call);
            ctx.emit?.({ type: "tako_call", call });
            if (!csv) return "no data available";
            fetched.set(cardId, csv);
            return excerptCsv(csv, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS);
          },
        }),
        get_web_content: tool({
          description: "Read the full text behind a WEB_SOURCES entry (by its url) when the snippet is not enough. Instant — the page was already fetched this turn.",
          parameters: z.object({ url: z.string() }),
          execute: async ({ url }) => {
            const w = ctx.webSources.find((s) => s.url === url);
            if (!w) return "unknown url";
            return (w.content || w.summary || "").slice(0, WEB_TOOL_CONTENT_CAP) || "no content available";
          },
        }),
      },
    });
    return { notes: res.text, fetched };
  } catch (e: unknown) {
    ctx.notes.push(`report gather failed — ${errorMessage(e)}`);
    return { notes: "", fetched };
  }
}

// Compose the final report from the tree's gathered evidence + on-demand card
// contents. Returns null when there's nothing to report (caller falls back).
export async function composeReport(ctx: ResearchCtx, question: string): Promise<AnswerReport | null> {
  if (ctx.figures.length === 0 && ctx.branchResults.length === 0) return null;

  const dataCards = ctx.ledger.list().filter((f) => f.kind === "data_card");

  // Catalogs only — no raw CSV or page content is inlined into either phase. The
  // gather loop reads what it needs; cached:true marks series a leaf already pulled
  // (instant cache reads), so the model can read them freely.
  const catalog = dataCards.map((f) => ({
    id: f.card.cardId, title: f.title, entity: f.section, source: f.source,
    description: f.card.description?.slice(0, 120),
    cached: !!(f.card.webpageUrl && ctx.contents.cache.get(f.card.webpageUrl)),
  }));
  const webCatalog = ctx.webSources
    .filter((w) => w.url)
    .map((w) => ({ url: w.url!, title: w.title, publisher: w.source, snippet: w.summary }));

  // Deterministic gather: the leaves already pulled the CSVs the report can chart —
  // serve them straight from the per-turn cache, question-relevant cards first, no
  // LLM in the loop. The tool-loop gather survives only as a fallback for the rare
  // turn where data cards exist but nothing got cached (e.g. the contents budget
  // ran dry mid-research).
  const questionLc = question.toLowerCase();
  const mentioned = (f: (typeof dataCards)[number]) =>
    [f.section, ...f.title.split(/\s+/)].some((t) => t && t.length >= 3 && questionLc.includes(t.toLowerCase()));
  const fetched = new Map<string, string>();
  dataCards
    .map((f, i) => ({ f, i, csv: f.card.webpageUrl ? ctx.contents.cache.get(f.card.webpageUrl) : undefined }))
    .filter((x): x is typeof x & { csv: string } => !!x.csv)
    .sort((a, b) => Number(mentioned(b.f)) - Number(mentioned(a.f)) || a.i - b.i)
    .slice(0, CARD_CONTENTS_PROMPT_CAP)
    .forEach((x) => {
      fetched.set(x.f.card.cardId, x.csv);
      // Trace visibility: the report consumed this series. Cache reads cost no
      // network, so the record is marked cached (ms 0) rather than left invisible.
      const call: TakoCallRecord = {
        callId: `${ctx.rootId}:contents:${ctx.calls.length}`, nodeId: ctx.rootId,
        query: x.f.title, endpoint: "/v1/contents", effort: "fast", ms: 0, cached: true,
        cards: [{ id: x.f.card.cardId, title: x.f.title, source: x.f.source, url: x.f.url }],
      };
      ctx.calls.push(call);
      ctx.emit?.({ type: "tako_call", call });
    });
  let analystNotes = "";
  if (fetched.size === 0 && catalog.length > 0) {
    const gathered = await gatherCardContents(ctx, question, catalog, webCatalog);
    analystNotes = gathered.notes;
    for (const [id, csv] of gathered.fetched) fetched.set(id, csv);
  }

  const subAnswers = ctx.branchResults.map((b) => ({
    question: b.question, claim: b.claim, confidence: b.confidence,
    keyFigures: b.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity })),
  }));
  // The report is a CUMULATIVE synthesis of the sub-answers — the prompt carries the
  // claims + a SLIM figure pool, not the whole evidence corpus. FIGURES drops entries
  // the sub-answers' keyFigures already carry, dedupes label|value repeats, and is
  // capped; numeric validation below still runs against the FULL ctx.figures + CSV
  // cache, so slimming the prompt can never make a real number untraceable.
  const inKeyFigures = new Set(ctx.branchResults.flatMap((b) => b.figures.map((f) => `${f.label}|${f.value}`)));
  const seenFig = new Set<string>();
  const figures = ctx.figures
    .filter((f) => {
      const k = `${f.label}|${f.value}`;
      if (inKeyFigures.has(k) || seenFig.has(k)) return false;
      seenFig.add(k);
      return true;
    })
    .slice(0, FIGURES_PROMPT_CAP)
    .map((f) => ({ label: f.label, value: f.value, entity: f.entity, source: f.source }));
  // Snippets only — the full page content stayed behind the gather phase's
  // get_web_content tool; what mattered is already distilled into ANALYST_NOTES.
  const webSources = ctx.webSources.slice(0, WEB_PROMPT_CAP).map((w) => ({
    title: w.title, publisher: w.source, snippet: w.summary?.slice(0, WEB_SNIPPET_CAP),
  }));
  // Cached reads are free for the gather loop, so it can over-read — the emit prompt
  // takes only the FIRST reads (the loop reads what it needs most first) at a bounded
  // excerpt. Everything read still feeds validation below.
  const cardContents = Array.from(fetched.entries()).slice(0, CARD_CONTENTS_PROMPT_CAP).map(([id, csv]) => ({
    cardId: id,
    title: catalog.find((c) => c.id === id)?.title,
    data: excerptCsv(csv, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS),
  }));

  const prompt = `${ctx.ctxText}\n\nQUESTION: ${question}\n\nSUB_ANSWERS: ${JSON.stringify(subAnswers)}\n\nFIGURES: ${JSON.stringify(figures)}\n\nWEB_SOURCES: ${JSON.stringify(webSources)}\n\nCARD_CONTENTS: ${JSON.stringify(cardContents)}\n\nANALYST_NOTES: ${analystNotes || "(none)"}`;
  log("tako", "answer-report prompt", {
    chars: prompt.length, subAnswers: subAnswers.length, figures: figures.length,
    cardContents: cardContents.length, read: fetched.size, web: webSources.length, catalog: catalog.length,
  });

  let report: z.infer<typeof zAnswerReportEmit>;
  try {
    report = await generateStructured({
      provider: "openai", model: deepModel(), reasoningEffort: synthEffort(),
      system: REPORT_SYSTEM, prompt, schema: zAnswerReportEmit, label: "answer-report",
    });
  } catch (e: unknown) {
    ctx.notes.push(`answer-report failed — ${errorMessage(e)}`);
    return null;
  }

  // Validate every number against gathered figures PLUS every card CSV pulled this
  // turn — the FULL per-turn cache, not just what the gather phase chose to read —
  // so real values cited via sub-answers never get dropped as untraceable.
  const csvDerived: GatheredFigure[] = [];
  const counted = new Set<string>();
  for (const [id, csv] of fetched) {
    counted.add(id);
    csvDerived.push(...csvFigures(csv, catalog.find((c) => c.id === id)?.title || id));
  }
  for (const f of dataCards) {
    if (counted.has(f.card.cardId)) continue;
    const csv = f.card.webpageUrl ? ctx.contents.cache.get(f.card.webpageUrl) : undefined;
    if (csv) csvDerived.push(...csvFigures(csv, f.title));
  }
  const allowed = allowedSets([...ctx.figures, ...csvDerived]);
  let dropped = 0;
  const droppedByKind: Record<string, number> = {};
  const blocks = report.blocks
    .map((b) => validateBlock(b, allowed, () => {
      dropped++;
      droppedByKind[b.kind] = (droppedByKind[b.kind] ?? 0) + 1;
    }))
    .filter((b): b is AnswerBlock => b !== null);
  if (dropped > 0 || blocks.length < report.blocks.length) {
    log("tako", "answer-report dropped untraceable numbers", {
      dropped, byKind: droppedByKind, prunedBlocks: report.blocks.length - blocks.length,
    });
  }
  // Graphy hero: modeled AFTER validation so it can reuse `allowed` (the full
  // figure + CSV-cache set) and the already-validated `blocks` for its fallback.
  let graphy: GraphyBlock | null = null;
  if (ctx.req.graphyEnabled) {
    graphy = await composeGraphyHero(ctx, question, report.verdict, blocks, cardContents, allowed);
  }
  return { verdict: report.verdict, blocks, ...(graphy ? { graphy } : {}) };
}

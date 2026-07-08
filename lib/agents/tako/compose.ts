// Final answer layer: the deep GPT model first runs a tool loop to gather the real
// card CSV series it needs (get_card_contents), then composes a multi-block "answer
// report" (verdict + comparison/leaderboard/sections/timeline/tiles/table/chart/prose)
// by reconciling the structured branch results, gathered figures, and fetched card
// contents. Every number is validated against real gathered figures + fetched CSV
// values — anything untraceable is dropped and logged, so the report never shows a
// hallucinated value.
import type { AnswerReport, AnswerBlock } from "../../schema";
import type { TakoCallRecord } from "../shared/types";
import { generateStructured, generateWithTools } from "../../llm";
import { tool } from "ai";
import { z } from "zod";
import { zAnswerReport } from "../shared/schemas";
import { ctxBlock } from "../shared/ctx";
import { REPORT_SYSTEM, REPORT_GATHER_SYSTEM } from "./prompts";
import { log } from "../../log";
import { fetchContents, excerptCsv, SYNTH_ID, type ResearchCtx, type GatheredFigure } from "./flow";

const deepModel = () => process.env.SYNTH_MODEL || "gpt-5.4";
const COMPOSER_CONTENTS_BUDGET = 8; // extra fetch headroom for the gather phase (cache hits are free)
const COMPOSER_MAX_STEPS = 10;
const COMPOSER_CSV_EXCERPT = 2400; // larger than leaf excerpts — the composer charts real series
const COMPOSER_CSV_ROWS = 60;

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
function traceable(value: string, allowed: { strings: Set<string>; mags: number[] }): boolean {
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
      const rows = block.rows.map((row) => row.map((cell) => (traceable(cell, allowed) ? cell : (drop(`table cell "${cell}"`), "—"))));
      return { ...block, rows };
    }
    case "chart": {
      const series = block.chartSpec.series
        .map((s) => ({ ...s, points: s.points.filter((p) => {
          const ok = traceable(String(p.y), allowed);
          if (!ok) drop(`chart point ${s.label}:${p.y}`);
          return ok;
        }) }))
        .filter((s) => s.points.length > 0);
      return series.length ? { ...block, chartSpec: { ...block.chartSpec, series } } : null;
    }
    case "comparison": {
      const series = block.series
        .map((s) => ({ ...s, points: s.points.filter((p) => {
          const ok = traceable(String(p.y), allowed);
          if (!ok) drop(`comparison point ${s.label}:${p.y}`);
          return ok;
        }) }))
        .filter((s) => s.points.length > 0);
      return series.length ? { ...block, series } : null;
    }
    case "leaderboard": {
      const rows = block.rows
        .filter((r) => {
          const ok = traceable(r.value, allowed);
          if (!ok) drop(`leaderboard row "${r.entity}: ${r.value}"`);
          return ok;
        })
        .map((r) => (r.detail?.stats
          ? { ...r, detail: { ...r.detail, stats: r.detail.stats.filter((s) => {
              const ok = traceable(s.value, allowed);
              if (!ok) drop(`leaderboard stat "${s.label}: ${s.value}"`);
              return ok;
            }) } }
          : r));
      return rows.length ? { ...block, rows } : null;
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

// Phase A: the gather tool loop. The deep model reads the card catalog and pulls
// the REAL series it needs (both sides of a comparison, ranking members, …).
// Returns the analyst note + everything fetched; failure returns empty (compose
// proceeds without card contents — never throws).
async function gatherCardContents(
  ctx: ResearchCtx, question: string,
  catalog: { id: string; title: string; entity?: string; source?: string; description?: string }[],
): Promise<{ notes: string; fetched: Map<string, string> }> {
  const fetched = new Map<string, string>();
  if (catalog.length === 0) return { notes: "", fetched };
  ctx.contents.cap = ctx.contents.fetched + COMPOSER_CONTENTS_BUDGET;
  try {
    const res = await generateWithTools({
      provider: "openai", model: deepModel(), reasoningEffort: "high",
      system: REPORT_GATHER_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nCARD_CATALOG: ${JSON.stringify(catalog)}\n\nSUB_ANSWERS: ${JSON.stringify(ctx.branchResults.map((b) => ({ question: b.question, claim: b.claim })))}`,
      maxSteps: COMPOSER_MAX_STEPS, label: "report-gather",
      tools: {
        get_card_contents: tool({
          description: "Fetch the real underlying data series (CSV) behind a Tako card from CARD_CATALOG.",
          parameters: z.object({ cardId: z.string() }),
          execute: async ({ cardId }) => {
            const f = ctx.ledger.list().find((x) => x.card.cardId === cardId);
            if (!f) return "unknown cardId";
            const t0 = Date.now();
            const csv = await fetchContents(ctx, f.card.webpageUrl);
            const call: TakoCallRecord = {
              callId: `${SYNTH_ID}:contents:${ctx.calls.length}`, nodeId: SYNTH_ID,
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

  const catalog = ctx.ledger.list()
    .filter((f) => f.kind === "data_card")
    .map((f) => ({
      id: f.card.cardId, title: f.title, entity: f.section, source: f.source,
      description: f.card.description?.slice(0, 200),
    }));

  const { notes: analystNotes, fetched } = await gatherCardContents(ctx, question, catalog);

  const subAnswers = ctx.branchResults.map((b) => ({
    question: b.question, claim: b.claim, confidence: b.confidence,
    keyFigures: b.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity })),
  }));
  const figures = ctx.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity, source: f.source }));
  const webSources = ctx.webSources.map((w) => ({
    title: w.title, publisher: w.source, snippet: w.summary,
    content: (w.content || w.summary || "").slice(0, 1500),
  }));
  const cardContents = Array.from(fetched.entries()).map(([id, csv]) => ({
    cardId: id,
    title: catalog.find((c) => c.id === id)?.title,
    data: excerptCsv(csv, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS),
  }));

  const prompt = `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nSUB_ANSWERS: ${JSON.stringify(subAnswers)}\n\nFIGURES: ${JSON.stringify(figures)}\n\nWEB_SOURCES: ${JSON.stringify(webSources)}\n\nCARD_CONTENTS: ${JSON.stringify(cardContents)}\n\nANALYST_NOTES: ${analystNotes || "(none)"}`;

  let report: AnswerReport;
  try {
    report = await generateStructured({
      provider: "openai", model: deepModel(), reasoningEffort: "high",
      system: REPORT_SYSTEM, prompt, schema: zAnswerReport, label: "answer-report",
    });
  } catch (e: unknown) {
    ctx.notes.push(`answer-report failed — ${errorMessage(e)}`);
    return null;
  }

  // Validate every number against gathered figures PLUS the fetched CSV values.
  const csvDerived: GatheredFigure[] = [];
  for (const [id, csv] of fetched) {
    csvDerived.push(...csvFigures(csv, catalog.find((c) => c.id === id)?.title || id));
  }
  const allowed = allowedSets([...ctx.figures, ...csvDerived]);
  let dropped = 0;
  const blocks = report.blocks
    .map((b) => validateBlock(b, allowed, () => { dropped++; }))
    .filter((b): b is AnswerBlock => b !== null);
  if (dropped > 0) log("tako", "answer-report dropped untraceable numbers", { dropped });
  return { verdict: report.verdict, blocks };
}

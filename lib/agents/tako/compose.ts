// Final answer layer: Claude composes a multi-block "answer report" (verdict +
// table/chart/tiles/prose) by reconciling the structured branch results and the
// gathered figures. Every number is validated against real gathered figures —
// anything untraceable is dropped and logged, so the report never shows a
// hallucinated value.
import type { AnswerReport, AnswerBlock } from "../../schema";
import { generateStructured } from "../../llm";
import { zAnswerReport } from "../shared/schemas";
import { ctxBlock } from "../shared/ctx";
import { REPORT_SYSTEM } from "./prompts";
import { log } from "../../log";
import type { ResearchCtx, GatheredFigure } from "./research";

const ANTHROPIC = "anthropic" as const;

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

// Compose the final report from the tree's gathered evidence. Returns null when
// there's nothing to report (caller falls back to a plain chat answer).
export async function composeReport(ctx: ResearchCtx, question: string): Promise<AnswerReport | null> {
  if (ctx.figures.length === 0 && ctx.branchResults.length === 0) return null;
  const subAnswers = ctx.branchResults.map((b) => ({
    question: b.question, claim: b.claim, confidence: b.confidence,
    keyFigures: b.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity })),
  }));
  const figures = ctx.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity, source: f.source }));
  const webSources = ctx.webSources.map((w) => ({
    title: w.title, publisher: w.source, snippet: w.summary,
    content: (w.content || w.summary || "").slice(0, 1500),
  }));

  const prompt = `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nSUB_ANSWERS: ${JSON.stringify(subAnswers)}\n\nFIGURES: ${JSON.stringify(figures)}\n\nWEB_SOURCES: ${JSON.stringify(webSources)}`;
  let report: AnswerReport;
  try {
    report = await generateStructured({ provider: ANTHROPIC, system: REPORT_SYSTEM, prompt, schema: zAnswerReport, label: "answer-report" });
  } catch (e: unknown) {
    // Claude is the preferred final layer; if it's unavailable (no key / error),
    // fall back to the deep GPT model so the composed report still works.
    ctx.notes.push(`answer-report via Claude failed, falling back to GPT — ${e instanceof Error ? e.message : String(e)}`);
    try {
      report = await generateStructured({
        provider: "openai", model: process.env.SYNTH_MODEL || "gpt-5.4",
        system: REPORT_SYSTEM, prompt, schema: zAnswerReport, label: "answer-report-fallback",
      });
    } catch (e2: unknown) {
      ctx.notes.push(`answer-report fallback failed — ${e2 instanceof Error ? e2.message : String(e2)}`);
      return null;
    }
  }

  // Validate every number against the gathered figures; drop the untraceable.
  const allowed = allowedSets(ctx.figures);
  let dropped = 0;
  const blocks = report.blocks
    .map((b) => validateBlock(b, allowed, () => { dropped++; }))
    .filter((b): b is AnswerBlock => b !== null);
  if (dropped > 0) log("tako", "answer-report dropped untraceable numbers", { dropped });
  return { verdict: report.verdict, blocks };
}

// Graphy hero chart layer. When the per-turn "graphy chart" toggle is on, the
// synthesis report gains ONE flagship Graphy chart modeled from the Tako card CSVs
// the compose step already fetched. Accuracy is ENFORCED, not assumed: every
// numeric cell (x/category column exempt, mirroring validateBlock's table rule)
// must trace to a fetched figure or the row is dropped; a mostly-untraceable or
// degenerate config is discarded entirely and the deterministic fallback — the
// report's first (already-validated) chart/comparison block converted to a
// GraphConfig — takes its place. The Graphy chart can never show a number Tako
// didn't return this turn.
import type { AnswerBlock, GraphyBlock, GraphyConfig } from "../../schema";
import { traceable } from "./compose";
import { generateStructured } from "../../llm";
import { zGraphyBlock } from "../shared/schemas";
import { GRAPHY_SYSTEM } from "./prompts";
import { log } from "../../log";
import type { ResearchCtx } from "./flow";

const MAX_ROWS = 60; // keep the node card light

type Allowed = { strings: Set<string>; mags: number[] };

// Prune untraceable rows; discard the config when the chart would misrepresent the
// data: majority of numeric cells untraceable (same 2× rule as compose's table
// validation) or fewer than 2 surviving rows.
export function enforceTraceable(
  config: GraphyConfig, allowed: Allowed, drop: (why: string) => void,
): GraphyConfig | null {
  const xKey = config.data.columns[0]?.key;
  let numeric = 0, bad = 0;
  const rowOk = config.data.rows.map((row) => {
    let ok = true;
    for (const [key, value] of Object.entries(row)) {
      if (key === xKey) continue; // x/category labels (years, entity names) are exempt
      if (!/\d/.test(String(value))) continue; // pure text cell
      numeric++;
      if (!traceable(String(value), allowed)) {
        bad++;
        ok = false;
        drop(`graphy cell ${key}:${value}`);
      }
    }
    return ok;
  });
  if (bad === 0 && config.data.rows.length >= 2) return config;
  if (bad * 2 > numeric) return null;
  const rows = config.data.rows.filter((_, i) => rowOk[i]);
  if (rows.length < 2) return null;
  return { ...config, data: { ...config.data, rows } };
}

// Convert chartSpec-shaped series (shared by "chart" and "comparison" blocks) to a
// GraphConfig: first column = x, one column per series, rows aligned by x value.
export function seriesToGraphyConfig(
  kind: "bar" | "line",
  series: { label: string; points: { x: string | number; y: number }[] }[],
): GraphyConfig {
  const xs: (string | number)[] = [];
  const seen = new Set<string>();
  for (const s of series) for (const p of s.points) {
    const k = String(p.x);
    if (!seen.has(k)) { seen.add(k); xs.push(p.x); }
  }
  const columns = [
    { key: "x", label: "Category" },
    ...series.map((s, i) => ({ key: `s${i}`, label: s.label })),
  ];
  const rows = xs.slice(0, MAX_ROWS).map((x) => {
    const row: Record<string, string | number> = { x: typeof x === "number" ? x : String(x) };
    series.forEach((s, i) => {
      const p = s.points.find((pt) => String(pt.x) === String(x));
      if (p) row[`s${i}`] = p.y;
    });
    return row;
  });
  return { type: kind === "bar" ? "column" : "line", data: { columns, rows } };
}

// Deterministic fallback: the report's first chart or comparison block already
// passed composeReport's numeric validation, so its conversion needs no re-check.
export function fallbackGraphyBlock(blocks: AnswerBlock[]): GraphyBlock | null {
  for (const b of blocks) {
    if (b.kind === "chart") {
      return { ...(b.title ? { title: b.title } : {}), config: seriesToGraphyConfig(b.chartSpec.kind, b.chartSpec.series) };
    }
    if (b.kind === "comparison") {
      return { ...(b.title ? { title: b.title } : {}), config: seriesToGraphyConfig("line", b.series) };
    }
  }
  return null;
}

// Same model family as the report emit (compose.ts deepModel) — chart modeling is
// part of the synthesis tail; effort stays low, the input is a small digest.
const heroModel = () => process.env.SYNTH_MODEL || "gpt-5.4";

// Model ONE hero Graphy chart from this turn's fetched card CSVs. Failure is never
// user-facing: LLM error, schema mismatch, or accuracy-validation discard all fall
// back to converting the report's first (already validated) chart/comparison block;
// with no convertible block the report simply ships without a hero.
// Every attempt is traced: a live "graphy" event streams the outcome to the chat
// UI, ctx.graphyTrace persists it on the turn trace, and the shipped block carries
// `source` ("modeled" | "fallback") so the chart can badge its own provenance.
export async function composeGraphyHero(
  ctx: ResearchCtx, question: string, verdict: string, blocks: AnswerBlock[],
  cardContents: { cardId: string; title?: string; data: string }[],
  allowed: Allowed,
): Promise<GraphyBlock | null> {
  const finish = (block: GraphyBlock | null, ms: number, dropped: number): GraphyBlock | null => {
    const info = {
      outcome: (block ? block.source : "none") as "modeled" | "fallback" | "none",
      ms,
      ...(block ? { series: block.config.data.columns.length - 1, rows: block.config.data.rows.length } : {}),
      ...(dropped ? { dropped } : {}),
    };
    ctx.graphyTrace = info;
    ctx.emit?.({ type: "graphy", info });
    return block;
  };

  let dropped = 0;
  const t0 = Date.now();
  if (cardContents.length > 0) {
    ctx.emit?.({ type: "trace", stage: "modeling graphy chart" });
    try {
      const hero = await generateStructured({
        provider: "openai", model: heroModel(), reasoningEffort: "low",
        system: GRAPHY_SYSTEM,
        prompt: `QUESTION: ${question}\n\nVERDICT: ${verdict}\n\nCARD_CONTENTS: ${JSON.stringify(cardContents)}`,
        schema: zGraphyBlock, label: "graphy-hero",
      });
      const config = enforceTraceable(hero.config, allowed, () => { dropped++; });
      if (config) {
        if (dropped > 0) log("tako", "graphy-hero pruned untraceable cells", { dropped });
        return finish({ ...hero, config, source: "modeled" }, Date.now() - t0, dropped);
      }
      ctx.notes.push(`graphy hero discarded — ${dropped} untraceable values, using fallback`);
    } catch (e: unknown) {
      ctx.notes.push(`graphy hero failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    ctx.notes.push("graphy hero skipped — no card contents fetched this turn");
  }
  const fallback = fallbackGraphyBlock(blocks);
  if (!fallback) log("tako", "graphy hero unavailable — no convertible block");
  return finish(fallback ? { ...fallback, source: "fallback" } : null, Date.now() - t0, dropped);
}

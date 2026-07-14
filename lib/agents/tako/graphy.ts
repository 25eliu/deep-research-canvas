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

"use client";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import type { AnswerBlock } from "@/lib/schema";
import {
  SERIES_COLORS, AXIS_TICK, GRID_STROKE, BASELINE_STROKE,
  fmtNum, fmtTick, fmtXLabel, xAxisLayout, yAxisWidth, TOOLTIP_STYLES,
} from "../charts/theme";

type ComparisonBlock = Extract<AnswerBlock, { kind: "comparison" }>;

export { SERIES_COLORS };

// The union of x values is built in first-appearance order across series, which
// zigzags when series are interleaved (A: 2022,2024; B: 2023). When every value
// is orderable (all numeric, or all date-parseable) sort the domain so the axis
// — and every line built from it — is monotonic; otherwise keep appearance order
// (e.g. categorical labels like quarters/segments have no universal ordering here).
export function sortedDomain(xs: string[]): string[] {
  if (xs.every((x) => Number.isFinite(Number(x)))) {
    return [...xs].sort((a, b) => Number(a) - Number(b));
  }
  if (xs.every((x) => !isNaN(Date.parse(x)))) {
    return [...xs].sort((a, b) => Date.parse(a) - Date.parse(b));
  }
  return xs;
}

// Multi-entity overlay built from REAL card series, on recharts: shared sorted x
// domain, shared y scale, one fixed-order color per entity (index-stable so a
// series keeps its color between renders), legend chips carrying the latest
// value, hover tooltip, optional insight line beneath. Explicit `width` exists
// for tests — jsdom can't measure ResponsiveContainer.
export default function ComparisonChart({ block, width, height = 264 }: {
  block: ComparisonBlock; width?: number; height?: number;
}) {
  const rawXs: string[] = [];
  for (const s of block.series) for (const p of s.points) {
    const k = String(p.x);
    if (!rawXs.includes(k)) rawXs.push(k);
  }
  const xs = sortedDomain(rawXs);
  const ys = block.series.flatMap((s) => s.points.map((p) => p.y));
  if (!xs.length || !ys.length) return <div className="empty-note">no data</div>;

  // One row per domain value; each series contributes its y under its label key.
  const rows = xs.map((xv) => {
    const row: Record<string, string | number> = { x: fmtXLabel(xv) };
    for (const s of block.series) {
      const p = s.points.find((pt) => String(pt.x) === xv);
      if (p) row[s.label] = p.y;
    }
    return row;
  });
  const xl = xAxisLayout(rows.map((r) => String(r.x)));
  const asLines = block.series.every((s) => s.points.length >= 3);
  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

  // Children as an array, not a fragment — recharts scans direct children.
  const parts = [
    <CartesianGrid key="grid" vertical={false} stroke={GRID_STROKE} />,
    <XAxis
      key="x" dataKey="x" interval="preserveStartEnd" minTickGap={xl.angle ? 4 : 18}
      angle={xl.angle} tick={{ ...AXIS_TICK, textAnchor: xl.textAnchor }}
      height={xl.height} tickLine={false} axisLine={{ stroke: BASELINE_STROKE }}
    />,
    <YAxis
      key="y" tick={AXIS_TICK} tickFormatter={fmtTick}
      width={yAxisWidth(ys)} tickLine={false} axisLine={false}
    />,
    <Tooltip key="tip" {...TOOLTIP_STYLES} formatter={(v) => fmtNum(Number(v))} />,
    ...block.series.map((s, i) => asLines
      ? <Line
          key={s.label} type="monotone" dataKey={s.label} stroke={color(i)} strokeWidth={2}
          dot={{ r: 2.6, fill: "var(--surface)", stroke: color(i), strokeWidth: 1.5 }}
          activeDot={{ r: 4.5 }} connectNulls isAnimationActive={false}
        />
      : <Bar key={s.label} dataKey={s.label} fill={color(i)} radius={[4, 4, 0, 0]} isAnimationActive={false} />),
  ];
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };
  const chart = asLines
    ? <LineChart {...(width ? { width, height } : {})} data={rows} margin={margin}>{parts}</LineChart>
    : <BarChart {...(width ? { width, height } : {})} data={rows} margin={margin} barCategoryGap="20%" barGap={2}>{parts}</BarChart>;

  return (
    <div className="report-comparison">
      {block.title ? <div className="report-chart-title">{block.title}</div> : null}
      <div className="comparison-legend">
        {block.series.map((s, i) => {
          const last = s.points[s.points.length - 1];
          return (
            <span key={s.label} className="comparison-chip">
              <span className="comparison-swatch" style={{ background: color(i) }} />
              {s.label}
              {last ? <strong>{fmtNum(last.y)}</strong> : null}
            </span>
          );
        })}
        {block.unit ? <span className="comparison-unit">{block.unit}</span> : null}
      </div>
      <div className="chart-frame" role="img" aria-label={block.title || "comparison chart"}>
        {width ? chart : <ResponsiveContainer width="100%" height={height}>{chart}</ResponsiveContainer>}
      </div>
      {block.insight ? <div className="comparison-insight">{block.insight}</div> : null}
    </div>
  );
}

"use client";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import type { ChartSpec } from "@/lib/schema";
import {
  AXIS_TICK, GRID_STROKE, BASELINE_STROKE,
  fmtNum, fmtTick, fmtXLabel, xAxisLayout, yAxisWidth, TOOLTIP_STYLES,
} from "./charts/theme";

// Single-series card chart (data_card fallback + report "chart"/section figures),
// built on recharts: horizontal gridlines, compact y ticks, thinned/angled x labels
// that are never string-truncated, and a hover tooltip with the full label+value.
// Explicit `width` exists for tests — jsdom can't measure ResponsiveContainer.
export default function MiniChart({ spec, width, height = 176 }: {
  spec: ChartSpec; width?: number; height?: number;
}) {
  const pts = spec.series[0]?.points || [];
  if (!pts.length) return <div className="empty-note">no data</div>;
  const rows = pts.map((p) => ({ x: fmtXLabel(p.x), y: p.y }));
  const xl = xAxisLayout(rows.map((r) => r.x));
  const seriesName = spec.unit || spec.series[0]?.label || "value";

  // Children go in as an array (not a fragment) — recharts resolves axes/marks by
  // scanning direct children and does not see through fragments.
  const parts = [
    <CartesianGrid key="grid" vertical={false} stroke={GRID_STROKE} />,
    <XAxis
      key="x" dataKey="x" interval="preserveStartEnd" minTickGap={xl.angle ? 4 : 18}
      angle={xl.angle} tick={{ ...AXIS_TICK, textAnchor: xl.textAnchor }}
      height={xl.height} tickLine={false} axisLine={{ stroke: BASELINE_STROKE }}
    />,
    <YAxis
      key="y" tick={AXIS_TICK} tickFormatter={fmtTick}
      width={yAxisWidth(rows.map((r) => r.y))} tickLine={false} axisLine={false}
    />,
    <Tooltip key="tip" {...TOOLTIP_STYLES} formatter={(v) => [fmtNum(Number(v)), seriesName]} />,
    spec.kind === "bar"
      ? <Bar key="mark" dataKey="y" fill="var(--amber)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
      : <Line
          key="mark" type="monotone" dataKey="y" stroke="var(--amber)" strokeWidth={2}
          dot={{ r: 2.4, fill: "var(--surface)", stroke: "var(--amber)", strokeWidth: 1.5 }}
          activeDot={{ r: 4 }} isAnimationActive={false}
        />,
  ];
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };
  const chart = spec.kind === "bar"
    ? <BarChart {...(width ? { width, height } : {})} data={rows} margin={margin} barCategoryGap="22%">{parts}</BarChart>
    : <LineChart {...(width ? { width, height } : {})} data={rows} margin={margin}>{parts}</LineChart>;

  return (
    <div className="chart-frame" role="img" aria-label={spec.series[0]?.label || "chart"}>
      {spec.unit ? <div className="chart-unit">{spec.unit}</div> : null}
      {width ? chart : <ResponsiveContainer width="100%" height={height}>{chart}</ResponsiveContainer>}
    </div>
  );
}

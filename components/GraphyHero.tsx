"use client";
import { Component, type ReactNode } from "react";
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar,
  PieChart, Pie, Cell, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import type { GraphyBlock } from "@/lib/schema";
import {
  SERIES_COLORS, AXIS_TICK, GRID_STROKE, BASELINE_STROKE,
  fmtNum, fmtTick, fmtXLabel, xAxisLayout, yAxisWidth, TOOLTIP_STYLES,
} from "./charts/theme";

// A render crash in the local recharts translation must never take down the
// synthesis node card — the SDK swap-in later carries the same risk surface.
class GraphyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

// Same fixed-order palette as ComparisonChart; modulo so a stray >6-series config
// degrades to repeated colors instead of a missing series.
const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

// Series cells can arrive as formatted strings ("$26,974", "-3.1%"); strip
// everything but digits/sign/decimal/exponent and let NaN mark a gap. Cells with
// no digit at all ("N/A", "TBD") must gap too — stripping them yields "" and
// Number("") === 0, which would fabricate a real-looking zero on a chart whose
// numbers are server-enforced traceable.
function parseCell(v: string | number | undefined): number {
  if (v === undefined) return NaN;
  if (typeof v === "number") return v;
  if (!/\d/.test(String(v))) return NaN;
  return Number(String(v).replace(/[^0-9.eE-]/g, ""));
}

export default function GraphyHero({ block, width }: { block: GraphyBlock; width?: number }) {
  const { config, title, subtitle } = block;
  const [xCol, ...seriesCols] = config.data.columns;
  if (!xCol || !seriesCols.length || !config.data.rows.length) return null;

  // One row per input row: x cell formatted for display, series cells parsed to
  // numbers with non-numeric cells omitted (recharts gaps missing points).
  const rows = config.data.rows.map((r) => {
    const row: Record<string, string | number> = { x: fmtXLabel(r[xCol.key] ?? "") };
    for (const c of seriesCols) {
      const n = parseCell(r[c.key]);
      if (!Number.isNaN(n)) row[c.key] = n;
    }
    return row;
  });
  const hasNumeric = rows.some((r) => seriesCols.some((c) => typeof r[c.key] === "number"));
  if (!hasNumeric) return null;

  const height = 200;
  const isPie = config.type === "pie" || config.type === "donut";
  const showLegend = !isPie && seriesCols.length >= 2;
  const margin = { top: 8, right: 12, bottom: 0, left: 0 };

  let chart: ReactNode;
  if (isPie) {
    // First series column is the value; x column is the slice name.
    const valueKey = seriesCols[0].key;
    const pieRows = rows
      .filter((r) => typeof r[valueKey] === "number")
      .map((r) => ({ name: String(r.x), value: r[valueKey] as number }));
    if (!pieRows.length) return null;
    const parts = [
      <Tooltip key="tip" {...TOOLTIP_STYLES} formatter={(v: number) => fmtNum(Number(v))} />,
      <Pie
        key="pie" data={pieRows} dataKey="value" nameKey="name" cx="50%" cy="50%"
        outerRadius="80%" innerRadius={config.type === "donut" ? "55%" : 0} isAnimationActive={false}
      >
        {pieRows.map((_, i) => <Cell key={i} fill={seriesColor(i)} />)}
      </Pie>,
    ];
    chart = <PieChart {...(width ? { width, height } : {})}>{parts}</PieChart>;
  } else {
    const numericValues = rows.flatMap((r) => seriesCols
      .map((c) => r[c.key])
      .filter((v): v is number => typeof v === "number"));
    const xl = xAxisLayout(rows.map((r) => String(r.x)));
    const legendPart = showLegend ? [<Legend key="legend" wrapperStyle={{ fontSize: 11 }} />] : [];

    if (config.type === "bar") {
      // Horizontal bars: values on x, categories on y.
      const parts = [
        <CartesianGrid key="grid" horizontal={false} stroke={GRID_STROKE} />,
        <XAxis
          key="x" type="number" tick={AXIS_TICK} tickFormatter={fmtTick}
          tickLine={false} axisLine={{ stroke: BASELINE_STROKE }}
        />,
        <YAxis
          key="y" type="category" dataKey="x" tick={AXIS_TICK}
          width={yAxisWidth(numericValues)} tickLine={false} axisLine={false}
        />,
        <Tooltip key="tip" {...TOOLTIP_STYLES} formatter={(v: number) => fmtNum(Number(v))} />,
        ...legendPart,
        ...seriesCols.map((c, i) => (
          <Bar key={c.key} name={c.label} dataKey={c.key} fill={seriesColor(i)} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        )),
      ];
      chart = (
        <BarChart {...(width ? { width, height } : {})} data={rows} layout="vertical" margin={margin} barCategoryGap="22%">
          {parts}
        </BarChart>
      );
    } else if (config.type === "scatter") {
      const parts = [
        <CartesianGrid key="grid" stroke={GRID_STROKE} />,
        <XAxis
          key="x" dataKey="x" type="category" tick={AXIS_TICK} tickLine={false}
          axisLine={{ stroke: BASELINE_STROKE }}
        />,
        <YAxis
          key="y" type="number" tick={AXIS_TICK} tickFormatter={fmtTick}
          width={yAxisWidth(numericValues)} tickLine={false} axisLine={false}
        />,
        <Tooltip key="tip" {...TOOLTIP_STYLES} formatter={(v: number) => fmtNum(Number(v))} />,
        ...legendPart,
        ...seriesCols.map((c, i) => (
          <Scatter key={c.key} name={c.label} dataKey={c.key} data={rows} fill={seriesColor(i)} isAnimationActive={false} />
        )),
      ];
      chart = <ScatterChart {...(width ? { width, height } : {})} margin={margin}>{parts}</ScatterChart>;
    } else {
      // line / area / column share the same axes shape.
      const parts = [
        <CartesianGrid key="grid" vertical={false} stroke={GRID_STROKE} />,
        <XAxis
          key="x" dataKey="x" interval="preserveStartEnd" minTickGap={xl.angle ? 4 : 18}
          angle={xl.angle} tick={{ ...AXIS_TICK, textAnchor: xl.textAnchor }}
          height={xl.height} tickLine={false} axisLine={{ stroke: BASELINE_STROKE }}
        />,
        <YAxis
          key="y" tick={AXIS_TICK} tickFormatter={fmtTick}
          width={yAxisWidth(numericValues)} tickLine={false} axisLine={false}
        />,
        <Tooltip key="tip" {...TOOLTIP_STYLES} formatter={(v: number) => fmtNum(Number(v))} />,
        ...legendPart,
        ...(config.type === "area"
          ? seriesCols.map((c, i) => (
              <Area
                key={c.key} type="monotone" name={c.label} dataKey={c.key}
                stroke={seriesColor(i)} fill={seriesColor(i)} fillOpacity={0.18}
                strokeWidth={2} connectNulls isAnimationActive={false}
              />
            ))
          : config.type === "column"
          ? seriesCols.map((c, i) => (
              <Bar key={c.key} name={c.label} dataKey={c.key} fill={seriesColor(i)} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            ))
          : seriesCols.map((c, i) => (
              <Line
                key={c.key} type="monotone" name={c.label} dataKey={c.key} stroke={seriesColor(i)} strokeWidth={2}
                dot={{ r: 2.4, fill: "var(--surface)", stroke: seriesColor(i), strokeWidth: 1.5 }}
                activeDot={{ r: 4 }} connectNulls isAnimationActive={false}
              />
            ))),
      ];
      const props = { ...(width ? { width, height } : {}), data: rows, margin };
      chart = config.type === "area"
        ? <AreaChart {...props}>{parts}</AreaChart>
        : config.type === "column"
        ? <BarChart {...props} barCategoryGap="22%">{parts}</BarChart>
        : <LineChart {...props}>{parts}</LineChart>;
    }
  }

  return (
    <GraphyBoundary>
      <div className="report-graphy" role="img" aria-label={title || "chart"}>
        {title ? <div className="report-chart-title">{title}</div> : null}
        {subtitle ? <div className="report-graphy-subtitle">{subtitle}</div> : null}
        {width ? chart : <ResponsiveContainer width="100%" height={height}>{chart}</ResponsiveContainer>}
      </div>
    </GraphyBoundary>
  );
}

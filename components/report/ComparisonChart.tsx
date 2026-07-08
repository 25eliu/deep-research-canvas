"use client";
import type { AnswerBlock } from "@/lib/schema";

type ComparisonBlock = Extract<AnswerBlock, { kind: "comparison" }>;

// Categorical palette (colorblind-safe, Observable-10-derived). Index-stable so a
// series keeps its color between renders.
export const SERIES_COLORS = ["#4269d0", "#efb118", "#ff725c", "#6cc5b0", "#a463f2", "#9c6b4e"];

const W = 560, H = 240, PAD = 34;

function fmt(n: number): string {
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
}

// Multi-entity overlay built from REAL card series: shared x domain (union, in
// first-appearance order), shared y scale, one color per entity, legend chips
// carrying the latest value, optional insight line beneath.
export default function ComparisonChart({ block }: { block: ComparisonBlock }) {
  const xs: string[] = [];
  for (const s of block.series) for (const p of s.points) {
    const k = String(p.x);
    if (!xs.includes(k)) xs.push(k);
  }
  const ys = block.series.flatMap((s) => s.points.map((p) => p.y));
  if (!xs.length || !ys.length) return <div className="empty-note">no data</div>;
  const max = Math.max(...ys, 0), min = Math.min(...ys, 0);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(xs.length - 1, 1);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const asLines = block.series.every((s) => s.points.length >= 3);

  return (
    <div className="report-comparison">
      {block.title ? <div className="report-chart-title">{block.title}</div> : null}
      <div className="comparison-legend">
        {block.series.map((s, i) => {
          const last = s.points[s.points.length - 1];
          return (
            <span key={s.label} className="comparison-chip">
              <span className="comparison-swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {s.label}
              {last ? <strong>{fmt(last.y)}</strong> : null}
            </span>
          );
        })}
        {block.unit ? <span className="comparison-unit">{block.unit}</span> : null}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={block.title || "comparison chart"}>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line-strong, #ccc)" />
        {asLines
          ? block.series.map((s, si) => (
              <g key={s.label}>
                <polyline
                  fill="none" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth={2.2}
                  strokeLinejoin="round" strokeLinecap="round"
                  points={s.points.map((p) => `${x(xs.indexOf(String(p.x)))},${y(p.y)}`).join(" ")}
                />
                {s.points.map((p, i) => (
                  <circle key={i} cx={x(xs.indexOf(String(p.x)))} cy={y(p.y)} r={2.8}
                    fill="#fff" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth={1.6}>
                    <title>{`${s.label} ${p.x}: ${fmt(p.y)}`}</title>
                  </circle>
                ))}
              </g>
            ))
          : xs.map((xv, xi) => {
              const group = (W - 2 * PAD) / xs.length;
              const bw = Math.max(4, (group - 10) / block.series.length);
              return block.series.map((s, si) => {
                const p = s.points.find((pt) => String(pt.x) === xv);
                if (!p) return null;
                const bx = PAD + xi * group + 5 + si * bw;
                return (
                  <rect key={`${s.label}-${xv}`} x={bx} y={y(p.y)} width={bw - 2}
                    height={Math.max(0, H - PAD - y(p.y))} rx={2}
                    fill={SERIES_COLORS[si % SERIES_COLORS.length]} opacity={0.9}>
                    <title>{`${s.label} ${xv}: ${fmt(p.y)}`}</title>
                  </rect>
                );
              });
            })}
        {xs.map((xv, i) => (
          <text key={xv} x={asLines ? x(i) : PAD + (i + 0.5) * ((W - 2 * PAD) / xs.length)} y={H - PAD + 14}
            fontSize={10} fill="var(--muted, #888)" textAnchor="middle">
            {xv.slice(0, 7)}
          </text>
        ))}
      </svg>
      {block.insight ? <div className="comparison-insight">{block.insight}</div> : null}
    </div>
  );
}

"use client";
import type { ChartSpec } from "@/lib/schema";

export default function MiniChart({ spec }: { spec: ChartSpec }) {
  const W = 274, H = 132, pad = 24;
  const pts = spec.series[0]?.points || [];
  if (!pts.length) return <div className="empty-note">no data</div>;
  const ys = pts.map((p) => p.y);
  const max = Math.max(...ys, 0), min = Math.min(...ys, 0);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / Math.max(pts.length - 1, 1);
  const y = (v: number) => H - pad - ((v - min) / span) * (H - 2 * pad);

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--line-strong)" />
      {spec.kind === "bar"
        ? pts.map((p, i) => {
            const bw = (W - 2 * pad) / pts.length - 6;
            return (
              <rect key={i} x={x(i) - bw / 2} y={y(p.y)} width={bw}
                height={H - pad - y(p.y)} fill="var(--amber)" opacity={0.9} rx={3} />
            );
          })
        : (
          <>
            <polyline fill="none" stroke="var(--amber)" strokeWidth={2.2}
              strokeLinejoin="round" strokeLinecap="round"
              points={pts.map((p, i) => `${x(i)},${y(p.y)}`).join(" ")} />
            {pts.map((p, i) => (
              <circle key={"c" + i} cx={x(i)} cy={y(p.y)} r={2.6} fill="#fff" stroke="var(--amber)" strokeWidth={1.6} />
            ))}
          </>
        )}
      {pts.map((p, i) => (
        <text key={"l" + i} x={x(i)} y={H - pad + 13} fontSize={9} fill="var(--muted)" textAnchor="middle">
          {String(p.x).slice(0, 6)}
        </text>
      ))}
      {spec.unit && <text x={pad} y={13} fontSize={9} fill="var(--muted)">{spec.unit}</text>}
    </svg>
  );
}

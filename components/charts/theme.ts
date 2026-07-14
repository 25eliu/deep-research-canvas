// Shared theming for the recharts-based charts. Marks ride the app's CSS variables
// so charts inherit the warm-paper theme; the categorical palette below is
// fixed-order (never cycled — slot order is the CVD-safety mechanism) and was
// validated against the white card surface with the dataviz six-checks script:
// lightness band, chroma floor, adjacent-pair CVD ΔE ≥ 12, contrast. The two
// slots that sit under 3:1 contrast (aqua, yellow) are relieved by the legend
// chips carrying values and by per-mark tooltips.
export const SERIES_COLORS = ["#2a78d6", "#1baf7a", "#eda100", "#008300", "#4a3aa7", "#e34948"];

export const AXIS_TICK = { fontSize: 10.5, fill: "var(--muted)" } as const;
export const GRID_STROKE = "var(--line)";
export const BASELINE_STROKE = "var(--line-strong)";

// Full values for tooltips/legends (capped at 2 decimals — float noise like
// 125.99999999999999 must never reach a label); compact for axis ticks.
export function fmtNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export function fmtTick(n: number): string {
  return Math.abs(n) >= 10000 ? compact.format(n) : fmtNum(n);
}

// X labels are NEVER string-truncated. Date-like labels compress to a canonical
// short form ("May '24"); years and plain numbers pass through; categorical
// labels stay whole and get room from the angled-tick layout below.
export function fmtXLabel(x: string | number): string {
  const s = String(x).trim();
  if (/^\d{4}$/.test(s) || Number.isFinite(Number(s))) return s;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    const d = new Date(t);
    return `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
  }
  return s;
}

// Reserve real vertical space for x labels instead of clipping them: short labels
// sit flat; long ones angle to -35° with the axis band grown to fit the projection.
export function xAxisLayout(labels: string[]): { angle: number; textAnchor: "middle" | "end"; height: number } {
  const maxLen = Math.max(0, ...labels.map((l) => l.length));
  if (maxLen <= 6) return { angle: 0, textAnchor: "middle", height: 24 };
  return { angle: -35, textAnchor: "end", height: Math.min(76, 18 + Math.round(maxLen * 3.6)) };
}

// Y-axis width sized to the widest formatted tick — no clipped tick values, no
// wasted plot width on small cards.
export function yAxisWidth(values: number[]): number {
  const chars = Math.max(2, ...values.map((v) => fmtTick(v).length));
  return Math.min(56, Math.max(30, 8 + Math.round(chars * 6.2)));
}

// One tooltip look across all charts: card surface, hairline border, mono numerals.
export const TOOLTIP_STYLES = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--line)",
    borderRadius: 10,
    boxShadow: "var(--shadow-md)",
    fontSize: 11.5,
    padding: "7px 10px",
  },
  labelStyle: { color: "var(--ink)", fontWeight: 600, marginBottom: 3 },
  itemStyle: { color: "var(--ink-soft)", padding: 0, fontFamily: "var(--font-mono)" },
} as const;

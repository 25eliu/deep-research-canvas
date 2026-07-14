"use client";
import MiniChart from "@/components/MiniChart";
import AnswerReport from "@/components/AnswerReport";
import ComparisonChart from "@/components/report/ComparisonChart";
import Leaderboard from "@/components/report/Leaderboard";

// Dev-only chart fixture board: renders every chart form with the label shapes
// that used to clip (ISO dates, long categorical names, large values) so chart
// changes can be eyeballed without burning a live research run. Not linked from
// the app — visit /dev/charts directly.
const dates = ["2023-03-31", "2023-06-30", "2023-09-30", "2023-12-31", "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31"];
const lineDates = {
  kind: "line" as const, unit: "USD bn",
  series: [{ label: "Revenue", points: dates.map((d, i) => ({ x: d, y: 7.2e9 + i * 4.1e9 })) }],
};
const barLongCats = {
  kind: "bar" as const, unit: "GDP, USD tn",
  series: [{ label: "GDP", points: [
    { x: "United States", y: 27.4 }, { x: "China", y: 17.8 }, { x: "Germany", y: 4.5 },
    { x: "United Kingdom", y: 3.4 }, { x: "France", y: 3.1 },
  ] }],
};
const years = ["2019", "2020", "2021", "2022", "2023", "2024"];
const comparisonLines = {
  kind: "comparison" as const, title: "Revenue, FY", unit: "USD bn",
  series: [
    { label: "Nvidia", entity: "Nvidia", points: years.map((y, i) => ({ x: y, y: 11 + i * i * 4.6 })) },
    { label: "AMD", entity: "AMD", points: years.map((y, i) => ({ x: y, y: 6.7 + i * 3.4 })) },
    { label: "Intel", entity: "Intel", points: years.map((y, i) => ({ x: y, y: 72 - i * 3.8 })) },
  ],
  insight: "Nvidia compounds while Intel bleeds share.",
};
const comparisonBars = {
  kind: "comparison" as const, title: "Data-center revenue, latest two quarters", unit: "USD bn",
  series: [
    { label: "Nvidia", entity: "Nvidia", points: [{ x: "Q3 FY25", y: 30.8 }, { x: "Q4 FY25", y: 35.6 }] },
    { label: "AMD", entity: "AMD", points: [{ x: "Q3 FY25", y: 3.5 }, { x: "Q4 FY25", y: 3.9 }] },
  ],
};

const leaderboard = {
  kind: "leaderboard" as const,
  title: "Asian semiconductor leaders ranked",
  metricLabel: "Competitive thesis",
  rows: [
    { rank: 1, entity: "TSMC", value: "Pure-play foundry leader", detail: { md: "Controls ~90% of leading-edge logic capacity; N3 fully booked through 2026.", stats: [{ label: "foundry share", value: "62%" }, { label: "gross margin", value: "57%" }] } },
    { rank: 2, entity: "Samsung Foundry", value: "Vertical challenger", delta: "-1", detail: { md: "GAA-first bet on 3nm, but yields trail TSMC." } },
    { rank: 3, entity: "SK Hynix", value: "HBM memory winner", delta: "+2" },
    { rank: 4, entity: "SMIC", value: "Constrained by export controls" },
  ],
};

const leaderboardNoTitle = {
  kind: "leaderboard" as const,
  metricLabel: "Market cap, USD bn",
  rows: [
    { rank: 1, entity: "Nvidia", value: "3,420", delta: "+2.1%" },
    { rank: 2, entity: "Microsoft", value: "3,180", delta: "-0.4%" },
  ],
};

// A synthesis-style report with a WIDE table — the shape that used to become its own
// sideways scroll trap inside the card. Must render fully inside one vertical scroller.
const wideTableReport = {
  verdict: "**TSMC leads Asian semis on every scale metric; SK Hynix wins the HBM cycle.**",
  blocks: [
    { kind: "prose" as const, md: "Market caps and revenue below are trailing twelve months, in USD." },
    { kind: "table" as const, columns: ["Company", "Market cap", "Revenue TTM", "Gross margin", "Op margin", "YoY growth", "Fab strategy"], rows: [
      ["TSMC", "$1,020B", "$88.1B", "57%", "45%", "+31%", "Pure-play foundry, leading edge"],
      ["Samsung Electronics", "$412B", "$208.5B", "37%", "15%", "+12%", "IDM + foundry challenger"],
      ["SK Hynix", "$142B", "$46.3B", "46%", "31%", "+94%", "Memory, HBM leader"],
      ["MediaTek", "$71B", "$16.4B", "48%", "22%", "+18%", "Fabless mobile SoC"],
      ["SMIC", "$48B", "$8.0B", "20%", "8%", "+27%", "Mainland foundry, trailing edge"],
    ] },
    { kind: "prose" as const, md: "TSMC's margin structure is the moat: no Asian peer combines its scale and profitability." },
  ],
};

export default function ChartsFixture() {
  return (
    <div style={{ maxWidth: 640, margin: "40px auto", display: "flex", flexDirection: "column", gap: 36, padding: 16 }}>
      <section className="node-card" style={{ padding: 16 }}>
        <h3>MiniChart · line · ISO dates · billions</h3>
        <MiniChart spec={lineDates} />
      </section>
      <section className="node-card" style={{ padding: 16, width: 300 }}>
        <h3>MiniChart · bar · long categories · 300px card</h3>
        <MiniChart spec={barLongCats} />
      </section>
      <section className="node-card" style={{ padding: 16 }}>
        <h3>Comparison · 3 series · years</h3>
        <ComparisonChart block={comparisonLines} />
      </section>
      <section className="node-card" style={{ padding: 16 }}>
        <h3>Comparison · grouped bars · under 3 points</h3>
        <ComparisonChart block={comparisonBars} />
      </section>
      <section className="node-card" style={{ padding: 16 }}>
        <h3>Leaderboard · title + thesis values + expandable rows</h3>
        <Leaderboard block={leaderboard} />
      </section>
      <section className="node-card" style={{ padding: 16 }}>
        <h3>Leaderboard · no title · numeric values + deltas</h3>
        <Leaderboard block={leaderboardNoTitle} />
      </section>
      <section className="node-card" style={{ padding: 16, width: 600 }}>
        <h3>Answer report · wide table · single vertical scroll (600px synth width)</h3>
        <div className="synth">
          <div className="synth-kicker">Answer</div>
          <AnswerReport report={wideTableReport as any} />
        </div>
      </section>
    </div>
  );
}

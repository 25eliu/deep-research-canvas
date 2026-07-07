"use client";
import type { AnswerReport as Report } from "@/lib/schema";
import Markdown from "./Markdown";
import MiniChart from "./MiniChart";

// Renders the composed final-answer "report": a bold verdict followed by an
// ordered list of representation blocks (prose / comparison table / chart /
// stat tiles) the final layer chose. Every number was validated server-side
// against real gathered figures before this reached the client.
export default function AnswerReport({ report }: { report: Report }) {
  return (
    <div className="report">
      <div className="report-verdict"><Markdown text={report.verdict} /></div>
      {report.blocks.map((b, i) => {
        switch (b.kind) {
          case "prose":
            return <div key={i} className="report-prose"><Markdown text={b.md} /></div>;
          case "tiles":
            return (
              <div key={i} className="report-tiles">
                {b.tiles.map((t, j) => (
                  <div key={j} className="report-tile">
                    <div className="report-tile-value">{t.value}{t.delta ? <span className="report-tile-delta"> {t.delta}</span> : null}</div>
                    <div className="report-tile-label">{t.label}</div>
                  </div>
                ))}
              </div>
            );
          case "table":
            return (
              <div key={i} className="report-table-wrap">
                <table className="report-table">
                  <thead><tr>{b.columns.map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>{row.map((cell, c) => (c === 0 ? <th key={c} scope="row">{cell}</th> : <td key={c}>{cell}</td>))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "chart":
            return (
              <div key={i} className="report-chart">
                {b.title ? <div className="report-chart-title">{b.title}</div> : null}
                <MiniChart spec={b.chartSpec} />
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

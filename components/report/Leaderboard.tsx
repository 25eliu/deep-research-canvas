"use client";
import { useState } from "react";
import type { AnswerBlock } from "@/lib/schema";
import Markdown from "../Markdown";
import { IconChevronRight } from "../icons";

type LeaderboardBlock = Extract<AnswerBlock, { kind: "leaderboard" }>;

function deltaClass(delta?: string): string {
  if (!delta) return "";
  return delta.trim().startsWith("-") ? " down" : " up";
}

// Collapsible leaderboard for "top XYZ" answers: rank, entity, headline value,
// optional delta; rows with real material expand to detail prose + stat chips.
export default function Leaderboard({ block }: { block: LeaderboardBlock }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (rank: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(rank)) next.delete(rank); else next.add(rank);
      return next;
    });
  const rows = [...block.rows].sort((a, b) => a.rank - b.rank);

  return (
    <div className="report-leaderboard">
      {block.title ? <div className="report-chart-title">{block.title}</div> : null}
      <div className="leaderboard-metric">{block.metricLabel}</div>
      {rows.map((r) => {
        const expandable = !!r.detail;
        const isOpen = open.has(r.rank);
        const rowBody = (
          <>
            <span className={`leaderboard-rank${r.rank <= 3 ? " top" : ""}`}>{r.rank}</span>
            <span className="leaderboard-entity">{r.entity}</span>
            <span className="leaderboard-value">{r.value}</span>
            {r.delta ? <span className={`leaderboard-delta${deltaClass(r.delta)}`}>{r.delta}</span> : null}
            {expandable ? <IconChevronRight className={`disclosure-chev${isOpen ? " open" : ""}`} /> : null}
          </>
        );
        return (
          <div key={r.rank} className={`leaderboard-row-wrap${r.rank <= 3 ? " top" : ""}`}>
            {expandable ? (
              <button type="button" className="leaderboard-row" aria-expanded={isOpen} onClick={() => toggle(r.rank)}>
                {rowBody}
              </button>
            ) : (
              <div className="leaderboard-row">{rowBody}</div>
            )}
            {expandable && isOpen && r.detail ? (
              <div className="leaderboard-detail">
                <Markdown text={r.detail.md} compact />
                {r.detail.stats?.length ? (
                  <div className="leaderboard-stats">
                    {r.detail.stats.map((s) => (
                      <span key={s.label} className="leaderboard-stat">
                        <span className="leaderboard-stat-value">{s.value}</span> {s.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

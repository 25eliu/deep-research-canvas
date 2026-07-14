"use client";
import { useState } from "react";
import type { AnswerBlock } from "@/lib/schema";
import Markdown from "../Markdown";
import MiniChart from "../MiniChart";
import { IconChevronRight } from "../icons";

type SectionsBlock = Extract<AnswerBlock, { kind: "sections" }>;

// One titled card per factor/driver. All sections start EXPANDED — the factors
// are the answer; collapsing is a skim affordance, not the default.
export default function FactorSections({ block }: { block: SectionsBlock }) {
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  return (
    <div className="report-sections">
      {block.sections.map((s, i) => {
        const open = !closed.has(i);
        return (
          <div key={i} className="factor-section">
            <button type="button" className="factor-head" aria-expanded={open} onClick={() => toggle(i)}>
              <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
              <span className="factor-title">{s.title}</span>
              {s.figure ? (
                <span className="factor-figure">
                  <strong>{s.figure.value}</strong>
                  {s.figure.delta ? <span className="factor-delta">{s.figure.delta}</span> : null}
                  <span className="factor-figure-label">{s.figure.label}</span>
                </span>
              ) : null}
            </button>
            {open ? (
              <div className="factor-body">
                <Markdown text={s.md} compact />
                {s.chartSpec ? <MiniChart spec={s.chartSpec} /> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

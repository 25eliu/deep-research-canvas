"use client";
import type { AnswerBlock } from "@/lib/schema";
import Markdown from "../Markdown";

type TimelineBlock = Extract<AnswerBlock, { kind: "timeline" }>;

// Vertical spine of dated milestones for "how did X evolve" answers.
export default function Timeline({ block }: { block: TimelineBlock }) {
  return (
    <div className="report-timeline">
      {block.events.map((e, i) => (
        <div key={i} className="timeline-event">
          <div className="timeline-marker" aria-hidden />
          <div className="timeline-content">
            <div className="timeline-head">
              <span className="timeline-date">{e.date}</span>
              <span className="timeline-title">{e.title}</span>
              {e.value ? <span className="timeline-value">{e.value}</span> : null}
            </div>
            {e.md ? <div className="timeline-body"><Markdown text={e.md} compact /></div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

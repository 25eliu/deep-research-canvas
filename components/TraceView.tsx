"use client";
import { useEffect, useId, useState } from "react";
import { traceToDisplay, stepsToDisplay, countCalls, groundedInOf, type TurnTrace, type LiveStep } from "@/lib/trace";
import { IconChevronRight } from "./icons";
import TraceNode from "./TraceNode";

// The per-turn trace surface shown beneath the answer: a collapsible section that
// reveals the reasoning tree, every Tako call, and the synthesis steps. Renders
// live from streamed `steps` while the turn is in flight, then from the
// authoritative `trace` once it lands. Auto-expanded while streaming; collapses to
// a one-click summary when finalized.
export default function TraceView({
  trace, steps, streaming, onSelectNode,
}: { trace?: TurnTrace; steps?: LiveStep[]; streaming: boolean; onSelectNode?: (id: string) => void }) {
  const [open, setOpen] = useState(streaming);
  useEffect(() => setOpen(streaming), [streaming]); // open live, collapse on finalize
  const panelId = useId();

  const roots = trace ? traceToDisplay(trace) : stepsToDisplay(steps);
  const grounded = groundedInOf(trace);
  const hasGrounded = grounded.nodes.length > 0 || grounded.cards.length > 0 || grounded.takoAnswerUsed;
  // A board-first (no-Tako) answer has an empty reasoning tree but real provenance —
  // keep rendering so the "Grounded in" chips still show.
  if (roots.length === 0 && !streaming && !hasGrounded) return null;

  const nCalls = trace ? countCalls(trace) : (steps?.filter((s) => s.t === "tako").length ?? 0);
  const seconds = trace?.ms != null ? (trace.ms / 1000).toFixed(trace.ms < 1000 ? 2 : 1) : null;
  const resolved = trace?.graph?.resolved.length ?? 0;
  const findings = (trace?.tree ?? []).reduce((n, node) => n + (node.findingCount ?? 0), 0);

  return (
    <div className="turn-trace">
      <button
        type="button"
        className="trace-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
        <span className="trace-head-label">Trace</span>
        <span className="sep">·</span>
        <span>{nCalls} call{nCalls === 1 ? "" : "s"}</span>
        {seconds != null && <><span className="sep">·</span><span>{seconds}s</span></>}
        {streaming && <span className="trace-head-live shimmer">running</span>}
      </button>

      {open && (
        <div id={panelId} className="trace-body" role="group" aria-label="Agent trace">
          {roots.map((node, i) => (
            <div key={node.nodeId} className="trace-node-reveal" style={{ animationDelay: `${Math.min(i, 6) * 0.04}s` }}>
              <TraceNode node={node} />
            </div>
          ))}
          {hasGrounded && (
            <div className="grounded-in">
              <div className="grounded-in-label">Grounded in</div>
              <div className="grounded-in-chips">
                {grounded.nodes.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    className="ground-chip node"
                    onClick={() => onSelectNode?.(n.id)}
                    title="Focus this node on the canvas"
                  >
                    {n.title}
                  </button>
                ))}
                {grounded.takoAnswerUsed && <span className="ground-chip tako-src">Tako answer</span>}
                {grounded.cards.map((c) => (
                  <a
                    key={c.id}
                    className="ground-chip card"
                    href={c.url || undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {c.title}
                  </a>
                ))}
              </div>
            </div>
          )}
          {trace && (
            <div className="trace-footer">
              <span>RESOLVED {resolved}</span>
              <span>CALLS {nCalls}</span>
              <span>FINDINGS {findings}</span>
              {trace.timings?.graph != null && <span>GRAPH {trace.timings.graph}ms</span>}
              {seconds != null && <span>{seconds}s</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

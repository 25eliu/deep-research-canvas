"use client";
import { useEffect, useId, useState } from "react";
import { traceToDisplay, stepsToDisplay, countCalls, groundedInOf, type TurnTrace, type LiveStep, type GraphyTraceInfo } from "@/lib/trace";
import { IconChevronRight } from "./icons";
import TraceNode from "./TraceNode";

// Pipeline breadcrumbs the run left behind — subtype retries, fan-out caps, guard
// drops, empty-menu entities. Collapsed by default; the count hints whether the
// graph phase hit any of its safety nets.
function TraceNotes({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="trace-notes">
      <button
        type="button"
        className="trace-notes-head"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
        <span>{notes.length} note{notes.length === 1 ? "" : "s"}</span>
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Pipeline notes">
          {notes.map((n, i) => <div key={i} className="trace-note">{n}</div>)}
        </div>
      )}
    </div>
  );
}

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
  const hasGrounded = grounded.nodes.length > 0 || grounded.cards.length > 0
    || grounded.contents.length > 0 || grounded.takoAnswerUsed;
  // A board-first (no-Tako) answer has an empty reasoning tree but real provenance —
  // keep rendering so the "Grounded in" chips still show.
  if (roots.length === 0 && !streaming && !hasGrounded) return null;

  const nCalls = trace ? countCalls(trace) : (steps?.filter((s) => s.t === "tako").length ?? 0);
  const nGraphCalls = trace
    ? (trace.tree ?? []).reduce((n, node) => n + (node.graphCalls?.length ?? 0), 0)
    : (steps?.filter((s) => s.t === "graph").length ?? 0);
  const seconds = trace?.ms != null ? (trace.ms / 1000).toFixed(trace.ms < 1000 ? 2 : 1) : null;
  const resolved = trace?.graph?.resolved.length ?? 0;
  const findings = (trace?.tree ?? []).reduce((n, node) => n + (node.findingCount ?? 0), 0);
  const notes = trace?.notes ?? [];
  // Graphy hero provenance: authoritative from the finalized trace, else the live
  // streamed outcome (the last graphy step wins — there is at most one per turn).
  const graphy: GraphyTraceInfo | undefined =
    trace?.graphy ?? [...(steps ?? [])].reverse().find((s): s is Extract<LiveStep, { t: "graphy" }> => s.t === "graphy")?.info;

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
          {graphy && (
            <div className="graphy-trace">
              <span className={`graphy-trace-badge ${graphy.outcome}`}>Graphy</span>
              {graphy.outcome === "modeled" && (
                <span className="graphy-trace-text">
                  hero chart modeled from card data · {graphy.series ?? "?"} series × {graphy.rows ?? "?"} rows
                  {graphy.dropped ? ` · ${graphy.dropped} untraceable cell${graphy.dropped === 1 ? "" : "s"} pruned` : ""}
                  {` · ${(graphy.ms / 1000).toFixed(1)}s`}
                </span>
              )}
              {graphy.outcome === "fallback" && (
                <span className="graphy-trace-text">
                  modeling unavailable — converted the report&rsquo;s own chart
                  {graphy.dropped ? ` (${graphy.dropped} untraceable cells forced the discard)` : ""}
                </span>
              )}
              {graphy.outcome === "none" && (
                <span className="graphy-trace-text">no chartable series this turn — report shipped without a hero chart</span>
              )}
            </div>
          )}
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
                {grounded.contents.map((c) => (
                  <button
                    key={`${c.nodeId}:${c.cardId ?? c.title}`}
                    type="button"
                    className="ground-chip data"
                    onClick={() => onSelectNode?.(c.nodeId)}
                    title={`Read ${c.rows} rows of this node's underlying data`}
                  >
                    {c.title} · data
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
          {notes.length > 0 && <TraceNotes notes={notes} />}
          {trace && (
            <div className="trace-footer">
              <span>RESOLVED {resolved}</span>
              <span>CALLS {nCalls}</span>
              {nGraphCalls > 0 && <span>GRAPH CALLS {nGraphCalls}</span>}
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

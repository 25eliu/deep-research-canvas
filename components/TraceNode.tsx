"use client";
import { useId, useState } from "react";
import type { TraceNodeView } from "@/lib/trace";
import { IconChevronRight } from "./icons";
import TakoCallRow from "./TakoCallRow";
import GraphCallRow from "./GraphCallRow";

// One "graph resolved" row: a resolved entity (disclosure reveals the related metrics
// Tako has for it) or, for kind:"metric", the standalone series the metric-typed
// graph search surfaced for this sub-question's terms.
function GraphEntity({ entity, related, kind }: { entity: string; related: string[]; kind?: "entity" | "metric" }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const has = related.length > 0;
  return (
    <div className={`graph-entity${kind === "metric" ? " metric" : ""}`}>
      <button
        type="button"
        className="graph-entity-row"
        aria-expanded={open}
        aria-controls={panelId}
        disabled={!has}
        onClick={() => setOpen((o) => !o)}
      >
        {has && <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />}
        <span className="graph-entity-name">{entity}</span>
        <span className="graph-entity-count">{related.length} metric{related.length === 1 ? "" : "s"}</span>
      </button>
      {open && has && (
        <div id={panelId} className="graph-metrics" role="group" aria-label={`Metrics for ${entity}`}>
          {related.map((m) => <span key={m} className="decomp-chip metric">{m}</span>)}
        </div>
      )}
    </div>
  );
}

// One research-tree node: a disclosure whose header is the sub-question. Expanding
// it reveals the LLM's rationale, the Tako calls this node issued (each drillable
// to its cards), a synthesis line, and its child nodes (recursively). Children are
// drawn under a ruled connector rail echoing the canvas `feeds` edges.
// The graph fan-out issues its related calls in concurrency batches, so they arrive
// interleaved across entities. For readability the drill-down keeps searches in issue
// order, then groups every related call under its entity (first-appearance order) —
// each node's filters read consecutively ("Alphabet Inc." q=revenue, q=sales, …).
function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function orderGraphCalls(calls: TraceNodeView["graphCalls"]): TraceNodeView["graphCalls"] {
  const searches = calls.filter((c) => c.endpoint === "graph/search");
  const related = calls.filter((c) => c.endpoint !== "graph/search");
  const bySubject = new Map<string, typeof related>();
  for (const c of related) {
    const key = c.subject ?? c.params.node_id ?? "";
    const group = bySubject.get(key) ?? [];
    group.push(c);
    bySubject.set(key, group);
  }
  return [...searches, ...[...bySubject.values()].flat()];
}

export default function TraceNode({ node, defaultOpen }: { node: TraceNodeView; defaultOpen?: boolean }) {
  const initial = defaultOpen ?? (node.kind === "branch" && node.depth <= 0);
  const [open, setOpen] = useState(initial);
  const panelId = useId();
  // Real wall time this node's searches took (per-call ms are the queue-stripped
  // in-flight times, so their sum ≈ the actual elapsed the user waited).
  const totalMs = node.calls.reduce((s, c) => s + c.ms, 0);
  const totalLabel = totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`;
  // The node's whole wall-clock (decompose + graph + searches + synth; branches span
  // their subtree) — stamped server-side, so it's absent on live/legacy traces.
  const nodeLabel = node.totalMs != null ? fmtMs(node.totalMs) : null;

  return (
    <div className="trace-node">
      <button
        type="button"
        className="trace-node-row"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
        <span className="q">{node.question || "(unnamed step)"}</span>
        {(node.kind === "gap" || node.gapFill) && <span className="trace-gap-chip">gap fill</span>}
        {nodeLabel && <span className="trace-node-ms" title="total wall-clock for this step (including sub-steps)">{nodeLabel}</span>}
        {node.findingCount > 0 && <span className="trace-node-count">{node.findingCount}</span>}
      </button>

      {open && (
        <div id={panelId} role="group" aria-label={node.question}>
          {node.rationale && <div className="trace-rationale">{node.rationale}</div>}

          {(node.entities.length > 0 || node.metrics.length > 0 || node.label) && (
            <div className="trace-decomp">
              {node.entities.map((e) => <span key={`e-${e}`} className="decomp-chip entity">{e}</span>)}
              {node.label && <span className="decomp-chip subtype" title="NER label — graph-search ranking boost">{node.label}</span>}
              {node.metrics.map((m) => <span key={`m-${m}`} className="decomp-chip metric">{m}</span>)}
            </div>
          )}

          {(node.graph.length > 0 || node.graphCalls.length > 0) && (
            <div className="trace-graph">
              <div className="trace-graph-label">
                graph resolved
                {node.graphCalls.length > 0 && (
                  <> · {node.graphCalls.length} call{node.graphCalls.length === 1 ? "" : "s"}{node.graphMs != null ? ` · ${node.graphMs}ms` : ""}</>
                )}
              </div>
              {node.graph.map((g) => <GraphEntity key={g.entity} entity={g.entity} related={g.related} kind={g.kind} />)}
              {node.graphCalls.length > 0 && (
                <>
                  <div className="trace-graph-label graph-calls-label">graph calls</div>
                  {orderGraphCalls(node.graphCalls).map((c, i) => <GraphCallRow key={`gc-${i}`} call={c} />)}
                </>
              )}
            </div>
          )}

          {node.calls.map((c) => <TakoCallRow key={c.callId} call={c} />)}

          {node.calls.length > 0 && (
            <div className="trace-node-total">{node.calls.length} search{node.calls.length === 1 ? "" : "es"} · {totalLabel} total</div>
          )}

          {(node.synthesizing || node.findingCount > 0 || node.composeMs != null) && (
            <div className="trace-synth-line">
              {node.synthesizing
                ? <>synthesizing…</>
                : <>synthesis · grounded in {node.findingCount} finding{node.findingCount === 1 ? "" : "s"}{node.composeMs != null ? <> · {fmtMs(node.composeMs)}</> : null}</>}
            </div>
          )}

          {node.children.length > 0 && (
            <div className="trace-node-children">
              {node.children.map((c) => <TraceNode key={c.nodeId} node={c} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

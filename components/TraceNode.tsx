"use client";
import { useId, useState } from "react";
import type { TraceNodeView } from "@/lib/trace";
import { IconChevronRight } from "./icons";
import TakoCallRow from "./TakoCallRow";

// One resolved entity from the graph: name is a disclosure that reveals the related
// metrics Tako actually has for it.
function GraphEntity({ entity, related }: { entity: string; related: string[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const has = related.length > 0;
  return (
    <div className="graph-entity">
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
export default function TraceNode({ node, defaultOpen }: { node: TraceNodeView; defaultOpen?: boolean }) {
  const initial = defaultOpen ?? (node.kind === "branch" && node.depth <= 0);
  const [open, setOpen] = useState(initial);
  const panelId = useId();
  // Real wall time this node's searches took (per-call ms are the queue-stripped
  // in-flight times, so their sum ≈ the actual elapsed the user waited).
  const totalMs = node.calls.reduce((s, c) => s + c.ms, 0);
  const totalLabel = totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`;

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
        {node.findingCount > 0 && <span className="trace-node-count">{node.findingCount}</span>}
      </button>

      {open && (
        <div id={panelId} role="group" aria-label={node.question}>
          {node.rationale && <div className="trace-rationale">{node.rationale}</div>}

          {(node.entities.length > 0 || node.metrics.length > 0) && (
            <div className="trace-decomp">
              {node.entities.map((e) => <span key={`e-${e}`} className="decomp-chip entity">{e}</span>)}
              {node.metrics.map((m) => <span key={`m-${m}`} className="decomp-chip metric">{m}</span>)}
            </div>
          )}

          {node.graph.length > 0 && (
            <div className="trace-graph">
              <div className="trace-graph-label">graph resolved</div>
              {node.graph.map((g) => <GraphEntity key={g.entity} entity={g.entity} related={g.related} />)}
            </div>
          )}

          {node.calls.map((c) => <TakoCallRow key={c.callId} call={c} />)}

          {node.calls.length > 0 && (
            <div className="trace-node-total">{node.calls.length} search{node.calls.length === 1 ? "" : "es"} · {totalLabel} total</div>
          )}

          {(node.synthesizing || node.findingCount > 0) && (
            <div className="trace-synth-line">
              {node.synthesizing
                ? <>synthesizing…</>
                : <>synthesis · grounded in {node.findingCount} finding{node.findingCount === 1 ? "" : "s"}</>}
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

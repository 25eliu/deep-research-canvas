"use client";
import { useId, useState } from "react";
import type { GraphCallRecord } from "@/lib/trace";
import { IconChevronRight } from "./icons";

// One raw Tako GRAPH API call, rendered like TakoCallRow's two-line ledger:
//   ▸ "shelter costs"                      → 3 results
//     graph/search · types=entity · 212ms
// Expanding reveals the EXACT request params (as a querystring) and every result
// the graph returned — name, type/subtype, aliases, description. Debug-oriented.
export default function GraphCallRow({ call }: { call: GraphCallRecord }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const n = call.results.length;
  const failed = !!call.error;

  // The primary label: the search q, the related filter q, or the bare node lookup.
  const label = call.params.q ?? (call.params.node_id ? `related of ${call.params.node_id.slice(0, 18)}…` : "(no q)");
  const kindMeta = call.endpoint === "graph/search"
    ? `types=${call.params.types}${call.params.subtype ? ` subtype=${call.params.subtype}` : ""}`
    : `relation=${call.params.relation_type}${call.params.q ? ` q="${call.params.q}"` : " (full menu)"}`;
  const queryString = Object.entries(call.params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  return (
    <div className="tako-call graph-call">
      <button
        type="button"
        className="tako-call-row"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tako-call-primary">
          <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
          <span className="query" title={label}>&ldquo;{label}&rdquo;</span>
          <span className={`n-cards${failed ? " failed" : ""}`}>
            {failed ? "failed" : `${n} result${n === 1 ? "" : "s"}`}
          </span>
        </span>
        <span className="tako-call-meta">
          <span className="endpoint">{call.endpoint}</span>
          <span className="sep">·</span>
          <span>{kindMeta}</span>
          <span className="sep">·</span>
          <span>{call.ms}ms</span>
        </span>
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={`Graph results for ${label}`}>
          {/* the exact request as sent, for copy/paste reproduction */}
          <div className="tako-call-fullquery">GET /api/beta/graph/{call.endpoint.split("/")[1]}?{queryString}</div>
          {failed
            ? <div className="tako-call-error">{call.error}</div>
            : n === 0
              ? <div className="tako-call-error">no results returned</div>
              : call.results.map((r, i) => (
                <div key={`${r.id ?? r.name}-${i}`} className="graph-result">
                  <div className="graph-result-head">
                    <span className="graph-result-name">{r.name}</span>
                    {(r.type || r.subtype) && (
                      <span className="graph-result-type">{[r.type, r.subtype].filter(Boolean).join(" · ")}</span>
                    )}
                  </div>
                  {r.aliases && r.aliases.length > 0 && (
                    <div className="graph-result-aliases">aka {r.aliases.join(", ")}</div>
                  )}
                  {r.description && <div className="graph-result-desc">{r.description}</div>}
                </div>
              ))}
        </div>
      )}
    </div>
  );
}

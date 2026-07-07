"use client";
import { useId, useState } from "react";
import type { TakoCallRecord } from "@/lib/trace";
import { IconChevronRight } from "./icons";
import CardProvenance from "./CardProvenance";

// One individually-traceable Tako API call, rendered as a two-line monospaced ledger:
//   ▸ "query"                          → 4 cards
//     /v3/search · fast · 312ms
// Two lines so the query and the call metadata never collide on a narrow panel.
// Expanding it reveals the exact cards that call returned. Collapsed by default.
export default function TakoCallRow({ call, defaultOpen = false }: { call: TakoCallRecord; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const n = call.cards.length;
  const failed = !!call.error;

  return (
    <div className="tako-call">
      <button
        type="button"
        className="tako-call-row"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tako-call-primary">
          <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
          <span className="query" title={call.query}>&ldquo;{call.query}&rdquo;</span>
          <span className={`n-cards${failed ? " failed" : ""}`}>
            {failed ? "failed" : `${n} card${n === 1 ? "" : "s"}`}
          </span>
        </span>
        <span className="tako-call-meta">
          <span className="endpoint">{call.endpoint}</span>
          <span className="sep">·</span>
          <span>{call.effort}</span>
          <span className="sep">·</span>
          <span>{call.ms}ms</span>
        </span>
      </button>
      {open && (
        <div id={panelId} role="group" aria-label={`Cards for ${call.query}`}>
          {/* the complete query text, wrapped — the truncated header can't show it all */}
          <div className="tako-call-fullquery">{call.query}</div>
          {failed
            ? <div className="tako-call-error">{call.error}</div>
            : n === 0
              ? <div className="tako-call-error">no cards returned</div>
              : call.cards.map((c) => <CardProvenance key={c.id} card={c} />)}
        </div>
      )}
    </div>
  );
}

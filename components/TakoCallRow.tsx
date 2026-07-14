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
  // A /v1/contents call pulls the real series (CSV) behind one already-found card —
  // its "query" is the card title, and "N cards" would misread as a search result.
  const isContents = call.endpoint === "/v1/contents";

  return (
    <div className={`tako-call${isContents ? " contents-call" : ""}`}>
      <button
        type="button"
        className="tako-call-row"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="tako-call-primary">
          <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
          <span className="query" title={call.query}>{`“${call.query}”`}</span>
          <span className={`n-cards${failed ? " failed" : ""}`}>
            {failed ? "failed" : isContents ? "fetched data" : `${n} card${n === 1 ? "" : "s"}`}
          </span>
        </span>
        <span className="tako-call-meta">
          <span className="endpoint">{call.endpoint}</span>
          <span className="sep">·</span>
          <span>{call.effort}</span>
          <span className="sep">·</span>
          {/* cache reads cost no network round-trip — "cache" is more honest than "0ms" */}
          <span>{call.cached ? "cache" : `${call.ms}ms`}</span>
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

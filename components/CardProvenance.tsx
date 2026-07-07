"use client";
import { groundingOf, type TraceCard } from "@/lib/trace";
import { IconExternal } from "./icons";

// One card a Tako call returned, with a grounding dot (where it came from), its
// title, source attribution, and a link to the source page. Mirrors the canvas
// NodeCard source-caption treatment so both surfaces read as one system.
export default function CardProvenance({ card }: { card: TraceCard }) {
  const grounding = groundingOf(card);
  return (
    <div className="card-prov">
      <span className={`ground-dot ${grounding}`} aria-hidden />
      <span className="title" title={card.title}>{card.title}</span>
      {card.source && <span className="src">{card.source}</span>}
      {card.url && (
        <a href={card.url} target="_blank" rel="noreferrer" aria-label={`Open source for ${card.title}`}>
          <IconExternal style={{ width: 12, height: 12 }} />
        </a>
      )}
    </div>
  );
}

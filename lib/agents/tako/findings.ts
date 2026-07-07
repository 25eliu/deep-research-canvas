// Provenance ledger: the mechanical guarantee that every node maps 1:1 to a
// discovered, attributable Tako finding — and that every finding is cited.
//
// A "finding" is one deduped result from Tako search / answer. Each finding
// becomes exactly one canvas node, and is listed in the Evidence footer. Nodes
// are never minted anywhere else in the pipeline, so the board cannot contain an
// invented node.
import type { CanvasNode } from "../../schema";
import type { TakoCard } from "../../tako";
import { titleSignature } from "../../text";

export type FindingKind = "data_card" | "web";

export interface Finding {
  index: number; // 1-based citation index
  key: string; // dedup key
  nodeId: string;
  kind: FindingKind;
  title: string;
  source?: string;
  url?: string;
  section?: string;
  card: TakoCard;
}

// A card with a chart embed is structured Tako data; otherwise it's a
// web-grounded fact (still citable, but rendered as a text/evidence node).
export function classifyKind(card: TakoCard): FindingKind {
  return card.embedUrl ? "data_card" : "web";
}

function primaryKey(card: TakoCard): string {
  return card.cardId || card.webpageUrl || card.imageUrl || card.title;
}

// Every identity a card can be recognized by. Two cards that share ANY key are
// the same finding: same cardId or the same chart embed (a re-publish under a new
// cardId). We deliberately do NOT key on the normalized title — distinct cards
// whose titles differ only by stopwords/punctuation (e.g. a quarterly vs annual
// chart, or a combined vs per-entity comparison) would over-merge and drop real
// evidence. webpageUrl is per-card (…/card/<cardId>/) so it adds nothing.
function dedupKeys(card: TakoCard, collapseMetric: boolean): string[] {
  const keys: string[] = [];
  if (card.cardId) keys.push(`card:${card.cardId}`);
  if (card.embedUrl) keys.push(`embed:${card.embedUrl}`);
  if (collapseMetric) {
    const sig = titleSignature(card.title);
    if (sig) keys.push(`metric:${sig}`); // aggressive metric collapse — off by default
  }
  return keys;
}

function nodeIdFor(key: string): string {
  return `find_${key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`;
}

export class FindingLedger {
  private byKey = new Map<string, Finding>();
  private seenKeys = new Set<string>();

  constructor(private collapseMetricSignatures = false) {}

  get size(): number {
    return this.byKey.size;
  }

  // Register a card. Returns the Finding, or null if it collides with one already
  // seen on ANY dedup key (cardId, embed, or normalized title).
  add(card: TakoCard, section?: string): Finding | null {
    const key = primaryKey(card);
    if (!key) return null;
    const keys = dedupKeys(card, this.collapseMetricSignatures);
    if (keys.length === 0 || keys.some((k) => this.seenKeys.has(k))) return null;
    for (const k of keys) this.seenKeys.add(k);
    const kind = classifyKind(card);
    const finding: Finding = {
      index: this.byKey.size + 1,
      key,
      nodeId: nodeIdFor(key),
      kind,
      title: card.title,
      source: card.source,
      url: card.webpageUrl || card.embedUrl,
      section,
      card,
    };
    this.byKey.set(key, finding);
    return finding;
  }

  list(): Finding[] {
    return Array.from(this.byKey.values()).sort((a, b) => a.index - b.index);
  }

  // Return the already-registered finding for a card (a dedup hit), so a second
  // branch that fetches the same card can link to the existing node instead of
  // dropping it. Matches on any of the card's dedup keys.
  lookup(card: TakoCard): Finding | undefined {
    const key = primaryKey(card);
    const direct = this.byKey.get(key);
    if (direct) return direct;
    const keys = dedupKeys(card, this.collapseMetricSignatures);
    if (!keys.some((k) => this.seenKeys.has(k))) return undefined;
    // fall back to scanning (embed/title-keyed collisions)
    return this.list().find((f) => dedupKeys(f.card, this.collapseMetricSignatures).some((k) => keys.includes(k)));
  }

  validNodeIds(): Set<string> {
    return new Set(this.list().map((f) => f.nodeId));
  }

  // Deterministic node for a finding. data_card → chart node grounded "tako";
  // web fact → clickable "source" node grounded "web". Provenance lives in `tako`.
  toNode(f: Finding): CanvasNode {
    const c = f.card;
    const base = {
      id: f.nodeId,
      title: f.title,
      summary: c.description,
      section: f.section,
      tako: {
        cardId: c.cardId,
        embedUrl: c.embedUrl,
        imageUrl: c.imageUrl,
        webpageUrl: c.webpageUrl,
        source: c.source,
        asOf: c.asOf,
      },
    };
    if (f.kind === "data_card") {
      return { ...base, type: "data_card", grounding: "tako", confidence: 0.9 };
    }
    // Web source: a clickable link card shown in the left "Web sources" column.
    // Carry the URL on `sources` (the baseline web-source pattern) as well as `tako`.
    return {
      ...base,
      type: "text",
      role: "source",
      grounding: "web",
      confidence: 0.7,
      sources: c.webpageUrl ? [{ url: c.webpageUrl, title: c.title }] : undefined,
    };
  }
}

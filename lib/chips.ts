// Pure mapping from streamed pipeline events to compact "tool-call" chips shown
// in the chat thread (e.g. "📊 Graph generated · NVDA revenue"). Kept pure and
// dependency-light so it is unit-testable and reusable by the client.
import type { CanvasNode } from "./schema";

export interface Chip {
  icon: string;
  label: string;
}

// A chip for a freshly-added canvas node, or null for structural/uninteresting nodes.
export function nodeChip(node: Pick<CanvasNode, "type" | "title" | "role">): Chip | null {
  const title = node.title?.trim();
  if (!title) return null;
  if (node.type === "data_card") return { icon: "📊", label: `Graph generated · ${title}` };
  if (node.type === "text" && node.role === "evidence") return { icon: "📄", label: `Info block · ${title}` };
  return null; // entity_section headers and everything else stay silent
}

// A chip for a key trace milestone, or null for noisy internal stages.
export function stageChip(stage: string): Chip | null {
  const s = stage.toLowerCase();
  if (s.includes("searching") || s.includes("asking tako")) return { icon: "🔍", label: "Searching Tako" };
  if (s.includes("resolved")) return { icon: "🔗", label: "Resolved entities" };
  if (s.includes("writing answer")) return { icon: "✍️", label: "Writing answer" };
  return null; // routing, planning queries, fetched N findings, etc. → no chip
}

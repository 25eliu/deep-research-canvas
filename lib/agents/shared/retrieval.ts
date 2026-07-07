import type { CanvasNode, CanvasState } from "../../schema";
import { tokenize, jaccard } from "../../text";

export const RETRIEVE_K = 6;

// Empty group labels / section headers carry no content to reason from.
function isContentNode(n: CanvasNode): boolean {
  return n.type !== "entity_section" && n.role !== "header";
}

function haystack(n: CanvasNode): string {
  return [n.title, n.summary, n.section].filter(Boolean).join(" ");
}

// Selection-first: the selected nodes ARE the retrieved set (full content, in
// selection order). Otherwise rank content nodes by keyword overlap with the
// message (small boost for Tako grounding + recency), top-K; if nothing matches,
// fall back to the K most-recent nodes so the model still has board context.
export function retrieveNodes(
  state: CanvasState,
  selection: { nodeIds: string[] } | undefined,
  message: string,
  k: number = RETRIEVE_K,
): CanvasNode[] {
  const nodes = (state.nodes ?? []).filter(isContentNode);
  const ids = selection?.nodeIds ?? [];
  if (ids.length) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return ids.map((id) => byId.get(id)).filter((n): n is CanvasNode => !!n);
  }
  if (nodes.length === 0) return [];

  const q = tokenize(message);
  const keywordScores = nodes.map((n, i) => ({
    n,
    i,
    keyword: jaccard(q, tokenize(haystack(n))),
  }));
  if (!keywordScores.some((s) => s.keyword > 0)) return nodes.slice(-k); // no keyword match → recency
  const scored = keywordScores.map((s) => ({
    ...s,
    base: s.keyword + (s.n.grounding === "tako" ? 0.05 : 0),
  }));
  return [...scored]
    .sort((a, b) => b.base - a.base || b.i - a.i)
    .slice(0, k)
    .map((s) => s.n);
}

function fmtNode(n: CanvasNode): string {
  const lines = [`[#${n.id} · ${n.type}/${n.grounding}] ${n.title}`];
  if (n.summary) lines.push(n.summary);
  if (n.metric) lines.push(`metric: ${n.metric.value} ${n.metric.label}${n.metric.delta ? ` (${n.metric.delta})` : ""}`);
  if (n.chartSpec) {
    for (const s of n.chartSpec.series) {
      const pts = s.points.slice(0, 8).map((p) => `${p.x}:${p.y}`).join(", ");
      lines.push(`chart(${n.chartSpec.kind}${n.chartSpec.unit ? ` ${n.chartSpec.unit}` : ""}) ${s.label}: ${pts}`);
    }
  }
  if (n.consensusRows?.length) {
    lines.push("consensus: " + n.consensusRows.map((r) => `${r.rank}. ${r.entity}${r.score != null ? ` (${r.score})` : ""}`).join("; "));
  }
  if (n.sources?.length) lines.push("sources: " + n.sources.map((s) => s.url).join(", "));
  else if (n.tako?.webpageUrl) lines.push(`source: ${n.tako.webpageUrl}`);
  return lines.join("\n");
}

// Full-content serialization of the retrieved nodes for the prompt.
export function nodeContentBlock(nodes: CanvasNode[]): string {
  if (!nodes.length) return "(no matching board nodes)";
  return nodes.map(fmtNode).join("\n\n");
}

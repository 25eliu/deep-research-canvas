import type { AnswerReport, CanvasNode, CanvasState } from "../../schema";
import { tokenize, jaccard } from "../../text";

export const RETRIEVE_K = 6;

// Empty group labels / section headers carry no content to reason from.
function isContentNode(n: CanvasNode): boolean {
  return n.type !== "entity_section" && n.role !== "header";
}

function haystack(n: CanvasNode): string {
  return [n.title, n.summary, n.section].filter(Boolean).join(" ");
}

// Compact but complete rendering of a composed answer report — a selected
// synthesis node exposes its actual component content, not just its title.
function fmtReport(r: AnswerReport): string[] {
  const lines = [`report: ${r.verdict}`];
  for (const b of r.blocks) {
    switch (b.kind) {
      case "prose":
        lines.push(`prose: ${b.md.slice(0, 240)}`);
        break;
      case "table":
        lines.push(`table [${b.columns.join(" | ")}]: ${b.rows.slice(0, 6).map((row) => row.join(" | ")).join(" ; ")}`);
        break;
      case "tiles":
        lines.push(`tiles: ${b.tiles.map((t) => `${t.label}=${t.value}${t.delta ? ` (${t.delta})` : ""}`).join("; ")}`);
        break;
      case "chart":
        for (const s of b.chartSpec.series) {
          lines.push(`chart(${b.chartSpec.kind}) ${s.label}: ${s.points.slice(-8).map((p) => `${p.x}:${p.y}`).join(", ")}`);
        }
        break;
      case "comparison":
        for (const s of b.series) {
          lines.push(`comparison ${s.entity}: ${s.points.slice(-8).map((p) => `${p.x}:${p.y}`).join(", ")}`);
        }
        break;
      case "leaderboard":
        lines.push(`leaderboard (${b.metricLabel}): ${b.rows.slice(0, 8).map((row) => `${row.rank}. ${row.entity} ${row.value}`).join("; ")}`);
        break;
      case "sections":
        lines.push(`sections: ${b.sections.map((s) => `${s.title}${s.figure ? ` (${s.figure.label}=${s.figure.value})` : ""}`).join("; ")}`);
        break;
      case "timeline":
        lines.push(`timeline: ${b.events.slice(0, 8).map((e) => `${e.date} ${e.title}${e.value ? ` (${e.value})` : ""}`).join("; ")}`);
        break;
    }
  }
  return lines;
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
  if (n.criteria) {
    lines.push("criteria: " + Object.entries(n.criteria.weights).map(([k, v]) => `${k}=${v}`).join(", "));
  }
  if (n.searches?.length) lines.push("searches: " + n.searches.join("; "));
  if (n.report) lines.push(...fmtReport(n.report));
  if (n.sources?.length) lines.push("sources: " + n.sources.map((s) => s.url).join(", "));
  else if (n.tako?.webpageUrl) lines.push(`source: ${n.tako.webpageUrl}`);
  return lines.join("\n");
}

// Full-content serialization of the retrieved nodes for the prompt.
export function nodeContentBlock(nodes: CanvasNode[]): string {
  if (!nodes.length) return "(no matching board nodes)";
  return nodes.map(fmtNode).join("\n\n");
}

export interface NodeCatalogEntry {
  id: string;
  type: string;
  title: string;
  section?: string;
  hasData: boolean; // has fetchable underlying contents (tako card CSV or web source text)
}

// The gather loop's map of the whole board: every content node, with a flag for
// whether get_node_contents can pull real data behind it.
export function nodeCatalog(state: CanvasState): NodeCatalogEntry[] {
  return (state.nodes ?? []).filter(isContentNode).map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    ...(n.section ? { section: n.section } : {}),
    hasData: !!(n.tako?.webpageUrl || n.sources?.length),
  }));
}

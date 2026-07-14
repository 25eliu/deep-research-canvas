"use client";
import { useEffect, useRef, useState } from "react";
import type { CanvasNode } from "@/lib/schema";
import { nodeWidth } from "@/lib/layout";
import MiniChart from "./MiniChart";
import TakoEmbed from "./TakoEmbed";
import Markdown from "./Markdown";
import AnswerReport from "./AnswerReport";
import { IconChevron, IconExternal, IconSearch } from "./icons";

// Re-exported for callers that still import NODE_W (kept for layout back-compat).
export const NODE_W = 300;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

// Real provenance for a baseline (gpt/claude) card: the live web sources its
// figures were pulled from. sanitize guarantees each url was actually retrieved.
function SourceCaption({ sources }: { sources: NonNullable<CanvasNode["sources"]> }) {
  const shown = sources.slice(0, 3);
  return (
    <div className="caption">
      <span className="src">source</span>
      {shown.map((s, i) => (
        <a key={i} href={s.url} target="_blank" rel="noreferrer"
          title={s.title || s.url}
          style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          {hostOf(s.url)} <IconExternal style={{ width: 12, height: 12 }} />
        </a>
      ))}
      {sources.length > shown.length && <span>+{sources.length - shown.length} more</span>}
    </div>
  );
}

// A collapsible "see sources (N)" list of the websites an answer/sub-answer node used.
// Web results are no longer their own canvas nodes — they're cited here per answer instead.
function SeeSources({ sources }: { sources: NonNullable<CanvasNode["sources"]> }) {
  const [open, setOpen] = useState(false);
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <div className="see-sources">
      <button
        className="see-sources-toggle"
        onPointerDown={stop}
        onClick={(e) => { stop(e); setOpen((o) => !o); }}
      >
        {open ? "hide sources" : `see sources (${sources.length})`}
      </button>
      {open && (
        <div className="sources-list">
          {sources.map((s, i) => (
            <a key={i} href={s.url} target="_blank" rel="noreferrer"
              title={s.title || s.url} onPointerDown={stop}>
              {hostOf(s.url)} <IconExternal style={{ width: 12, height: 12 }} />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NodeCard({
  node, selected, connected, collapsed, sources, onToggleCollapse, onMeasure,
}: {
  node: CanvasNode;
  selected: boolean;
  connected?: boolean;
  collapsed: boolean;
  sources?: number; // incoming `feeds` edges — shown on the synthesis block
  onToggleCollapse: (e: React.MouseEvent) => void;
  onMeasure?: (id: string, height: number) => void;
}) {
  const isSynth = node.type === "text" && node.role === "synthesis";
  const isResearch = node.type === "text" && node.role === "research";
  const isSource = node.type === "text" && node.role === "source";
  const srcUrl = node.sources?.[0]?.url || node.tako?.webpageUrl;
  const width = nodeWidth(node);
  // The Tako search query that surfaced this finding card — shown so provenance is
  // visible on the canvas. (Synthesis/research nodes render their own searches line.)
  const foundVia = !isSynth && !isResearch && node.searches?.length
    ? <div className="found-via" title="Tako search that returned this card"><IconSearch />{node.searches[0]}</div>
    : null;
  // A Tako graph card carries the chart itself — its long text `summary` (the Tako
  // description) is redundant noise, so we only show summaries on non-graph cards.
  // The synthesis/research/source blocks render their own body, so exclude them.
  const showSummary = node.summary && node.type !== "data_card" && !isSynth && !isResearch && !isSource;

  // Report the real rendered height so the layout can pack cards tightly (Tako embeds
  // resolve their aspect ratio asynchronously, so this fires again once it settles).
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onMeasure) return;
    const report = () => onMeasure(node.id, el.offsetHeight);
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [node.id, onMeasure, collapsed]);

  return (
    <div
      ref={rootRef}
      className={`node-card${selected ? " selected" : ""}${connected ? " connected" : ""}${collapsed ? " collapsed" : ""}`}
      style={{ width }}
    >
      <div className="node-head">
        <div className="node-title">{node.title}</div>
        <button
          className="chevron"
          aria-label={collapsed ? "Expand" : "Collapse"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onToggleCollapse(e); }}
        >
          <IconChevron />
        </button>
      </div>

      {!collapsed && (
        <div className="node-body">
          {isSynth && (
            <div className="synth">
              <div className="synth-kicker">Answer</div>
              {node.report
                ? <AnswerReport report={node.report} />
                : node.summary
                  ? <div className="synth-body"><Markdown text={node.summary} /></div>
                  : <div className="synth-body synth-pending">Synthesizing…</div>}
              {node.searches?.length ? <div className="node-searches"><IconSearch />{node.searches.join(" · ")}</div> : null}
              {node.sources?.length ? <SeeSources sources={node.sources} /> : null}
              {sources ? <div className="synth-sources">grounded in {sources} source{sources === 1 ? "" : "s"}</div> : null}
            </div>
          )}

          {isResearch && (
            <div className="synth research-synth">
              <div className="synth-kicker">
                Sub-answer
                {node.gapFill ? <span className="gap-badge" title="Fetched by the gap-fill round after the first research pass">gap fill</span> : null}
              </div>
              {node.summary
                ? <div className="synth-body"><Markdown text={node.summary} compact /></div>
                : <div className="synth-body synth-pending">Researching…</div>}
              {node.searches?.length ? <div className="node-searches"><IconSearch />{node.searches.join(" · ")}</div> : null}
              {node.sources?.length ? <SeeSources sources={node.sources} /> : null}
              {sources ? <div className="synth-sources">{sources} source{sources === 1 ? "" : "s"}</div> : null}
            </div>
          )}

          {isSource && (
            <div className="source-card">
              {node.summary && <div className="source-snippet">{node.summary}</div>}
              {srcUrl && (
                <a className="source-host" href={srcUrl} target="_blank" rel="noreferrer">
                  {/* Tako-grounded publisher node → its data page; a real web article → its domain. */}
                  {node.grounding === "tako" ? "open in Tako" : hostOf(srcUrl)}
                  <IconExternal style={{ width: 12, height: 12 }} />
                </a>
              )}
              {foundVia}
            </div>
          )}

          {node.type === "data_card" && node.tako?.embedUrl && (
            <>
              <TakoEmbed tako={node.tako} title={node.title} />
              <div className="caption">
                {/* source + as-of are already shown inside the embed footer — don't repeat them */}
                {node.tako.webpageUrl && (
                  <a href={node.tako.webpageUrl} target="_blank" rel="noreferrer"
                    style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                    open in Tako <IconExternal style={{ width: 12, height: 12 }} />
                  </a>
                )}
              </div>
              {foundVia}
            </>
          )}

          {node.type === "data_card" && !node.tako?.embedUrl && node.chartSpec && (
            <>
              <MiniChart spec={node.chartSpec} />
              {node.sources && node.sources.length > 0
                ? <SourceCaption sources={node.sources} />
                : <div className="model-note">model-drawn · no source · numbers may be stale</div>}
              {foundVia}
            </>
          )}

          {node.type === "data_card" && !node.tako?.embedUrl && !node.chartSpec && (
            <div className="empty-note">no structured data available</div>
          )}

          {node.type === "metric" && node.metric && (
            <div>
              <div className="metric-value">{node.metric.value}</div>
              <div className="metric-label">
                {node.metric.label}{" "}
                {node.metric.delta && <span className="metric-delta">{node.metric.delta}</span>}
              </div>
              {node.sources && node.sources.length > 0 && <SourceCaption sources={node.sources} />}
            </div>
          )}

          {node.type === "criteria" && node.criteria && (
            <div>
              {Object.entries(node.criteria.weights).map(([k, v]) => {
                const maxW = Math.max(...Object.values(node.criteria!.weights), 1);
                return (
                  <div key={k} className="crit-row">
                    <div className="crit-top"><span>{k}</span><span className="v">{v}</span></div>
                    <div className="crit-bar"><span style={{ width: `${(v / maxW) * 100}%` }} /></div>
                  </div>
                );
              })}
            </div>
          )}

          {node.type === "consensus" && node.consensusRows && (
            <div>
              {[...node.consensusRows].sort((a, b) => a.rank - b.rank).map((r) => (
                <div key={r.rank} className="cons-row">
                  <span className={`rank r${r.rank}`}>{r.rank}</span>
                  <span className="cons-entity">{r.entity}</span>
                  {r.score != null && <span className="cons-score">{r.score}</span>}
                </div>
              ))}
            </div>
          )}

          {showSummary && <div className="node-summary">{node.summary}</div>}

          {node.type === "text" && node.role === "evidence" && node.tako && (
            <div className="caption">
              {node.tako.source && <span className="src">{node.tako.source}</span>}
              {node.tako.asOf && <span>as of {node.tako.asOf}</span>}
              {node.tako.webpageUrl && (
                <a href={node.tako.webpageUrl} target="_blank" rel="noreferrer"
                  style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  open source <IconExternal style={{ width: 12, height: 12 }} />
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

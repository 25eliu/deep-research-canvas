"use client";
import type { CanvasNode } from "@/lib/schema";
import MiniChart from "./MiniChart";

export const NODE_W = 280;

function Badge({ node }: { node: CanvasNode }) {
  const tako = node.grounding === "tako";
  return (
    <span style={{
      fontSize: 10, padding: "1px 6px", borderRadius: 6, marginLeft: 6,
      background: tako ? "rgba(29,158,117,.15)" : "rgba(186,117,23,.15)",
      color: tako ? "var(--tako)" : "var(--model)", border: `1px solid ${tako ? "var(--tako)" : "var(--model)"}`,
    }}>
      {tako ? "tako" : node.grounding} · {Math.round((node.confidence ?? 0) * 100)}%
    </span>
  );
}

export default function NodeCard({
  node, selected, onSelect, onDragStart,
}: {
  node: CanvasNode;
  selected: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onDragStart: (e: React.PointerEvent) => void;
}) {
  const base: React.CSSProperties = {
    width: NODE_W, background: "var(--panel)", border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 12, boxShadow: selected ? "0 0 0 2px var(--accent)" : "none", overflow: "hidden",
  };
  const header = (
    <div onPointerDown={onDragStart} style={{ padding: "8px 10px", cursor: "grab", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--border)" }}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{node.title}</div>
      {(node.type === "data_card" || node.type === "metric") && <Badge node={node} />}
    </div>
  );

  return (
    <div style={base} onClick={onSelect}>
      {header}
      <div style={{ padding: 10 }}>
        {node.type === "data_card" && node.tako?.embedUrl && (
          <div>
            <iframe src={node.tako.embedUrl} style={{ width: "100%", height: 200, border: 0, borderRadius: 8, background: "#fff" }} />
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 6 }}>
              {node.tako.source}{node.tako.asOf ? ` · as of ${node.tako.asOf}` : ""} · <a href={node.tako.webpageUrl} target="_blank" style={{ color: "var(--tako)" }}>open in Tako</a>
            </div>
          </div>
        )}
        {node.type === "data_card" && !node.tako?.embedUrl && node.chartSpec && (
          <div>
            <MiniChart spec={node.chartSpec} />
            <div style={{ fontSize: 10, color: "var(--model)", marginTop: 4 }}>model-drawn · no source · numbers may be stale</div>
          </div>
        )}
        {node.type === "data_card" && !node.tako?.embedUrl && !node.chartSpec && (
          <div style={{ fontSize: 12, color: "var(--muted)" }}>no structured data available</div>
        )}
        {node.summary && <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 6 }}>{node.summary}</div>}

        {node.type === "metric" && node.metric && (
          <div><div style={{ fontSize: 22, fontWeight: 500 }}>{node.metric.value}</div>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{node.metric.label} {node.metric.delta}</div></div>
        )}
        {node.type === "criteria" && node.criteria && (
          <div style={{ fontSize: 12 }}>
            {Object.entries(node.criteria.weights).map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                <span>{k}</span><span className="mono" style={{ color: "var(--muted)" }}>{v}</span>
              </div>
            ))}
          </div>
        )}
        {node.type === "consensus" && node.consensusRows && (
          <div style={{ fontSize: 12 }}>
            {node.consensusRows.sort((a, b) => a.rank - b.rank).map((r) => (
              <div key={r.rank} style={{ display: "flex", gap: 8, padding: "3px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ color: "var(--accent)", width: 16 }}>{r.rank}</span>
                <span style={{ flex: 1 }}>{r.entity}</span>
                {r.score != null && <span className="mono" style={{ color: "var(--muted)" }}>{r.score}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import type { CanvasNode, CanvasState } from "@/lib/schema";
import { applyOps } from "@/lib/schema";
import NodeCard, { NODE_W } from "@/components/NodeCard";

type Provider = "gpt" | "claude" | "tako";
const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "tako", label: "LLM + Tako" },
  { id: "gpt", label: "GPT" },
  { id: "claude", label: "Claude" },
];
const EDGE_COLOR: Record<string, string> = {
  supports: "var(--supports)", contradicts: "var(--contradicts)", feeds: "var(--feeds)",
  derived_from: "var(--accent)", sibling: "var(--muted)",
};

function heightGuess(n: CanvasNode): number {
  if (n.type === "data_card") return n.tako ? 300 : 210;
  if (n.type === "consensus") return 200;
  if (n.type === "criteria") return 130;
  if (n.type === "metric") return 110;
  return 100;
}

function computeLayout(nodes: CanvasNode[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const sections: string[] = [];
  for (const n of nodes) if (n.section && !sections.includes(n.section)) sections.push(n.section);
  const colW = NODE_W + 48, topY = 40;
  const colY: Record<string, number> = {};
  sections.forEach((s) => (colY[s] = topY));
  for (const n of nodes) {
    if (n.position) { pos[n.id] = n.position; continue; }
    if (n.type === "consensus" || n.role === "consensus" || n.type === "criteria" || !n.section) continue;
    const col = sections.indexOf(n.section);
    pos[n.id] = { x: 40 + col * colW, y: colY[n.section] };
    colY[n.section] += heightGuess(n) + 24;
  }
  const maxColY = Math.max(topY, ...Object.values(colY));
  const critX = 40 + Math.max(sections.length, 1) * colW;
  let critY = topY;
  for (const n of nodes) if (!n.position && n.type === "criteria") { pos[n.id] = { x: critX, y: critY }; critY += 170; }
  const centerX = 40 + (Math.max(sections.length - 1, 0) * colW) / 2;
  for (const n of nodes) if (!n.position && (n.type === "consensus" || n.role === "consensus")) pos[n.id] = { x: centerX, y: maxColY + 40 };
  let ny = maxColY + 280;
  for (const n of nodes) if (!pos[n.id]) { pos[n.id] = { x: 40, y: ny }; ny += 140; }
  return pos;
}

export default function Page() {
  const [provider, setProvider] = useState<Provider>("tako");
  const [takoAnswer, setTakoAnswer] = useState(false);
  const [state, setState] = useState<CanvasState>({ nodes: [], edges: [] });
  const [selection, setSelection] = useState<string[]>([]);
  const [mainLog, setMainLog] = useState<{ role: string; text: string }[]>([]);
  const [sideLog, setSideLog] = useState<{ role: string; text: string }[]>([]);
  const [input, setInput] = useState("Research the best 5 semiconductor companies to invest in");
  const [sideInput, setSideInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [lastTrace, setLastTrace] = useState<any>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

  const pos = useMemo(() => computeLayout(state.nodes), [state.nodes]);
  const nodeById = useMemo(() => Object.fromEntries(state.nodes.map((n) => [n.id, n])), [state.nodes]);

  const send = useCallback(async (surface: "main" | "side_chat", text: string) => {
    if (!text.trim() || loading) return;
    setLoading(true); setError(null);
    (surface === "main" ? setMainLog : setSideLog)((l) => [...l, { role: "user", text }]);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canvasId: "default", message: text, surface,
          canvasState: state,
          selection: { nodeIds: selection, nodes: selection.map((id) => nodeById[id]).filter(Boolean) },
          providerId: provider, takoAnswerEnabled: takoAnswer,
        }),
      });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "trace") {
            setLoadingStage(evt.stage as string);
          } else if (evt.type === "error") {
            setError(evt.error);
          } else if (evt.type === "result") {
            if (evt.canvasOps?.length) setState((s) => applyOps(s, evt.canvasOps));
            if (surface === "main") setMainLog((l) => [...l, { role: "agent", text: evt.narration || "" }]);
            if (evt.sideReply) setSideLog((l) => [...l, { role: "agent", text: evt.sideReply }]);
            setLastTrace(evt.trace);
          }
        }
      }
    } catch (e: any) { setError(String(e?.message || e)); }
    finally { setLoading(false); setLoadingStage(""); }
  }, [state, selection, nodeById, provider, takoAnswer, loading]);

  // ---- panning + node dragging ----
  const drag = useRef<{ id?: string; startX: number; startY: number; base: { x: number; y: number } } | null>(null);
  const pan = useRef<{ startX: number; startY: number; base: { x: number; y: number } } | null>(null);

  const onNodePointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { id, startX: e.clientX, startY: e.clientY, base: pos[id] || { x: 0, y: 0 } };
  };
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    pan.current = { startX: e.clientX, startY: e.clientY, base: { x: view.x, y: view.y } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current?.id) {
      const dx = (e.clientX - drag.current.startX) / view.scale;
      const dy = (e.clientY - drag.current.startY) / view.scale;
      const id = drag.current.id, base = drag.current.base;
      setState((s) => applyOps(s, [{ op: "move_node", id, position: { x: base.x + dx, y: base.y + dy } }]));
    } else if (pan.current) {
      setView((v) => ({ ...v, x: pan.current!.base.x + (e.clientX - pan.current!.startX), y: pan.current!.base.y + (e.clientY - pan.current!.startY) }));
    }
  };
  const endInteraction = () => { drag.current = null; pan.current = null; };
  const onWheel = (e: React.WheelEvent) => {
    const s = Math.min(2, Math.max(0.4, view.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
    setView((v) => ({ ...v, scale: s }));
  };

  const toggleSelect = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelection((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", height: "100vh" }}>
      {/* Canvas */}
      <div style={{ position: "relative", overflow: "hidden", background: "radial-gradient(circle at 1px 1px, #1b1f2b 1px, transparent 0) 0 0/24px 24px" }}
        onPointerDown={onCanvasPointerDown} onPointerMove={onPointerMove} onPointerUp={endInteraction} onPointerLeave={endInteraction} onWheel={onWheel}>

        {/* Toolbar */}
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 10, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {PROVIDERS.map((p) => (
            <button key={p.id} onClick={() => setProvider(p.id)} style={{
              padding: "6px 10px", borderRadius: 8, border: `1px solid ${provider === p.id ? "var(--accent)" : "var(--border)"}`,
              background: provider === p.id ? "var(--accent)" : "var(--panel)", color: provider === p.id ? "#fff" : "var(--text)", fontSize: 12,
            }}>{p.label}</button>
          ))}
          <label style={{ fontSize: 12, color: "var(--muted)", display: "flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={takoAnswer} onChange={(e) => setTakoAnswer(e.target.checked)} /> tako answer
          </label>
        </div>

        {/* Scene */}
        <div style={{ position: "absolute", inset: 0, transform: `translate(${view.x}px,${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}>
          <svg style={{ position: "absolute", inset: 0, width: 4000, height: 4000, pointerEvents: "none", overflow: "visible" }}>
            {state.edges.map((edge) => {
              const a = pos[edge.from], b = pos[edge.to];
              if (!a || !b) return null;
              const x1 = a.x + NODE_W / 2, y1 = a.y + heightGuess(nodeById[edge.from]) - 20;
              const x2 = b.x + NODE_W / 2, y2 = b.y + 10;
              return <path key={edge.id} d={`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`}
                fill="none" stroke={EDGE_COLOR[edge.kind] || "var(--muted)"} strokeWidth={1.5} opacity={0.8} />;
            })}
          </svg>
          {state.nodes.map((n) => (
            <div key={n.id} style={{ position: "absolute", left: (pos[n.id]?.x ?? 0), top: (pos[n.id]?.y ?? 0) }}>
              <NodeCard node={n} selected={selection.includes(n.id)} onSelect={toggleSelect(n.id)} onDragStart={onNodePointerDown(n.id)} />
            </div>
          ))}
        </div>

        {/* Main chat */}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10, padding: 12, background: "linear-gradient(transparent, var(--bg) 40%)" }}>
          {error && <div style={{ color: "var(--contradicts)", fontSize: 12, marginBottom: 6 }}>{error}</div>}
          {loading && loadingStage && <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>{loadingStage}</div>}
          <div style={{ maxHeight: 120, overflowY: "auto", marginBottom: 8 }}>
            {mainLog.slice(-4).map((m, i) => (
              <div key={i} style={{ fontSize: 12, color: m.role === "user" ? "var(--text)" : "var(--muted)", margin: "2px 0" }}>
                <b>{m.role === "user" ? "you" : "canvas"}:</b> {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (send("main", input), setInput(""))}
              placeholder="Ask the canvas…" style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
            <button onClick={() => { send("main", input); setInput(""); }} disabled={loading}
              style={{ padding: "10px 16px", borderRadius: 10, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff" }}>
              {loading ? "…" : "Send"}
            </button>
          </div>
        </div>
      </div>

      {/* Side panel: selection-scoped chat */}
      <div style={{ borderLeft: "1px solid var(--border)", background: "var(--panel-2)", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)", fontSize: 13, fontWeight: 500 }}>Selection chat</div>
        <div style={{ padding: 12, borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--muted)" }}>
          {selection.length ? selection.map((id) => nodeById[id]?.title || id).join(", ") : "Select nodes on the canvas to ask about them."}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {sideLog.map((m, i) => (
            <div key={i} style={{ fontSize: 13, margin: "6px 0", color: m.role === "user" ? "var(--text)" : "var(--muted)" }}>
              <b>{m.role === "user" ? "you" : "assistant"}:</b> {m.text}
            </div>
          ))}
        </div>
        <div style={{ padding: 12, display: "flex", gap: 8, borderTop: "1px solid var(--border)" }}>
          <input value={sideInput} onChange={(e) => setSideInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (send("side_chat", sideInput), setSideInput(""))}
            placeholder="Ask about the selection…" style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
          <button onClick={() => { send("side_chat", sideInput); setSideInput(""); }} disabled={loading || !selection.length}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>Ask</button>
        </div>
      </div>
    </div>
  );
}

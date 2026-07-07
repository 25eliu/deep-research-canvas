"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyOps, type CanvasOp } from "@/lib/schema";
import { computeStructuredLayout } from "@/lib/layout";
import {
  type Session, type Provider, type Surface, type ChatMsg, type CanvasView,
  newSession, loadSessions, saveSessions, hasStarted, uid, buildHistory,
} from "@/lib/sessions";
import type { LiveStep } from "@/lib/trace";
import Sidebar from "@/components/Sidebar";
import Landing from "@/components/Landing";
import ChatPanel from "@/components/ChatPanel";
import CanvasScene from "@/components/CanvasScene";
import { ProviderSeg, TakoSwitch } from "@/components/ProviderControls";
import { IconSidebar, IconPlus, IconMinus, IconFit } from "@/components/icons";

export default function Page() {
  // ---- session store (client-only persistence) ----
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const loaded = loadSessions();
    if (loaded?.length) { setSessions(loaded); setActiveId(loaded[0].id); }
    else { const s = newSession(); setSessions([s]); setActiveId(s.id); }
    setReady(true);
  }, []);
  useEffect(() => { if (ready) saveSessions(sessions); }, [sessions, ready]);

  const active = useMemo(() => sessions.find((s) => s.id === activeId), [sessions, activeId]);

  const patchActive = useCallback((fn: (s: Session) => Session) => {
    setSessions((list) => list.map((s) => (s.id === activeId ? fn(s) : s)));
  }, [activeId]);

  // ---- ephemeral UI state ----
  const [selection, setSelection] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStage, setLoadingStage] = useState("");
  const [error, setError] = useState<string | null>(null);

  const started = hasStarted(active);
  // Entity-section header cards ("United States", "NVIDIA", …) are empty group labels
  // that just take up space — hide them. Sources still group by their `section` key.
  const visibleNodes = useMemo(
    () => (active?.state.nodes ?? []).filter((n) => n.type !== "entity_section" && n.role !== "header"),
    [active?.state.nodes],
  );
  const nodeById = useMemo(
    () => Object.fromEntries(visibleNodes.map((n) => [n.id, n])),
    [visibleNodes],
  );
  // Structured band layout gives every node a stable slot; user-dragged cards (and the
  // one actively being dragged) override their slot with their manual position.
  const layout = useMemo(
    () => computeStructuredLayout(visibleNodes, heights, active?.state.edges ?? []),
    [visibleNodes, heights, active?.state.edges],
  );
  const reportHeight = useCallback((id: string, h: number) => {
    setHeights((prev) => (Math.abs((prev[id] ?? 0) - h) > 2 ? { ...prev, [id]: h } : prev));
  }, []);
  const pos = useMemo(() => {
    const out = { ...layout.positions };
    for (const n of visibleNodes)
      if ((movedIds.has(n.id) || n.id === draggingId) && n.position) out[n.id] = n.position;
    return out;
  }, [layout, movedIds, draggingId, visibleNodes]);

  // ---- backend call (contract unchanged) ----
  const send = useCallback(async (surface: Surface, text: string) => {
    if (!text.trim() || loading || !active) return;
    const snap = active;
    const focusTitles = selection.map((id) => nodeById[id]?.title || id).filter(Boolean);
    setLoading(true); setError(null);

    const userMsg: ChatMsg = { id: uid(), role: "user", text, surface, focus: surface === "side_chat" ? focusTitles : undefined };
    patchActive((s) => ({
      ...s,
      title: s.messages.length === 0 ? text.slice(0, 48) : s.title,
      messages: [...s.messages, userMsg],
    }));

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canvasId: snap.id, message: text, surface,
          canvasState: snap.state,
          selection: { nodeIds: selection, nodes: selection.map((id) => nodeById[id]).filter(Boolean) },
          providerId: snap.provider, takoAnswerEnabled: snap.takoAnswer,
          history: buildHistory(snap), historySummary: snap.summary,
        }),
      });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const synthBuf: Record<string, string> = {}; // accumulated answer text per canvas node
      // One agent chat message per turn: it holds the live trace steps, then the
      // authoritative trace + the final answer prose. Created lazily on first output.
      let agentMsgId = "";
      const ensureAgentMsg = (): string => {
        if (!agentMsgId) {
          const id = (agentMsgId = uid());
          patchActive((s) => ({
            ...s,
            messages: [...s.messages, {
              id, role: "agent", text: "", surface,
              focus: surface === "side_chat" ? focusTitles : undefined,
              steps: [],
            }],
          }));
        }
        return agentMsgId;
      };
      const pushStep = (step: LiveStep) => {
        const id = ensureAgentMsg();
        patchActive((s) => ({
          ...s,
          messages: s.messages.map((m) => (m.id === id ? { ...m, steps: [...(m.steps ?? []), step] } : m)),
        }));
      };
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
            setLoadingStage(evt.stage as string); // lightweight status label only
          } else if (evt.type === "reasoning") {
            pushStep({ t: "reasoning", nodeId: evt.nodeId, depth: evt.depth, question: evt.question, kind: evt.kind, rationale: evt.rationale, entities: evt.entities, metrics: evt.metrics, subQuestions: evt.subQuestions });
          } else if (evt.type === "tako_call") {
            pushStep({ t: "tako", call: evt.call });
          } else if (evt.type === "synthesis") {
            pushStep({ t: "synth", nodeId: evt.nodeId, phase: evt.phase });
          } else if (evt.type === "ops") {
            // Incremental canvas ops — graphs/cards stream onto the board as
            // each search resolves. add_node is idempotent (upsert by id).
            const ops = evt.ops as CanvasOp[];
            if (ops?.length) patchActive((s) => ({ ...s, state: applyOps(s.state, ops) }));
          } else if (evt.type === "token") {
            const text = String(evt.text ?? "");
            if (!text) continue;
            if (evt.nodeId) {
              // Answer streams INTO a canvas node (the Synthesis block).
              const id = evt.nodeId as string;
              synthBuf[id] = (synthBuf[id] ?? "") + text; // update_node replaces, so accumulate
              const summary = synthBuf[id];
              patchActive((s) => ({ ...s, state: applyOps(s.state, [{ op: "update_node", id, patch: { summary } }]) }));
            } else {
              // Follow-up / baseline answers stream into the chat message.
              const id = ensureAgentMsg();
              patchActive((s) => ({ ...s, messages: s.messages.map((m) => (m.id === id ? { ...m, text: m.text + text } : m)) }));
            }
          } else if (evt.type === "error") {
            setError(evt.error);
          } else if (evt.type === "result") {
            const id = ensureAgentMsg();
            patchActive((s) => {
              const nextState = evt.canvasOps?.length ? applyOps(s.state, evt.canvasOps) : s.state;
              // The answer: sideReply for a side-chat turn, else the narration or the
              // root synthesis prose that streamed onto the canvas synth node.
              const answer = surface === "side_chat"
                ? (evt.sideReply ?? "")
                : (evt.narration || synthBuf["synth"] || "");
              const messages = s.messages.map((m) =>
                m.id === id ? { ...m, text: answer || m.text, trace: evt.trace, steps: undefined } : m,
              );
              const memory = evt.memory as { summary?: string; summarizedThrough?: string } | undefined;
              return {
                ...s,
                state: nextState,
                messages,
                summary: memory?.summary ?? s.summary,
                summaryUpToId: memory?.summarizedThrough ?? s.summaryUpToId,
              };
            });
          }
        }
      }
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false); setLoadingStage("");
    }
  }, [active, selection, nodeById, loading, patchActive]);

  const sendFromPanel = useCallback((text: string) => {
    send(selection.length ? "side_chat" : "main", text);
  }, [send, selection.length]);

  // ---- pan / zoom / drag ----
  // Two layers: a LIVE imperative layer (viewRef + direct style writes, zero React during a
  // gesture) and the committed React layer (session.view) used only for persistence.
  const MIN_SCALE = 0.1, MAX_SCALE = 4;
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; startX: number; startY: number; base: { x: number; y: number }; el: HTMLElement } | null>(null);
  const pan = useRef<{ startX: number; startY: number; base: { x: number; y: number } } | null>(null);
  const moved = useRef(false); // did the current gesture move past the click threshold?
  const userAdjusted = useRef<Set<string>>(new Set()); // sessions where the user took control of the view
  const didFit = useRef<Set<string>>(new Set()); // sessions already auto-framed once
  const viewRef = useRef<CanvasView>(active?.view ?? { x: 0, y: 0, scale: 1 });
  const anim = useRef<{ target: CanvasView; cur: CanvasView; raf: number } | null>(null);
  const commitTimer = useRef<ReturnType<typeof setTimeout>>();
  const DRAG_THRESHOLD = 4;

  const setView = useCallback((fn: (v: CanvasView) => CanvasView) => {
    patchActive((s) => ({ ...s, view: fn(s.view) }));
  }, [patchActive]);

  // Write the live transform straight to the DOM — the fast path that skips React entirely.
  const applyTransform = useCallback((v: CanvasView) => {
    const el = sceneRef.current;
    if (el) el.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.scale})`;
  }, []);

  // Commit the live view into session state (for persistence) — only on gesture end / debounced.
  const commitView = useCallback(() => { setView(() => viewRef.current); }, [setView]);
  const scheduleCommit = useCallback(() => {
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitView, 200);
  }, [commitView]);

  const cancelAnim = useCallback(() => {
    if (anim.current) { cancelAnimationFrame(anim.current.raf); anim.current = null; }
  }, []);

  const prefersReducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Re-assert the imperative transform after every render, so an unrelated re-render
  // (e.g. a node streaming in mid-pan) can never reset .scene's transform to a stale value.
  useLayoutEffect(() => { applyTransform(viewRef.current); });

  // Initialize / reset the live view only when the active session changes.
  useEffect(() => {
    cancelAnim();
    drag.current = null; pan.current = null; setDraggingId(null);
    viewRef.current = active?.view ?? { x: 0, y: 0, scale: 1 };
    applyTransform(viewRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Eased animation toward a target view — used ONLY by the +/- buttons and fit (no cursor
  // anchor). Paints imperatively each frame; commits to state once when it settles.
  const animateTo = useCallback((target: CanvasView) => {
    if (prefersReducedMotion()) {
      viewRef.current = target; applyTransform(target); setView(() => target); return;
    }
    if (anim.current) { anim.current.target = target; return; }
    const step = () => {
      const a = anim.current;
      if (!a) return;
      const c = a.cur, t = a.target, k = 0.2; // per-frame easing
      c.x += (t.x - c.x) * k; c.y += (t.y - c.y) * k; c.scale += (t.scale - c.scale) * k;
      const done = Math.abs(t.scale - c.scale) < 0.0008 && Math.abs(t.x - c.x) < 0.4 && Math.abs(t.y - c.y) < 0.4;
      const next: CanvasView = done ? { ...t } : { x: c.x, y: c.y, scale: c.scale };
      viewRef.current = next;
      applyTransform(next);
      if (done) { anim.current = null; setView(() => next); }
      else a.raf = requestAnimationFrame(step);
    };
    anim.current = { target, cur: { ...viewRef.current }, raf: requestAnimationFrame(step) };
  }, [applyTransform, setView]);

  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

  // Zoom to an absolute scale while keeping (ax, ay) — stage-local pixels — fixed. Eased;
  // used by the discrete zoom buttons (rapid wheel zoom is applied directly, see below).
  const zoomToward = useCallback((scale: number, ax: number, ay: number) => {
    const base = anim.current?.target ?? viewRef.current;
    const s = clamp(scale, MIN_SCALE, MAX_SCALE);
    const k = s / base.scale;
    animateTo({ scale: s, x: ax - (ax - base.x) * k, y: ay - (ay - base.y) * k });
  }, [animateTo]);

  const markAdjusted = useCallback(() => {
    if (activeId) userAdjusted.current.add(activeId);
  }, [activeId]);

  const zoomButton = useCallback((dir: 1 | -1) => {
    const el = stageRef.current;
    if (!el) return;
    markAdjusted();
    const base = anim.current?.target ?? viewRef.current;
    zoomToward(base.scale * (dir > 0 ? 1.4 : 1 / 1.4), el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomToward, markAdjusted]);

  // Frame the whole board within the canvas (fit button + one-time auto-frame).
  const fitView = useCallback(() => {
    const el = stageRef.current;
    if (!el || el.clientWidth === 0) return;
    const { minX, minY, maxX, maxY } = layout.bounds;
    const cw = maxX - minX, ch = maxY - minY;
    if (cw <= 0 || ch <= 0) return;
    if (activeId) didFit.current.add(activeId); // fitting counts as "framed once"
    const pad = 96;
    const scale = clamp(Math.min((el.clientWidth - pad) / cw, (el.clientHeight - pad) / ch), MIN_SCALE, 1.2);
    const x = (el.clientWidth - cw * scale) / 2 - minX * scale;
    const y = Math.max(28, (el.clientHeight - ch * scale) / 2) - minY * scale;
    animateTo({ x, y, scale });
  }, [layout.bounds, animateTo, activeId]);

  // Don't start a node drag from a link/button/textarea inside a card (let it work).
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && !!t.closest("a,button,textarea,input,select");

  const onNodePointerDown = (id: string) => (e: React.PointerEvent) => {
    if (isInteractive(e.target)) return;
    e.stopPropagation(); // the stage must not also start a pan
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    moved.current = false;
    setDraggingId(id);
    drag.current = { id, startX: e.clientX, startY: e.clientY, base: pos[id] || { x: 0, y: 0 }, el };
  };
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    // Don't start a pan (which captures the pointer) when pressing a UI control on the
    // stage — capturing would swallow the control's click (e.g. the zoom buttons).
    if (isInteractive(e.target)) return;
    cancelAnim();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); // keep events flowing off-viewport
    moved.current = false;
    pan.current = { startX: e.clientX, startY: e.clientY, base: { ...viewRef.current } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (drag.current) {
      const dx = e.clientX - drag.current.startX, dy = e.clientY - drag.current.startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) moved.current = true;
      const s = viewRef.current.scale;
      // Move the card imperatively (scene coords) — no setState, so no layout recompute.
      drag.current.el.style.transform = `translate(${dx / s}px,${dy / s}px)`;
    } else if (pan.current) {
      const dx = e.clientX - pan.current.startX, dy = e.clientY - pan.current.startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) { moved.current = true; markAdjusted(); }
      viewRef.current = { scale: viewRef.current.scale, x: pan.current.base.x + dx, y: pan.current.base.y + dy };
      applyTransform(viewRef.current);
    }
  };
  const endInteraction = (e?: React.PointerEvent) => {
    if (drag.current) {
      const { id, base, startX, startY, el } = drag.current;
      if (moved.current && e) {
        const s = viewRef.current.scale;
        const np = { x: base.x + (e.clientX - startX) / s, y: base.y + (e.clientY - startY) / s };
        // Reconcile the DOM to the committed position, then clear the imperative transform.
        el.style.left = `${np.x}px`; el.style.top = `${np.y}px`; el.style.transform = "";
        setMovedIds((m) => new Set(m).add(id)); // user-placed card becomes a fixed anchor
        patchActive((st) => ({ ...st, state: applyOps(st.state, [{ op: "move_node", id, position: np }]) }));
      } else {
        el.style.transform = ""; // a click, not a drag
      }
    } else if (pan.current) {
      if (moved.current) commitView(); // persist the panned view
      else setSelection([]); // click on empty canvas clears highlight
    }
    drag.current = null; pan.current = null;
    setDraggingId(null);
  };

  // Wheel: cursor-anchored zoom applied DIRECTLY to the live view (no multi-frame ease, so
  // the anchor never drifts). Shift = horizontal pan; ctrl/meta and trackpad pinch = zoom.
  // Native non-passive listener so preventDefault stops the browser's own page zoom.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnim();
      markAdjusted();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1; // lines/pages → px
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      const cur = viewRef.current;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        viewRef.current = { ...cur, x: cur.x - (dx || dy) }; // horizontal pan
      } else {
        const s = clamp(cur.scale * clamp(Math.exp(-dy * 0.002), 0.8, 1.2), MIN_SCALE, MAX_SCALE);
        const k = s / cur.scale;
        viewRef.current = { scale: s, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k };
      }
      applyTransform(viewRef.current);
      scheduleCommit();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTransform, scheduleCommit, markAdjusted, cancelAnim]);


  // Auto-frame the board ONCE, shortly after it first gets nodes (let the first wave of
  // card heights settle). Never re-frames on subsequent height churn; user pan/zoom opts out.
  useEffect(() => {
    if (!active || loading) return;
    const id = active.id;
    if (active.state.nodes.length === 0) { didFit.current.delete(id); userAdjusted.current.delete(id); return; }
    if (didFit.current.has(id) || userAdjusted.current.has(id)) return;
    const el = stageRef.current;
    if (!el || el.clientWidth === 0) return;
    const t = setTimeout(() => {
      if (userAdjusted.current.has(id) || didFit.current.has(id)) return;
      fitView();
    }, 250);
    return () => clearTimeout(t);
  }, [active?.state.nodes.length, active?.id, loading, fitView]);

  const toggleSelect = (id: string) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (moved.current) return; // was a drag, not a click
    setSelection((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  };
  const toggleCollapse = (id: string) => () => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
  };

  // ---- session actions ----
  const newCanvas = () => {
    const s = newSession();
    setSessions((list) => [s, ...list]);
    setActiveId(s.id); setSelection([]); setCollapsed({}); setMovedIds(new Set()); setError(null);
  };
  const selectSession = (id: string) => {
    setActiveId(id); setSelection([]); setCollapsed({}); setMovedIds(new Set()); setError(null);
  };
  const deleteSession = (id: string) => {
    // Compute from the current list (not inside the setState updater) so newSession()
    // stays out of an impure updater — otherwise React's dev double-invoke mints two
    // different fresh canvases and activeId ends up pointing at neither.
    const next = sessions.filter((s) => s.id !== id);
    const result = next.length ? next : [newSession()]; // deleting the last one leaves a fresh canvas
    setSessions(result);
    if (id === activeId) {
      setActiveId(result[0].id); // move off the deleted (or fresh) canvas
      setSelection([]); setCollapsed({}); setMovedIds(new Set()); setError(null);
    }
  };

  if (!ready || !active) return <div className="loader">Canvas · Tako</div>;

  const sidebarW = sidebarCollapsed ? 62 : 264;
  const panelW = !started ? 0 : panelCollapsed ? 48 : 356;
  const selectionTitles = selection.map((id) => nodeById[id]?.title || id).filter(Boolean);

  return (
    <div className="app-root">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        onNew={newCanvas}
        onSelect={selectSession}
        onDelete={deleteSession}
      />

      <div
        className="stage"
        ref={stageRef}
        style={{ left: sidebarW, right: panelW }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
      >
        <CanvasScene
          nodes={visibleNodes}
          edges={active.state.edges}
          pos={pos}
          sceneRef={sceneRef}
          draggingId={draggingId}
          bands={layout.bands}
          selection={selection}
          collapsed={collapsed}
          heights={heights}
          onSelect={toggleSelect}
          onDragStart={onNodePointerDown}
          onToggleCollapse={toggleCollapse}
          onMeasure={reportHeight}
          nodeById={nodeById}
        />

        {/* Zoom controls — stop pointerdown from starting a canvas pan (which would
            capture the pointer and swallow these buttons' clicks). */}
        {started && (
          <div className="zoom-controls" onPointerDown={(e) => e.stopPropagation()}>
            <button className="zoom-btn" onClick={() => zoomButton(1)} aria-label="Zoom in"><IconPlus /></button>
            <button className="zoom-pct" onClick={fitView} title="Fit to view">{Math.round(active.view.scale * 100)}%</button>
            <button className="zoom-btn" onClick={() => zoomButton(-1)} aria-label="Zoom out"><IconMinus /></button>
            <button className="zoom-btn fit" onClick={fitView} aria-label="Fit to view"><IconFit /></button>
          </div>
        )}

        {/* Top bar — appears once the canvas is in use */}
        {started && (
          <div className="topbar" onPointerDown={(e) => e.stopPropagation()}>
            {sidebarCollapsed && (
              <button className="icon-btn" onClick={() => setSidebarCollapsed(false)} aria-label="Show sidebar">
                <IconSidebar />
              </button>
            )}
            <span className="topbar-title">{active.title}</span>
            <span className="spacer" />
            <ProviderSeg provider={active.provider} onChange={(p: Provider) => patchActive((s) => ({ ...s, provider: p }))} />
            <TakoSwitch checked={active.takoAnswer} onChange={(v) => patchActive((s) => ({ ...s, takoAnswer: v }))} />
          </div>
        )}
      </div>

      {/* Centered composer → slides into the side panel on first send */}
      <Landing
        hidden={started}
        provider={active.provider}
        setProvider={(p) => patchActive((s) => ({ ...s, provider: p }))}
        takoAnswer={active.takoAnswer}
        setTakoAnswer={(v) => patchActive((s) => ({ ...s, takoAnswer: v }))}
        onSend={(t) => send("main", t)}
        loading={loading}
      />

      <ChatPanel
        away={!started}
        collapsed={panelCollapsed}
        onToggleCollapse={() => setPanelCollapsed((v) => !v)}
        messages={active.messages}
        selectionTitles={selectionTitles}
        onClearSelection={() => setSelection([])}
        onSend={sendFromPanel}
        loading={loading}
        loadingStage={loadingStage}
        error={error}
        onSelectNode={(id) => setSelection([id])}
      />
    </div>
  );
}

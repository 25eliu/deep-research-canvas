"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { applyOps, type CanvasOp } from "@/lib/schema";
import { computeStructuredLayout, nodeWidth, nodeHeight } from "@/lib/layout";
import { getDescendants } from "@/lib/lineage";
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
  // Camera follow: a node the view should center on once the layout has placed it —
  // set for each research node streaming in, then the synth node when the run ends.
  const [focusNodeId, setFocusNodeId] = useState<string | null>(null);

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
    // A research question takes over the screen — get the sidebar out of the way.
    if (surface === "main" && !hasStarted(snap)) setSidebarCollapsed(true);

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
      let lastSynthId = "synth"; // newest synthesis root seen this run (camera home + narration fallback)
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
            pushStep({ t: "reasoning", nodeId: evt.nodeId, depth: evt.depth, question: evt.question, kind: evt.kind, rationale: evt.rationale, entities: evt.entities, subtype: evt.subtype, metrics: evt.metrics, subQuestions: evt.subQuestions });
          } else if (evt.type === "tako_call") {
            pushStep({ t: "tako", call: evt.call });
          } else if (evt.type === "graph_call") {
            pushStep({ t: "graph", nodeId: evt.nodeId, call: evt.call });
          } else if (evt.type === "synthesis") {
            pushStep({ t: "synth", nodeId: evt.nodeId, phase: evt.phase });
          } else if (evt.type === "ops") {
            // Incremental canvas ops — graphs/cards stream onto the board as
            // each search resolves. add_node is idempotent (upsert by id).
            const ops = evt.ops as CanvasOp[];
            if (ops?.length) {
              patchActive((s) => ({ ...s, state: applyOps(s.state, ops) }));
              // Camera follow: pan to each sub-question node as it lands on the board,
              // and remember the newest synthesis root (a research/expand run's answer).
              for (const op of ops) {
                if (op.op === "add_node" && op.node.role === "research") setFocusNodeId(op.node.id);
                if ((op.op === "add_node" || op.op === "upsert_node") && op.node.role === "synthesis") lastSynthId = op.node.id;
              }
            }
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
                : (evt.narration || synthBuf[lastSynthId] || "");
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
      // Run finished — bring the camera home to the synthesis answer.
      if (surface === "main") setFocusNodeId(lastSynthId);
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
  // A drag carries the pressed node plus its whole subtree — every item moves in unison.
  const drag = useRef<{
    id: string; startX: number; startY: number;
    items: { id: string; el: HTMLElement; base: { x: number; y: number } }[];
  } | null>(null);
  const pan = useRef<{ startX: number; startY: number; base: { x: number; y: number } } | null>(null);
  const moved = useRef(false); // did the current gesture move past the click threshold?
  const userAdjusted = useRef<Set<string>>(new Set()); // sessions where the user took control of the view
  const didFit = useRef<Set<string>>(new Set()); // sessions already auto-framed once
  const viewRef = useRef<CanvasView>(active?.view ?? { x: 0, y: 0, scale: 1 });
  const anim = useRef<{ target: CanvasView; cur: CanvasView; raf: number } | null>(null);
  // Eased wheel zoom: accumulates a target scale and glides toward it each frame while
  // re-anchoring on the latest cursor point — smooth AND drift-free.
  const zoomAnim = useRef<{ target: number; ax: number; ay: number; raf: number } | null>(null);
  const pctRef = useRef<HTMLButtonElement>(null); // live zoom % readout (imperative, no re-render)
  const commitTimer = useRef<ReturnType<typeof setTimeout>>();
  const DRAG_THRESHOLD = 4;

  const setView = useCallback((fn: (v: CanvasView) => CanvasView) => {
    patchActive((s) => ({ ...s, view: fn(s.view) }));
  }, [patchActive]);

  // Write the live transform straight to the DOM — the fast path that skips React entirely.
  const applyTransform = useCallback((v: CanvasView) => {
    const el = sceneRef.current;
    if (el) el.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.scale})`;
    if (pctRef.current) pctRef.current.textContent = `${Math.round(v.scale * 100)}%`;
  }, []);

  // Commit the live view into session state (for persistence) — only on gesture end / debounced.
  const commitView = useCallback(() => { setView(() => viewRef.current); }, [setView]);
  const scheduleCommit = useCallback(() => {
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(commitView, 200);
  }, [commitView]);

  const cancelButtonAnim = useCallback(() => {
    if (anim.current) { cancelAnimationFrame(anim.current.raf); anim.current = null; }
  }, []);
  const cancelZoomAnim = useCallback(() => {
    if (zoomAnim.current) { cancelAnimationFrame(zoomAnim.current.raf); zoomAnim.current = null; }
  }, []);
  const cancelAnim = useCallback(() => {
    cancelButtonAnim();
    cancelZoomAnim();
  }, [cancelButtonAnim, cancelZoomAnim]);

  const prefersReducedMotion = () =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Re-assert the imperative transform after every render, so an unrelated re-render
  // (e.g. a node streaming in mid-pan) can never reset .scene's transform to a stale value.
  useLayoutEffect(() => { applyTransform(viewRef.current); });

  // Initialize / reset the live view only when the active session changes.
  useEffect(() => {
    cancelAnim();
    drag.current = null; pan.current = null; setDraggingId(null);
    setFocusNodeId(null); // a follow from the previous session must not steer this one
    viewRef.current = active?.view ?? { x: 0, y: 0, scale: 1 };
    applyTransform(viewRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Eased animation toward a target view — used ONLY by the +/- buttons and fit (no cursor
  // anchor). Paints imperatively each frame; commits to state once when it settles.
  const animateTo = useCallback((target: CanvasView) => {
    cancelZoomAnim(); // the wheel-zoom glide must not fight a button/fit animation
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
  }, [applyTransform, setView, cancelZoomAnim]);

  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

  // Wheel zoom with momentum: each tick multiplies an accumulated TARGET scale, and a rAF
  // loop glides the live scale toward it in log space. The anchor correction is applied
  // per-frame against the CURRENT view, so the pixel under the cursor stays fixed on every
  // frame — smooth easing without the anchor drift a naive view-lerp would cause.
  const startWheelZoom = useCallback((factor: number, ax: number, ay: number) => {
    const za = zoomAnim.current;
    const target = clamp((za ? za.target : viewRef.current.scale) * factor, MIN_SCALE, MAX_SCALE);
    if (za) { za.target = target; za.ax = ax; za.ay = ay; return; } // retarget the running glide
    const step = () => {
      const z = zoomAnim.current;
      if (!z) return;
      const cur = viewRef.current;
      const remaining = Math.log(z.target / cur.scale);
      const done = Math.abs(remaining) < 0.0035;
      const s = done ? z.target : cur.scale * Math.exp(remaining * 0.32);
      const k = s / cur.scale;
      viewRef.current = { scale: s, x: z.ax - (z.ax - cur.x) * k, y: z.ay - (z.ay - cur.y) * k };
      applyTransform(viewRef.current);
      if (done) { zoomAnim.current = null; scheduleCommit(); }
      else z.raf = requestAnimationFrame(step);
    };
    zoomAnim.current = { target, ax, ay, raf: requestAnimationFrame(step) };
  }, [applyTransform, scheduleCommit]);

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
    setFocusNodeId(null); // the user has the camera — stop any live follow
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

  // Glide the view so a node sits centered AND fully in frame. Keeps the current
  // zoom when the whole card already fits at it; otherwise eases to the largest
  // scale that shows the entire card (never past 100%).
  const frameNode = useCallback((nodeId: string) => {
    const el = stageRef.current;
    const p = pos[nodeId], n = nodeById[nodeId];
    if (!el || el.clientWidth === 0 || !p || !n) return;
    const w = nodeWidth(n), h = heights[nodeId] ?? nodeHeight(n);
    const pad = 72;
    const fit = clamp(Math.min((el.clientWidth - pad) / w, (el.clientHeight - pad) / h, 1), MIN_SCALE, 1);
    const cur = anim.current?.target.scale ?? viewRef.current.scale;
    const s = cur >= 0.5 && cur <= fit ? cur : fit;
    animateTo({
      scale: s,
      x: el.clientWidth / 2 - (p.x + w / 2) * s,
      y: el.clientHeight / 2 - (p.y + h / 2) * s,
    });
  }, [pos, nodeById, heights, animateTo]);

  // Camera follow: once the layout has placed the requested node, glide to it —
  // and KEEP re-framing while its height streams in and the layout settles, so the
  // move actually completes on the final geometry instead of a mid-stream snapshot.
  // The focus stays live until a new focus arrives or the user takes the camera
  // (pan / wheel / zoom buttons / card drag). Following counts as "framed once" so
  // the one-time auto-fit below doesn't yank the camera right after the run lands.
  useEffect(() => {
    if (!focusNodeId) return;
    if (!pos[focusNodeId] || !nodeById[focusNodeId]) return; // not placed yet — retry on next layout
    frameNode(focusNodeId);
    if (activeId) didFit.current.add(activeId);
  }, [focusNodeId, pos, nodeById, frameNode, activeId]);

  // Don't start a node drag from a link/button/textarea inside a card (let it work).
  const isInteractive = (t: EventTarget | null) =>
    t instanceof HTMLElement && !!t.closest("a,button,textarea,input,select");

  // Nearest ancestor of `t` (up to the scene) that actually overflows and scrolls on the
  // given axis — long synthesis answers, reports, source lists. Wheel and pointer gestures
  // over one of these belong to the card's content, not to the canvas.
  const scrollableAncestor = useCallback((t: EventTarget | null, horizontal: boolean): HTMLElement | null => {
    let n = t instanceof HTMLElement ? t : null;
    while (n && n !== sceneRef.current && n !== document.body) {
      const overflows = horizontal
        ? n.scrollWidth > n.clientWidth + 1
        : n.scrollHeight > n.clientHeight + 1;
      if (overflows) {
        const o = getComputedStyle(n)[horizontal ? "overflowX" : "overflowY"];
        if (o === "auto" || o === "scroll") return n;
      }
      n = n.parentElement;
    }
    return null;
  }, []);

  const onNodePointerDown = (id: string) => (e: React.PointerEvent) => {
    if (isInteractive(e.target)) return;
    e.stopPropagation(); // the stage must not also start a pan
    // Inside an overflowing body, the pointer belongs to the content: scrollbar-thumb
    // drags and text selection must work, so don't hijack it into a card drag (the
    // card is still draggable by its header and padding).
    if (scrollableAncestor(e.target, false) || scrollableAncestor(e.target, true)) {
      moved.current = false; // a stale drag flag must not swallow the upcoming click
      return;
    }
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId); // capture on the root only — all moves flow through it
    moved.current = false;
    setDraggingId(id);
    // Snapshot the pressed node plus every rendered descendant so the branch moves as one.
    const items = [{ id, el, base: pos[id] || { x: 0, y: 0 } }];
    for (const d of getDescendants(id, active?.state.edges ?? [])) {
      if (!nodeById[d]) continue; // hidden section/header nodes aren't rendered
      const del = sceneRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(d)}"]`);
      if (del) items.push({ id: d, el: del, base: pos[d] || { x: 0, y: 0 } });
    }
    drag.current = { id, startX: e.clientX, startY: e.clientY, items };
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
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved.current = true;
        setFocusNodeId(null); // dragging a card must not fight a live camera follow
      }
      const s = viewRef.current.scale;
      // Move the branch imperatively (scene coords) — no setState, so no layout recompute.
      const t = `translate(${dx / s}px,${dy / s}px)`;
      for (const it of drag.current.items) it.el.style.transform = t;
    } else if (pan.current) {
      const dx = e.clientX - pan.current.startX, dy = e.clientY - pan.current.startY;
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD) { moved.current = true; markAdjusted(); }
      viewRef.current = { scale: viewRef.current.scale, x: pan.current.base.x + dx, y: pan.current.base.y + dy };
      applyTransform(viewRef.current);
    }
  };
  const endInteraction = (e?: React.PointerEvent) => {
    if (drag.current) {
      const { items, startX, startY } = drag.current;
      if (moved.current && e) {
        const s = viewRef.current.scale;
        const dx = (e.clientX - startX) / s, dy = (e.clientY - startY) / s;
        const ops: CanvasOp[] = [];
        for (const it of items) {
          const np = { x: it.base.x + dx, y: it.base.y + dy };
          // Reconcile the DOM to the committed position, then clear the imperative transform.
          it.el.style.left = `${np.x}px`; it.el.style.top = `${np.y}px`; it.el.style.transform = "";
          ops.push({ op: "move_node", id: it.id, position: np });
        }
        // Every user-placed card in the branch becomes a fixed anchor.
        setMovedIds((m) => { const next = new Set(m); for (const it of items) next.add(it.id); return next; });
        patchActive((st) => ({ ...st, state: applyOps(st.state, ops) }));
      } else {
        for (const it of items) it.el.style.transform = ""; // a click, not a drag
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
      // A plain wheel over a card's overflowing content (long synthesis answer, report,
      // sources list) scrolls that content — zoom stays on pinch / ctrl+wheel and on the
      // canvas itself. Returning WITHOUT preventDefault hands the event to the browser's
      // native scroller. Deliberately no zoom fallthrough at the scroll boundary: hitting
      // the end of the text must not fling the canvas.
      if (!e.ctrlKey && !e.metaKey) {
        const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
        if (scrollableAncestor(e.target, horizontal)) return;
      }
      e.preventDefault();
      cancelButtonAnim(); // keep a running wheel-zoom glide alive — it retargets instead
      markAdjusted();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left, py = e.clientY - rect.top;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1; // lines/pages → px
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      const cur = viewRef.current;
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        cancelZoomAnim();
        viewRef.current = { ...cur, x: cur.x - (dx || dy) }; // horizontal pan
        applyTransform(viewRef.current);
      } else {
        const factor = clamp(Math.exp(-dy * 0.002), 0.8, 1.2);
        if (prefersReducedMotion()) {
          const s = clamp(cur.scale * factor, MIN_SCALE, MAX_SCALE);
          const k = s / cur.scale;
          viewRef.current = { scale: s, x: px - (px - cur.x) * k, y: py - (py - cur.y) * k };
          applyTransform(viewRef.current);
        } else {
          startWheelZoom(factor, px, py); // eased, cursor-anchored
        }
      }
      scheduleCommit();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyTransform, scheduleCommit, markAdjusted, cancelButtonAnim, cancelZoomAnim, startWheelZoom, scrollableAncestor]);


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
    if (window.getSelection()?.toString()) return; // finishing a text selection, not a click
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
    // Opening a research canvas takes over the screen — tuck the sidebar away.
    const s = sessions.find((x) => x.id === id);
    if (s && hasStarted(s)) setSidebarCollapsed(true);
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
  // Floating panel: reserve its width + edge inset + gap; collapsed leaves only the launcher.
  const panelW = !started ? 0 : panelCollapsed ? 0 : 384;
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
            <button className="zoom-pct" ref={pctRef} onClick={() => { markAdjusted(); fitView(); }} title="Fit to view">{Math.round(active.view.scale * 100)}%</button>
            <button className="zoom-btn" onClick={() => zoomButton(-1)} aria-label="Zoom out"><IconMinus /></button>
            <button className="zoom-btn fit" onClick={() => { markAdjusted(); fitView(); }} aria-label="Fit to view"><IconFit /></button>
          </div>
        )}

        {/* Top bar — appears once the canvas is in use */}
        {started && (
          <div
            className="topbar"
            // The floating chat launcher occupies the window's top-right corner while the
            // panel is collapsed — keep the toolbar's controls clear of it.
            style={{ paddingRight: panelCollapsed ? 72 : undefined }}
            onPointerDown={(e) => e.stopPropagation()}
          >
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

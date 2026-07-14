// Client-only chat session history (ChatGPT-style left rail).
// Purely frontend state persisted to localStorage — the backend is stateless
// and receives the canvasState on every request, so this touches nothing server-side.
import type { CanvasState, ChatTurn } from "./schema";
import { slimTrace, type TurnTrace, type LiveStep } from "./trace";

export type Provider = "gpt" | "claude" | "tako" | "tako-search";
export type Surface = "main" | "side_chat";

export interface ChatMsg {
  id: string;
  role: "user" | "agent";
  text: string;
  surface: Surface;
  focus?: string[]; // titles of selected nodes, for side_chat messages
  kind?: "tool"; // legacy: a compact tool-call chip (retained for old sessions)
  icon?: string; // legacy: emoji shown on a tool chip
  trace?: TurnTrace; // authoritative agent trace, attached on the `result` event
  steps?: LiveStep[]; // live step accumulator, present only while streaming
}

export interface CanvasView {
  x: number;
  y: number;
  scale: number;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  state: CanvasState;
  messages: ChatMsg[];
  provider: Provider;
  takoAnswer: boolean;
  graphy: boolean; // per-turn hero Graphy chart on the synthesis report
  view: CanvasView;
  summary?: string;
  summaryUpToId?: string;
}

const KEY = "canvas-tako.sessions.v1";

export function uid(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function newSession(): Session {
  return {
    id: uid(),
    title: "New canvas",
    createdAt: Date.now(),
    state: { nodes: [], edges: [] },
    messages: [],
    provider: "tako",
    takoAnswer: true,
    graphy: false,
    view: { x: 0, y: 0, scale: 1 },
  };
}

export function hasStarted(s: Session | undefined): boolean {
  return !!s && (s.messages.length > 0 || s.state.nodes.length > 0);
}

// Wire subset of the thread the backend needs: turns not yet folded into the
// cached summary, with client-only trace/steps and legacy tool chips stripped.
export function buildHistory(s: Session): ChatTurn[] {
  const all = s.messages;
  const start = s.summaryUpToId ? all.findIndex((m) => m.id === s.summaryUpToId) + 1 : 0;
  return all
    .slice(start)
    .filter((m) => m.kind !== "tool")
    .map((m) => ({ id: m.id, role: m.role, text: m.text, surface: m.surface, focus: m.focus }));
}

export function loadSessions(): Session[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Session[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

// Prepare a session for persistence. Per the trace policy:
//  - main-surface agent turns keep a SLIMMED trace (guaranteeing the Tako
//    call records — query/endpoint/effort/ms + card title/source/url);
//  - side-chat / follow-up turns drop the trace entirely (live-only);
//  - transient live `steps` are always stripped.
function serializeSession(s: Session): Session {
  return {
    ...s,
    messages: s.messages.map((m) => {
      const { steps: _steps, ...rest } = m;
      if (m.role !== "agent") return rest;
      if (m.surface === "main" && m.trace) return { ...rest, trace: slimTrace(m.trace) };
      const { trace: _trace, ...noTrace } = rest; // side_chat → no persisted trace
      return noTrace;
    }),
  };
}

// Drop the heaviest part of the oldest turns' traces (tree + embedded cards) so
// the payload fits, retaining a footer-sufficient summary. Turns silent quota
// loss into graceful trace-shedding.
function shedTraces(list: Session[]): Session[] {
  let shed = false;
  const next = list.map((s) => ({
    ...s,
    messages: s.messages.map((m) => {
      if (!m.trace) return m;
      shed = true;
      return { ...m, trace: { ...m.trace, tree: undefined, calls: undefined, cards: [], reasoning: undefined } };
    }),
  }));
  return shed ? next : list;
}

const MAX_BYTES = 3_500_000;

export function saveSessions(list: Session[]): void {
  if (typeof window === "undefined") return;
  const serialized = list.map(serializeSession);
  const guarded = JSON.stringify(serialized).length > MAX_BYTES ? shedTraces(serialized) : serialized;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(guarded));
  } catch {
    // Last-resort: retry once with all heavy traces shed before giving up.
    try {
      window.localStorage.setItem(KEY, JSON.stringify(shedTraces(serialized)));
    } catch {
      /* quota / private mode — non-fatal */
    }
  }
}

"use client";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ChatMsg } from "@/lib/sessions";
import {
  IconSend, IconChevronRight, IconX, IconSpark, IconChat,
  IconSearch, IconChart, IconDoc, IconLink, IconPen,
} from "./icons";
import Markdown from "./Markdown";
import TraceView from "./TraceView";

// Legacy persisted sessions stored emoji as their tool-chip icon. Render those
// through the app's stroke-icon language; unknown strings fall through as-is.
const TOOL_CHIP_ICONS: Record<string, ReactNode> = {
  "🔍": <IconSearch />,
  "📊": <IconChart />,
  "📄": <IconDoc />,
  "🔗": <IconLink />,
  "✍️": <IconPen />,
};

export default function ChatPanel({
  away, collapsed, onToggleCollapse, messages, selectionTitles, onClearSelection,
  onSend, loading, loadingStage, error, onSelectNode,
}: {
  away: boolean;
  collapsed: boolean;
  onToggleCollapse: () => void;
  messages: ChatMsg[];
  selectionTitles: string[];
  onClearSelection: () => void;
  onSend: (text: string) => void;
  loading: boolean;
  loadingStage: string;
  error: string | null;
  onSelectNode: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const focused = selectionTitles.length > 0;

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, loadingStage, loading]);

  // Composer grows with its content (up to ~5 lines) instead of scrolling inside one row.
  const fitComposer = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  };

  const submit = () => {
    if (!text.trim() || loading) return;
    onSend(text.trim());
    setText("");
    requestAnimationFrame(fitComposer); // collapse back to one row after clearing
  };

  return (
    <>
    <section className={`chat-panel${away || collapsed ? " away" : ""}`}>
      <div className="panel-head">
        <div className="panel-id">
          <div className="panel-title">Canvas Assistant</div>
          <div className="panel-status"><span className="online" /> Grounded in Tako · live</div>
        </div>
        <button className="icon-btn" onClick={onToggleCollapse} aria-label="Collapse panel">
          <IconChevronRight />
        </button>
      </div>

      {focused && (
        <div className="focus-banner">
          <span className="titles">Focused on {selectionTitles.join(", ")}</span>
          <span className="x" onClick={onClearSelection} role="button" aria-label="Clear selection">
            <IconX />
          </span>
        </div>
      )}

      <div className="thread" ref={threadRef}>
        {messages.length === 0 && !loading && (
          <div className="thread-empty">
            <span className="halo"><IconSpark /></span>
            <span>
              Ask a follow-up about your board, or select nodes on the canvas to
              focus the conversation on them.
            </span>
          </div>
        )}
        {messages.map((m) => {
          // Legacy tool chips from older persisted sessions (no trace/steps).
          if (m.kind === "tool") {
            return (
              <div key={m.id} className="tool-chip">
                <span className="tool-chip-icon">{(m.icon && TOOL_CHIP_ICONS[m.icon]) ?? m.icon}</span>
                <span className="tool-chip-label">{m.text}</span>
              </div>
            );
          }
          if (m.role === "user") {
            return (
              <div key={m.id} className="msg user">
                <div className="msg-col"><div className="msg-bubble">{m.text || "…"}</div></div>
              </div>
            );
          }
          // Agent turn: clean answer prose, then the collapsible trace beneath it.
          // Text-forward — no avatar; the content owns the full column width.
          const hasTrace = !!(m.trace || (m.steps && m.steps.length));
          const streaming = loading && !m.trace && m.steps != null;
          return (
            <div key={m.id} className="msg agent">
              <div className="msg-col turn">
                {m.surface === "side_chat" && m.focus?.length ? (
                  <div className="msg-tag"><span className="focus-pill">{m.focus.join(", ")}</span></div>
                ) : null}
                {m.text ? <div className="turn-answer"><Markdown text={m.text} /></div> : null}
                {hasTrace ? <TraceView trace={m.trace} steps={m.steps} streaming={streaming} onSelectNode={onSelectNode} /> : null}
                {!m.text && !hasTrace ? <div className="loading-line shimmer">Thinking…</div> : null}
              </div>
            </div>
          );
        })}
        {loading && messages[messages.length - 1]?.role === "user" && (
          <div className="loading-line shimmer">{loadingStage || "Thinking…"}</div>
        )}
      </div>

      {error && <div className="err-note">{error}</div>}

      <div className="composer-wrap">
        <div className="composer side">
          <textarea
            ref={taRef}
            value={text}
            rows={1}
            placeholder={focused ? "Ask about the selection…" : "Message the assistant…"}
            onChange={(e) => { setText(e.target.value); fitComposer(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          <button className="send-btn" onClick={submit} disabled={loading || !text.trim()} aria-label="Send">
            <IconSend />
          </button>
        </div>
      </div>
    </section>

    <button
      className={`chat-launcher${!away && collapsed ? " show" : ""}`}
      onClick={onToggleCollapse}
      aria-label="Open assistant"
    >
      <IconChat />
    </button>
    </>
  );
}

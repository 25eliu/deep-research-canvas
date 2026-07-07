"use client";
import { useState } from "react";
import type { Session } from "@/lib/sessions";
import { IconSidebar, IconPlus, IconTrash, IconX } from "./icons";

function relTime(ts: number): string {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Sidebar({
  sessions, activeId, collapsed, onToggle, onNew, onSelect, onDelete,
}: {
  sessions: Session[];
  activeId: string;
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // Two-step delete: the trash button arms an inline confirm so a stored canvas is
  // never wiped from memory by a single stray click.
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <aside className={`sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-head">
        <button className="icon-btn" onClick={onToggle} aria-label="Toggle sidebar">
          <IconSidebar />
        </button>
        <div className="brand">Canvas<span className="dot-mark"> ·</span></div>
      </div>

      <button className="new-chat" onClick={onNew}>
        <IconPlus />
        <span className="lbl">New canvas</span>
      </button>

      <div className="rail-label">History</div>
      <div className="session-list">
        {sessions.map((s) => {
          const confirming = confirmId === s.id;
          return (
            <div
              key={s.id}
              className={`session${s.id === activeId ? " active" : ""}${confirming ? " confirming" : ""}`}
              onClick={() => { setConfirmId(null); onSelect(s.id); }}
              title={s.title}
            >
              <div className="session-glyph">{(s.title[0] || "C").toUpperCase()}</div>
              <div className="session-title">{s.title}</div>
              <div className="session-meta">
                {s.state.nodes.length} node{s.state.nodes.length === 1 ? "" : "s"} · {relTime(s.createdAt)}
              </div>

              {confirming ? (
                <div className="session-confirm" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="confirm-del"
                    onClick={(e) => { e.stopPropagation(); onDelete(s.id); setConfirmId(null); }}
                  >
                    Delete
                  </button>
                  <button
                    className="confirm-cancel"
                    aria-label="Cancel"
                    onClick={(e) => { e.stopPropagation(); setConfirmId(null); }}
                  >
                    <IconX />
                  </button>
                </div>
              ) : (
                <button
                  className="session-del"
                  aria-label={`Delete canvas "${s.title}"`}
                  title="Delete canvas"
                  onClick={(e) => { e.stopPropagation(); setConfirmId(s.id); }}
                >
                  <IconTrash />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

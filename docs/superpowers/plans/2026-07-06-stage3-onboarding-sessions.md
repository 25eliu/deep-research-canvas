# Stage 3 — Onboarding & Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all UI state into a persisted zustand store with named sessions (sidebar: list/new/rename/delete/switch), add the onboarding layer (empty state with example chips, dismissible provider explainer, ⌘K command palette), and make turns feel alive (sonner error toasts, skeleton node placeholders, streamed narrated loading, collapsible Trace panel).

**Architecture:** `lib/store/canvasStore.ts` (zustand) owns `sessions[]` + `activeSessionId` + ephemeral UI state; `applyOps` stays the canonical pure reducer (store action `applyToActive` wraps it and owns the criteria→recompute rule). Persistence sits behind a `SessionRepository` interface (`lib/store/persistence.ts`) with a `LocalStorageRepository` default bridged into zustand's `persist` middleware — a DB repository can drop in later. The NDJSON stream reader is extracted to `lib/client/streamTurn.ts` so Stage 4's comparison mode can reuse it.

**Tech Stack:** `zustand` v4 (+ `persist` middleware), `sonner`, existing Stage 1/2 stack.

**Prerequisite:** Stages 1 and 2 complete: `FlowCanvas`, `CanvasActionsContext`, `tidyLayout`, NDJSON `/api/agent` protocol (`{type:"trace"|"error"|"result"}` lines), `TurnTrace` in `lib/agents/shared/types.ts`.

## Global Constraints

- **Scene-graph is canonical**; the store's `applyToActive` is the ONLY place ops touch a board (it calls the pure `applyOps`).
- **Full per-session isolation:** each session = `{ id, name, board, chatLog, sideLog, provider, createdAt, trace }`. Ops, chat, provider, and trace never leak across sessions.
- **Persistence behind an interface** (`SessionRepository`); default localStorage. Never persist ephemeral state (loading, selection).
- **Immutability:** every store update builds new objects — no in-place mutation.
- **Errors** surface as a toast + honest UI state, never a crash; keys stay server-side.
- **Living docs:** record non-obvious findings in root `CLAUDE.md`; update `README.md` when the stage lands.

---

## File Structure

**Create:**
- `lib/store/persistence.ts` — `SessionRepository` + `LocalStorageRepository` + `MemoryRepository` + `repositoryStorage` bridge.
- `lib/store/persistence.test.ts` — repository round-trip test.
- `lib/store/canvasStore.ts` — zustand store: sessions, actions, persist.
- `lib/store/canvasStore.test.ts` — session CRUD + board-isolation tests.
- `lib/client/streamTurn.ts` — shared NDJSON stream reader.
- `components/Sidebar.tsx` — sessions sidebar.
- `components/EmptyState.tsx` — centered prompt + example chips.
- `components/CommandPalette.tsx` — ⌘K palette.
- `components/TracePanel.tsx` — collapsible per-turn trace.
- `components/SkeletonNodes.tsx` — pulsing placeholders during a turn.

**Modify:**
- `app/page.tsx` — rebuild on the store; add sidebar/empty state/palette/trace/skeletons/explainer.
- `app/layout.tsx` — mount sonner `<Toaster>`.
- `app/globals.css` — sidebar/empty/palette/trace/skeleton classes.
- `package.json` — deps.
- `CLAUDE.md`, `README.md`.

---

## Task 1: Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm install zustand@^4.5 sonner@^1
```

- [ ] **Step 2: Verify + commit**

Run: `npm run build` → Expected: green.

```bash
git add package.json package-lock.json && git commit -m "chore: add zustand, sonner" || true
```

---

## Task 2: Persistence seam (`lib/store/persistence.ts`)

**Files:**
- Create: `lib/store/persistence.ts`, `lib/store/persistence.test.ts`

**Interfaces:**
- Produces:
  - `SessionRepository = { load(key): string | null; save(key, value): void; remove(key): void; list(): string[] }`.
  - `LocalStorageRepository` (default, SSR-safe), `MemoryRepository` (tests / fallback).
  - `repositoryStorage(repo): StateStorage` — bridge for zustand `persist`.

- [ ] **Step 1: Write the failing test (`lib/store/persistence.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { MemoryRepository, repositoryStorage } from "./persistence";

describe("persistence", () => {
  it("round-trips values through the repository bridge", () => {
    const repo = new MemoryRepository();
    const storage = repositoryStorage(repo);
    storage.setItem("k", JSON.stringify({ a: 1 }));
    expect(storage.getItem("k")).toBe(JSON.stringify({ a: 1 }));
    expect(repo.list()).toEqual(["k"]);
    storage.removeItem("k");
    expect(storage.getItem("k")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/store/persistence.test.ts` → Expected: FAIL, "Cannot find module './persistence'".

- [ ] **Step 3: Write `lib/store/persistence.ts`**

```ts
// Persistence seam: the store only knows SessionRepository. Swap
// LocalStorageRepository for a DB-backed implementation without touching the store.
import type { StateStorage } from "zustand/middleware";

export interface SessionRepository {
  load(key: string): string | null;
  save(key: string, value: string): void;
  remove(key: string): void;
  list(): string[];
}

export class LocalStorageRepository implements SessionRepository {
  load(key: string): string | null {
    if (typeof window === "undefined") return null;
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  save(key: string, value: string): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(key, value); } catch { /* quota exceeded — skip write */ }
  }
  remove(key: string): void {
    if (typeof window === "undefined") return;
    try { window.localStorage.removeItem(key); } catch { /* noop */ }
  }
  list(): string[] {
    if (typeof window === "undefined") return [];
    try { return Object.keys(window.localStorage); } catch { return []; }
  }
}

export class MemoryRepository implements SessionRepository {
  private map = new Map<string, string>();
  load(key: string): string | null { return this.map.get(key) ?? null; }
  save(key: string, value: string): void { this.map.set(key, value); }
  remove(key: string): void { this.map.delete(key); }
  list(): string[] { return Array.from(this.map.keys()); }
}

export function repositoryStorage(repo: SessionRepository): StateStorage {
  return {
    getItem: (name) => repo.load(name),
    setItem: (name, value) => repo.save(name, value),
    removeItem: (name) => repo.remove(name),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/store/persistence.test.ts` → Expected: 1 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/store/persistence.ts lib/store/persistence.test.ts && git commit -m "feat: session repository persistence seam" || true
```

---

## Task 3: The store (`lib/store/canvasStore.ts`)

**Files:**
- Create: `lib/store/canvasStore.ts`, `lib/store/canvasStore.test.ts`

**Interfaces:**
- Produces:
  - `ChatMsg = { role: "user" | "agent"; text: string }`.
  - `Session = { id; name; board: CanvasState; chatLog: ChatMsg[]; sideLog: ChatMsg[]; provider: ProviderId; createdAt: number; trace: TurnTrace | null }`.
  - `useCanvasStore` with actions: `newSession(name?)`, `renameSession(id, name)`, `removeSession(id)`, `setActive(id)`, `setProvider(p)`, `applyToActive(ops)`, `appendLog(surface, msg)`, `setTrace(trace)`, `setSelection(ids)`, `setLoading(loading, stage?)`.
  - `selectActive(s: CanvasStore): Session` selector.
- Behavior: `applyToActive` auto-appends `recompute_consensus` when an op touches `criteria` (moves the rule out of Stage 2's page wrapper — the store is the single place). Only `sessions` + `activeSessionId` persist.

- [ ] **Step 1: Write the failing test (`lib/store/canvasStore.test.ts`)**

```ts
import { describe, expect, it } from "vitest";
import { selectActive, useCanvasStore } from "./canvasStore";

describe("canvasStore", () => {
  it("creates, renames, and switches sessions", () => {
    useCanvasStore.getState().newSession("Second");
    const s = useCanvasStore.getState();
    expect(s.sessions.length).toBe(2);
    expect(selectActive(s).name).toBe("Second");
    useCanvasStore.getState().renameSession(s.activeSessionId, "Renamed");
    expect(selectActive(useCanvasStore.getState()).name).toBe("Renamed");
  });

  it("applies ops to the active board only", () => {
    useCanvasStore.getState().applyToActive([
      { op: "add_node", node: { id: "n1", type: "text", title: "note", grounding: "model", confidence: 1 } },
    ]);
    const s = useCanvasStore.getState();
    expect(selectActive(s).board.nodes.map((n) => n.id)).toEqual(["n1"]);
    const other = s.sessions.find((x) => x.id !== s.activeSessionId)!;
    expect(other.board.nodes).toHaveLength(0);
  });

  it("removing the active session falls back to the first remaining one", () => {
    const before = useCanvasStore.getState();
    useCanvasStore.getState().removeSession(before.activeSessionId);
    const s = useCanvasStore.getState();
    expect(s.sessions.length).toBe(1);
    expect(s.activeSessionId).toBe(s.sessions[0].id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/store/canvasStore.test.ts` → Expected: FAIL, "Cannot find module './canvasStore'".

- [ ] **Step 3: Write `lib/store/canvasStore.ts`**

```ts
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { CanvasOp, CanvasState, ProviderId } from "../schema";
import { applyOps } from "../schema";
import type { TurnTrace } from "../agents/shared/types";
import { LocalStorageRepository, repositoryStorage } from "./persistence";

export interface ChatMsg { role: "user" | "agent"; text: string; }

export interface Session {
  id: string;
  name: string;
  board: CanvasState;
  chatLog: ChatMsg[];
  sideLog: ChatMsg[];
  provider: ProviderId;
  createdAt: number;
  trace: TurnTrace | null;
}

function makeSession(name: string): Session {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Math.random().toString(36).slice(2)}`;
  return {
    id, name, board: { nodes: [], edges: [] },
    chatLog: [], sideLog: [], provider: "tako", createdAt: Date.now(), trace: null,
  };
}

export interface CanvasStore {
  sessions: Session[];
  activeSessionId: string;
  selection: string[];
  loading: boolean;
  loadingStage: string;

  newSession: (name?: string) => void;
  renameSession: (id: string, name: string) => void;
  removeSession: (id: string) => void;
  setActive: (id: string) => void;
  setProvider: (p: ProviderId) => void;
  applyToActive: (ops: CanvasOp[]) => void;
  appendLog: (surface: "main" | "side_chat", msg: ChatMsg) => void;
  setTrace: (trace: TurnTrace | null) => void;
  setSelection: (ids: string[]) => void;
  setLoading: (loading: boolean, stage?: string) => void;
}

type SessionsSlice = Pick<CanvasStore, "sessions" | "activeSessionId">;

const patchActive = (s: SessionsSlice, patch: (sess: Session) => Session) => ({
  sessions: s.sessions.map((x) => (x.id === s.activeSessionId ? patch(x) : x)),
});

const first = makeSession("Board 1");

export const useCanvasStore = create<CanvasStore>()(
  persist(
    (set) => ({
      sessions: [first],
      activeSessionId: first.id,
      selection: [],
      loading: false,
      loadingStage: "",

      newSession: (name) => set((s) => {
        const sess = makeSession(name ?? `Board ${s.sessions.length + 1}`);
        return { sessions: [...s.sessions, sess], activeSessionId: sess.id, selection: [] };
      }),

      renameSession: (id, name) => set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, name } : x)),
      })),

      removeSession: (id) => set((s) => {
        const rest = s.sessions.filter((x) => x.id !== id);
        const sessions = rest.length ? rest : [makeSession("Board 1")];
        const activeSessionId = s.activeSessionId === id ? sessions[0].id : s.activeSessionId;
        return { sessions, activeSessionId, selection: [] };
      }),

      setActive: (id) => set({ activeSessionId: id, selection: [] }),

      setProvider: (p) => set((s) => patchActive(s, (x) => ({ ...x, provider: p }))),

      applyToActive: (ops) => set((s) => patchActive(s, (x) => {
        let all = ops;
        const touchesCriteria = ops.some(
          (o) => (o.op === "update_node" && o.patch.criteria) ||
            ((o.op === "add_node" || o.op === "upsert_node") && o.node.criteria),
        );
        if (touchesCriteria) {
          const cons = x.board.nodes.find((n) => n.type === "consensus");
          if (cons) all = [...ops, { op: "recompute_consensus", target: cons.id }];
        }
        return { ...x, board: applyOps(x.board, all) };
      })),

      appendLog: (surface, msg) => set((s) => patchActive(s, (x) =>
        surface === "main"
          ? { ...x, chatLog: [...x.chatLog, msg] }
          : { ...x, sideLog: [...x.sideLog, msg] })),

      setTrace: (trace) => set((s) => patchActive(s, (x) => ({ ...x, trace }))),

      setSelection: (ids) => set({ selection: ids }),

      setLoading: (loading, stage = "") => set({ loading, loadingStage: stage }),
    }),
    {
      name: "canvas-tako-v1",
      storage: createJSONStorage(() => repositoryStorage(new LocalStorageRepository())),
      partialize: (s) => ({ sessions: s.sessions, activeSessionId: s.activeSessionId }),
    },
  ),
);

export const selectActive = (s: CanvasStore): Session =>
  s.sessions.find((x) => x.id === s.activeSessionId) ?? s.sessions[0];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/store/canvasStore.test.ts` → Expected: 3 passing.
(If TypeScript complains about `partialize`'s return type on the installed zustand minor, type the persist options as `PersistOptions<CanvasStore, { sessions: Session[]; activeSessionId: string }>` — do not widen state types.)

- [ ] **Step 5: Commit**

```bash
git add lib/store/canvasStore.ts lib/store/canvasStore.test.ts && git commit -m "feat: zustand session store with persisted boards" || true
```

---

## Task 4: Shared stream reader (`lib/client/streamTurn.ts`)

**Files:**
- Create: `lib/client/streamTurn.ts`

**Interfaces:**
- Produces:
  - `TurnResult = { canvasOps: CanvasOp[]; narration: string; sideReply: string | null; trace: TurnTrace }`.
  - `streamTurn(body: AgentRequest, ev: { onStage?(stage: string): void; onError?(error: string): void; onResult?(result: TurnResult): void }): Promise<void>` — POSTs to `/api/agent`, parses NDJSON lines. Rejects on network failure; protocol-level errors go to `onError`.
- Consumed by: `app/page.tsx` (this stage) and Stage 4's `ComparisonView`.

- [ ] **Step 1: Write `lib/client/streamTurn.ts`**

```ts
// Client-side reader for the /api/agent NDJSON protocol:
// zero+ {"type":"trace",stage} lines, then one {"type":"result",...} (or {"type":"error"}).
import type { AgentRequest, CanvasOp } from "../schema";
import type { TurnTrace } from "../agents/shared/types";

export interface TurnResult {
  canvasOps: CanvasOp[];
  narration: string;
  sideReply: string | null;
  trace: TurnTrace;
}

export interface TurnEvents {
  onStage?: (stage: string) => void;
  onError?: (error: string) => void;
  onResult?: (result: TurnResult) => void;
}

export async function streamTurn(body: AgentRequest, ev: TurnEvents): Promise<void> {
  const res = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.body) throw new Error("no response stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    let evt: { type: string; stage?: string; error?: string } & Partial<TurnResult>;
    try { evt = JSON.parse(line); } catch { ev.onError?.(`malformed stream line: ${line.slice(0, 120)}`); return; }
    if (evt.type === "trace" && evt.stage) ev.onStage?.(evt.stage);
    else if (evt.type === "error") ev.onError?.(evt.error ?? "unknown error");
    else if (evt.type === "result") ev.onResult?.(evt as unknown as TurnResult);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    lines.forEach(handleLine);
  }
  if (buf.trim()) handleLine(buf);
}
```

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add lib/client/streamTurn.ts && git commit -m "feat: shared NDJSON stream reader" || true
```

---

## Task 5: Sidebar, empty state, skeletons + CSS

**Files:**
- Create: `components/Sidebar.tsx`, `components/EmptyState.tsx`, `components/SkeletonNodes.tsx`
- Modify: `app/globals.css`

**Interfaces:**
- Consumes: `useCanvasStore`, `selectActive` (Task 3).
- Produces: `Sidebar()` (no props — reads the store), `EmptyState({ onRun: (q: string) => void })`, `SkeletonNodes({ stage: string })`.

- [ ] **Step 1: Write `components/Sidebar.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useCanvasStore } from "@/lib/store/canvasStore";

export default function Sidebar() {
  const sessions = useCanvasStore((s) => s.sessions);
  const activeId = useCanvasStore((s) => s.activeSessionId);
  const { newSession, renameSession, removeSession, setActive } = useCanvasStore.getState();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = (id: string, fallback: string) => {
    renameSession(id, draft.trim() || fallback);
    setEditing(null);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span>Boards</span>
        <button onClick={() => newSession()} title="New board">＋</button>
      </div>
      <div className="sidebar-list">
        {sessions.map((s) => (
          <div key={s.id} className={`sidebar-item${s.id === activeId ? " active" : ""}`}
            onClick={() => setActive(s.id)}>
            {editing === s.id ? (
              <input autoFocus value={draft} className="sidebar-rename"
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={() => commitRename(s.id, s.name)}
                onKeyDown={(e) => e.key === "Enter" && commitRename(s.id, s.name)} />
            ) : (
              <span className="sidebar-name" title="Double-click to rename"
                onDoubleClick={(e) => { e.stopPropagation(); setEditing(s.id); setDraft(s.name); }}>
                {s.name}
              </span>
            )}
            <button className="sidebar-del" title="Delete board"
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm(`Delete "${s.name}"? This cannot be undone.`)) removeSession(s.id);
              }}>✕</button>
          </div>
        ))}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Write `components/EmptyState.tsx`**

```tsx
"use client";

const EXAMPLES = [
  "Research the best 5 semiconductor companies to invest in",
  "Compare inflation and unemployment across the G7",
  "Rank the top NBA teams by offensive rating this season",
  "Which cloud provider is growing fastest?",
];

export default function EmptyState({ onRun }: { onRun: (q: string) => void }) {
  return (
    <div className="empty-state">
      <h1>Ask a research question</h1>
      <p>The canvas turns it into a board of connected, cited data cards converging on a consensus leaderboard.</p>
      <div className="empty-chips">
        {EXAMPLES.map((q) => (
          <button key={q} onClick={() => onRun(q)}>{q}</button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write `components/SkeletonNodes.tsx`**

```tsx
"use client";

export default function SkeletonNodes({ stage }: { stage: string }) {
  return (
    <div className="skeletons">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-card" style={{ animationDelay: `${i * 0.15}s` }} />
      ))}
      <div className="skeleton-stage">{stage || "thinking…"}</div>
    </div>
  );
}
```

- [ ] **Step 4: Append Stage 3 classes to `app/globals.css`**

```css
/* --- sidebar --- */
.sidebar { border-right: 1px solid var(--border); background: var(--panel-2); display: flex; flex-direction: column; min-width: 0; }
.sidebar-head { display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 500; }
.sidebar-head button { border: 1px solid var(--border); background: var(--panel); border-radius: 6px; width: 22px; height: 22px; font-size: 13px; line-height: 1; }
.sidebar-list { flex: 1; overflow-y: auto; padding: 6px; }
.sidebar-item { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-radius: 8px; font-size: 12px; cursor: pointer; color: var(--muted); }
.sidebar-item.active { background: var(--panel); color: var(--text); border: 1px solid var(--border); }
.sidebar-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sidebar-rename { flex: 1; min-width: 0; background: var(--bg); border: 1px solid var(--accent); border-radius: 4px; color: var(--text); font-size: 12px; padding: 2px 4px; }
.sidebar-del { visibility: hidden; border: 0; background: none; color: var(--muted); font-size: 11px; }
.sidebar-item:hover .sidebar-del { visibility: visible; }

/* --- empty state --- */
.empty-state { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; z-index: 5; pointer-events: none; }
.empty-state h1 { font-size: 22px; font-weight: 600; margin: 0; }
.empty-state p { font-size: 13px; color: var(--muted); margin: 0; max-width: 420px; text-align: center; }
.empty-chips { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-width: 560px; margin-top: 8px; pointer-events: auto; }
.empty-chips button { padding: 8px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); color: var(--text); font-size: 12px; }
.empty-chips button:hover { border-color: var(--accent); }

/* --- explainer --- */
.explainer { position: absolute; top: 52px; left: 12px; z-index: 10; display: flex; gap: 8px; align-items: center; padding: 6px 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; font-size: 11px; color: var(--muted); max-width: 520px; }
.explainer button { border: 0; background: none; color: var(--muted); font-size: 11px; }

/* --- command palette --- */
.palette-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.45); z-index: 100; display: flex; justify-content: center; padding-top: 15vh; }
.palette { width: 480px; max-height: 320px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.palette input { padding: 12px 14px; background: var(--panel-2); border: 0; border-bottom: 1px solid var(--border); color: var(--text); outline: none; }
.palette-list { overflow-y: auto; padding: 6px; }
.palette-item { padding: 8px 10px; border-radius: 8px; font-size: 13px; cursor: pointer; }
.palette-item.active { background: var(--panel-2); }
.palette-empty { padding: 12px; font-size: 12px; color: var(--muted); }

/* --- trace panel --- */
.trace-panel { position: absolute; right: 12px; bottom: 96px; z-index: 10; width: 320px; max-height: 45vh; display: flex; flex-direction: column; }
.trace-toggle { text-align: left; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--panel); color: var(--muted); font-size: 12px; }
.trace-body { overflow-y: auto; margin-top: 4px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
.trace-body h4 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.trace-body h4:first-child { margin-top: 0; }
.trace-line { font-size: 11px; padding: 1px 0; }
.trace-line.muted { color: var(--muted); }
.trace-line a { color: var(--tako); }

/* --- skeletons --- */
.skeletons { position: absolute; top: 90px; left: 60px; z-index: 6; display: flex; flex-direction: column; gap: 14px; pointer-events: none; }
.skeleton-card { width: 280px; height: 120px; border-radius: 12px; border: 1px solid var(--border); background: linear-gradient(100deg, var(--panel) 40%, var(--panel-2) 50%, var(--panel) 60%); background-size: 200% 100%; animation: shimmer 1.4s infinite linear; }
.skeleton-stage { font-size: 12px; color: var(--muted); }
@keyframes shimmer { to { background-position: -200% 0; } }
```

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/Sidebar.tsx components/EmptyState.tsx components/SkeletonNodes.tsx app/globals.css
git commit -m "feat: sidebar, empty state, skeleton placeholders" || true
```

---

## Task 6: Command palette + Trace panel

**Files:**
- Create: `components/CommandPalette.tsx`, `components/TracePanel.tsx`

**Interfaces:**
- Produces:
  - `PaletteCommand = { id: string; label: string; run: () => void }`; `CommandPalette({ commands: PaletteCommand[] })` — self-manages open state on ⌘K/Ctrl-K, Escape closes, arrows + Enter run.
  - `TracePanel({ trace: TurnTrace | null })` — collapsed one-liner (action · provider · ms), expands to graph lookups, queries, cards (linked), notes, ops count.

- [ ] **Step 1: Write `components/CommandPalette.tsx`**

```tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  label: string;
  run: () => void;
}

export default function CommandPalette({ commands }: { commands: PaletteCommand[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v); setQ(""); setCursor(0);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const filtered = useMemo(
    () => commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase())),
    [commands, q],
  );

  if (!open) return null;

  const runAt = (i: number) => { filtered[i]?.run(); setOpen(false); };

  return (
    <div className="palette-backdrop" onClick={() => setOpen(false)}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} value={q} placeholder="Type a command…"
          onChange={(e) => { setQ(e.target.value); setCursor(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setCursor((c) => Math.min(c + 1, filtered.length - 1));
            else if (e.key === "ArrowUp") setCursor((c) => Math.max(c - 1, 0));
            else if (e.key === "Enter") runAt(cursor);
          }} />
        <div className="palette-list">
          {filtered.map((c, i) => (
            <div key={c.id} className={`palette-item${i === cursor ? " active" : ""}`}
              onMouseEnter={() => setCursor(i)} onClick={() => runAt(i)}>
              {c.label}
            </div>
          ))}
          {filtered.length === 0 && <div className="palette-empty">No matching command</div>}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `components/TracePanel.tsx`**

```tsx
"use client";
import { useState } from "react";
import type { TurnTrace } from "@/lib/agents/shared/types";

export default function TracePanel({ trace }: { trace: TurnTrace | null }) {
  const [open, setOpen] = useState(false);
  if (!trace) return null;

  return (
    <div className="trace-panel">
      <button className="trace-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} Trace · {trace.action} · {trace.provider} · {trace.ms}ms
      </button>
      {open && (
        <div className="trace-body">
          {trace.graph && trace.graph.resolved.length > 0 && (
            <section>
              <h4>Graph resolution</h4>
              {trace.graph.resolved.map((r, i) => (
                <div key={i} className="trace-line">“{r.query}” → {r.node}</div>
              ))}
              {trace.graph.related.map((r, i) => (
                <div key={i} className="trace-line muted">{r.node}: {r.items.join(", ")}</div>
              ))}
            </section>
          )}
          {trace.queries.length > 0 && (
            <section>
              <h4>{trace.answerUsed ? "Tako Answer query" : "Search queries"}</h4>
              {trace.queries.map((q, i) => <div key={i} className="trace-line">{q}</div>)}
            </section>
          )}
          {trace.cards.length > 0 && (
            <section>
              <h4>Cards ({trace.cards.length})</h4>
              {trace.cards.map((c) => (
                <div key={c.id} className="trace-line">
                  {c.url ? <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a> : c.title}
                </div>
              ))}
            </section>
          )}
          {trace.notes.length > 0 && (
            <section>
              <h4>Notes</h4>
              {trace.notes.map((n, i) => <div key={i} className="trace-line muted">{n}</div>)}
            </section>
          )}
          <div className="trace-line muted">{trace.opsApplied} ops applied</div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add components/CommandPalette.tsx components/TracePanel.tsx && git commit -m "feat: command palette + collapsible trace panel" || true
```

---

## Task 7: Rebuild `app/page.tsx` on the store + Toaster

**Files:**
- Modify: `app/page.tsx`, `app/layout.tsx`

**Interfaces:**
- Consumes: everything above; `FlowCanvas`/`CanvasActionsContext` (Stage 2); `tidyLayout` (Stage 2); `streamTurn` (Task 4).
- Produces: the assembled app — grid `220px 1fr 340px`; store-driven; hydration-gated (`mounted` flag) so persisted sessions don't mismatch SSR HTML.

- [ ] **Step 1: Add the Toaster to `app/layout.tsx`** (replace file contents)

```tsx
import type { ReactNode } from "react";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata = { title: "Canvas · Tako", description: "Spatial research canvas" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster theme="dark" position="top-center" richColors />
      </body>
    </html>
  );
}
```

- [ ] **Step 2: Replace the entire contents of `app/page.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { CanvasNode, CanvasOp, ProviderId } from "@/lib/schema";
import { tidyLayout } from "@/lib/layout";
import { streamTurn } from "@/lib/client/streamTurn";
import { selectActive, useCanvasStore } from "@/lib/store/canvasStore";
import FlowCanvas from "@/components/canvas/FlowCanvas";
import { CanvasActionsContext, type CanvasActions } from "@/components/canvas/CanvasActions";
import Sidebar from "@/components/Sidebar";
import EmptyState from "@/components/EmptyState";
import SkeletonNodes from "@/components/SkeletonNodes";
import CommandPalette, { type PaletteCommand } from "@/components/CommandPalette";
import TracePanel from "@/components/TracePanel";

const PROVIDERS: { id: ProviderId; label: string }[] = [
  { id: "tako", label: "LLM + Tako" },
  { id: "gpt", label: "GPT" },
  { id: "claude", label: "Claude" },
];

const EXPLAINER_KEY = "ct-explainer-dismissed";

export default function Page() {
  const active = useCanvasStore(selectActive);
  const selection = useCanvasStore((s) => s.selection);
  const loading = useCanvasStore((s) => s.loading);
  const loadingStage = useCanvasStore((s) => s.loadingStage);
  const {
    applyToActive, appendLog, setTrace, setSelection, setLoading, setProvider, newSession,
  } = useCanvasStore.getState();

  const [input, setInput] = useState("");
  const [sideInput, setSideInput] = useState("");
  const [highlightEntity, setHighlightEntity] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [explainerDismissed, setExplainerDismissed] = useState(true);
  const sideInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMounted(true);
    setExplainerDismissed(window.localStorage.getItem(EXPLAINER_KEY) === "1");
  }, []);

  const nodeById = useMemo(
    () => Object.fromEntries(active.board.nodes.map((n) => [n.id, n])),
    [active.board.nodes],
  );

  const askAbout = useCallback((node: CanvasNode) => {
    setSelection([node.id]);
    sideInputRef.current?.focus();
  }, [setSelection]);

  const dispatchOps = useCallback((ops: CanvasOp[]) => applyToActive(ops), [applyToActive]);

  const actions: CanvasActions = useMemo(
    () => ({ dispatchOps, askAbout, setHighlightEntity }),
    [dispatchOps, askAbout],
  );

  const onSelectionIds = useCallback((ids: string[]) => {
    const prev = useCanvasStore.getState().selection;
    if (prev.length === ids.length && prev.every((x, i) => x === ids[i])) return;
    setSelection(ids);
  }, [setSelection]);

  const send = useCallback(async (surface: "main" | "side_chat", text: string) => {
    const st = useCanvasStore.getState();
    const sess = selectActive(st);
    if (!text.trim() || st.loading) return;
    setLoading(true, "thinking");
    appendLog(surface, { role: "user", text });
    try {
      await streamTurn(
        {
          canvasId: sess.id, message: text, surface, canvasState: sess.board,
          selection: { nodeIds: st.selection, nodes: st.selection.map((id) => nodeById[id]).filter(Boolean) },
          providerId: sess.provider, takoAnswerEnabled: true,
        },
        {
          onStage: (stage) => setLoading(true, stage),
          onError: (err) => toast.error(err),
          onResult: (r) => {
            if (r.canvasOps?.length) applyToActive(r.canvasOps);
            if (surface === "main" && r.narration) appendLog("main", { role: "agent", text: r.narration });
            if (r.sideReply) appendLog("side_chat", { role: "agent", text: r.sideReply });
            setTrace(r.trace);
          },
        },
      );
    } catch (e: any) {
      toast.error(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [appendLog, applyToActive, nodeById, setLoading, setTrace]);

  const commands: PaletteCommand[] = useMemo(() => [
    ...PROVIDERS.map((p) => ({
      id: `provider-${p.id}`, label: `Provider: ${p.label}`, run: () => setProvider(p.id),
    })),
    { id: "new-board", label: "New board", run: () => newSession() },
    {
      id: "tidy", label: "Tidy layout",
      run: () => applyToActive(tidyLayout(selectActive(useCanvasStore.getState()).board)),
    },
  ], [applyToActive, newSession, setProvider]);

  if (!mounted) return <div style={{ height: "100vh", background: "var(--bg)" }} />;

  const boardEmpty = active.board.nodes.length === 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "220px 1fr 340px", height: "100vh" }}>
      <Sidebar />

      {/* Canvas column */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 12, left: 12, zIndex: 10, display: "flex", gap: 8, alignItems: "center" }}>
          {PROVIDERS.map((p) => (
            <button key={p.id} onClick={() => setProvider(p.id)} style={{
              padding: "6px 10px", borderRadius: 8,
              border: `1px solid ${active.provider === p.id ? "var(--accent)" : "var(--border)"}`,
              background: active.provider === p.id ? "var(--accent)" : "var(--panel)",
              color: active.provider === p.id ? "#fff" : "var(--text)", fontSize: 12,
            }}>{p.label}</button>
          ))}
        </div>

        {!explainerDismissed && (
          <div className="explainer">
            <span>Providers change how the board is grounded: <b>LLM + Tako</b> cites live structured data; GPT/Claude answer from memory (amber).</span>
            <button onClick={() => { window.localStorage.setItem(EXPLAINER_KEY, "1"); setExplainerDismissed(true); }}>✕</button>
          </div>
        )}

        <CanvasActionsContext.Provider value={actions}>
          <FlowCanvas state={active.board} selection={selection} highlightEntity={highlightEntity}
            onSelectionIds={onSelectionIds} dispatchOps={dispatchOps} />
        </CanvasActionsContext.Provider>

        {boardEmpty && !loading && <EmptyState onRun={(q) => send("main", q)} />}
        {loading && boardEmpty && <SkeletonNodes stage={loadingStage} />}
        <TracePanel trace={active.trace} />

        {/* Main chat overlay */}
        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10, padding: 12, background: "linear-gradient(transparent, var(--bg) 40%)" }}>
          {loading && loadingStage && (
            <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 6 }}>⋯ {loadingStage}</div>
          )}
          <div style={{ maxHeight: 120, overflowY: "auto", marginBottom: 8 }}>
            {active.chatLog.slice(-4).map((m, i) => (
              <div key={i} style={{ fontSize: 12, color: m.role === "user" ? "var(--text)" : "var(--muted)", margin: "2px 0" }}>
                <b>{m.role === "user" ? "you" : "canvas"}:</b> {m.text}
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && (send("main", input), setInput(""))}
              placeholder="Ask the canvas…  (⌘K for commands)"
              style={{ flex: 1, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
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
          {selection.length
            ? selection.map((id) => nodeById[id]?.title || id).join(", ")
            : "Select nodes on the canvas (click, or Shift-drag) to ask about them."}
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
          {active.sideLog.map((m, i) => (
            <div key={i} style={{ fontSize: 13, margin: "6px 0", color: m.role === "user" ? "var(--text)" : "var(--muted)" }}>
              <b>{m.role === "user" ? "you" : "assistant"}:</b> {m.text}
            </div>
          ))}
        </div>
        <div style={{ padding: 12, display: "flex", gap: 8, borderTop: "1px solid var(--border)" }}>
          <input ref={sideInputRef} value={sideInput} onChange={(e) => setSideInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (send("side_chat", sideInput), setSideInput(""))}
            placeholder="Ask about the selection…"
            style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
          <button onClick={() => { send("side_chat", sideInput); setSideInput(""); }} disabled={loading || !selection.length}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)" }}>Ask</button>
        </div>
      </div>

      <CommandPalette commands={commands} />
    </div>
  );
}
```

(Note: the criteria→`recompute_consensus` rule moved into the store's `applyToActive` in Task 3, so the page's `dispatchOps` is now a thin alias — Stage 2's page-level rule is intentionally superseded.)

- [ ] **Step 3: Verify build + tests**

Run: `npx tsc --noEmit` → Expected: clean.
Run: `npm test` → Expected: all suites green.
Run: `npm run build` → Expected: green.

- [ ] **Step 4: Manual end-to-end check**

Run: `npm run dev`, open http://localhost:3000:
- Fresh load shows the empty state; clicking a chip runs the query; skeletons + streamed stage text appear while it runs.
- The Trace panel appears after the turn: action, provider, graph lookups, queries, linked cards, notes.
- Sidebar: ＋ creates a board; double-click renames; ✕ (with confirm) deletes; switching swaps board + both chat logs instantly.
- Reload the page → sessions, boards, and provider choices are restored; user-dragged positions survive.
- ⌘K opens the palette; "Provider: GPT", "New board", "Tidy layout" all work; Escape closes.
- Kill the dev server's network (or use a bogus TAKO_API_KEY) → a toast shows the error; UI does not crash.
- The provider explainer shows once; after ✕ it stays dismissed across reloads.

- [ ] **Step 5: Update living docs**

Append to `CLAUDE.md`:

```markdown
## State & sessions (Stage 3)
- zustand store (`lib/store/canvasStore.ts`) owns sessions; `applyToActive` is the ONLY board mutator
  and auto-appends `recompute_consensus` when an op touches `criteria`.
- Persistence: zustand `persist` + `partialize` (sessions + activeSessionId only) over a
  `SessionRepository` seam — swap in a DB repository without touching the store.
- Hydration: the page gates rendering on a `mounted` flag; rendering persisted sessions during SSR
  causes React hydration mismatches.
- The NDJSON reader lives in `lib/client/streamTurn.ts` — reuse it for any new agent-calling surface.
```

Update `README.md`: sessions sidebar + localStorage persistence, empty state, ⌘K palette, trace panel, toasts/skeletons.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: session store, sidebar, onboarding, trace panel, palette" || true
```

---

## Self-Review

**Spec coverage (Stage 3 scope = spec §5 client half + §6 + §9):**
- zustand store: `sessions[]`, `activeSessionId`, `selection`, trace per session → Task 3. (spec's `view` is owned by React Flow's viewport, `comparison` arrives Stage 4 — both intentional.) ✓
- `applyOps` as store action, still exported pure from `schema.ts` → Task 3 (`applyToActive` wraps it). ✓
- Session shape `{ id, name, board, chatLog, sideLog, provider, createdAt }` (+`trace`) → Task 3. ✓
- Persistence behind `SessionRepository`, default localStorage, DB drop-in later → Task 2. ✓
- Sidebar: list, new, rename, delete, switch → Task 5. ✓
- User-moved positions persist across turns AND reloads → positions live in the persisted board; agents don't touch `position` (Stage 1 invariant). ✓
- Empty state with clickable example chips (semiconductor / macro / sports) → Task 5. ✓
- Dismissible provider explainer → Task 7. ✓
- ⌘K palette: switch provider, new canvas, tidy layout ("run comparison" added in Stage 4 when it exists). ✓
- sonner toasts for errors; skeleton placeholders while a turn runs → Tasks 5, 7. ✓
- Streamed narrated loading + collapsible Trace panel (routed action, provider, graph lookups, queries, cards linked, ops applied) → Tasks 4, 6, 7. ✓

**Placeholder scan:** all steps carry complete code; no TBDs. ✓

**Type consistency:** `Session`/`ChatMsg`/`selectActive` defined once (Task 3), consumed in Tasks 5, 7; `streamTurn(body, { onStage, onError, onResult })` signature matches Task 7's call; `PaletteCommand` defined in Task 6, consumed in Task 7; `TurnTrace` reused from Stage 1's `lib/agents/shared/types.ts`. ✓

**Risk notes for the executor:**
- zustand `persist` typing around `partialize` varies by minor version — see the note in Task 3 Step 4; never widen the state type to `any`.
- `crypto.randomUUID` needs Node ≥ 19 in vitest / modern browsers — the fallback branch in `makeSession` covers older environments.
- If the store rehydrates AFTER first client render (visible as an empty board flash), add `useCanvasStore.persist.rehydrate()` in the `useEffect` and keep the `mounted` gate.

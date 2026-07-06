# Stage 5 — Design Polish & Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Final visual pass: Inter via `next/font`, a refined dark token set with semantic accents, framer-motion node entrances and leaderboard reorder animation, CSS edge draw-in — all gated on `prefers-reduced-motion` — and the closing docs/verification sweep against the spec's full definition of done.

**Architecture:** Motion is confined to two leaf components (`NodeShell` gains a motion wrapper, `ConsensusNode` gains layout-animated rows) plus pure CSS for edge draw-in — no changes to state, agents, or the canvas substrate. Tokens change only in `globals.css`; the font only in `layout.tsx`.

**Tech Stack:** `framer-motion` v11, `next/font` (built-in), existing stack.

**Prerequisite:** Stages 1–4 complete.

## Global Constraints

- **Respect `prefers-reduced-motion`** everywhere: `useReducedMotion()` for framer-motion, a media query for CSS animations. Motion is quick and purposeful (≤ 300ms, ease-out).
- **One neutral palette + semantic accents** (tako green, model amber, edge-kind colors). Keep the CSS-var token names — every component already consumes them, so refinement means changing VALUES, not names.
- **No UI kit.** `next/font` Inter, two weights (400/600).
- **No behavior changes** — this stage must not alter ops, agents, layout math, or persistence.
- **Living docs:** final `README.md`/`CLAUDE.md`/`docs/agents-architecture.md` sweep; run the full spec verification checklist.

---

## File Structure

**Create:** none.

**Modify:**
- `package.json` — framer-motion.
- `app/layout.tsx` — Inter via `next/font`.
- `app/globals.css` — refined tokens, focus rings, scrollbars, edge draw-in keyframes, reduced-motion guards.
- `components/nodes/NodeShell.tsx` — motion entrance.
- `components/nodes/ConsensusNode.tsx` — layout-animated rows.
- `README.md`, `CLAUDE.md`.

---

## Task 1: framer-motion + Inter

**Files:**
- Modify: `package.json`, `app/layout.tsx`

- [ ] **Step 1: Install**

```bash
npm install framer-motion@^11
```

- [ ] **Step 2: Wire Inter in `app/layout.tsx`** (replace file contents)

```tsx
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-inter" });

export const metadata = { title: "Canvas · Tako", description: "Spatial research canvas" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {children}
        <Toaster theme="dark" position="top-center" richColors />
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Point the body font at the variable**

In `app/globals.css`, replace the `html, body { … }` rule's `font-family` line with:

```css
  font-family: var(--font-inter), ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
```

- [ ] **Step 4: Verify + commit**

Run: `npm run build` → Expected: green. `npm run dev` → text renders in Inter (check any heading in devtools computed styles).

```bash
git add package.json package-lock.json app/layout.tsx app/globals.css
git commit -m "feat: inter via next/font, add framer-motion" || true
```

---

## Task 2: Refined tokens + focus/scrollbar/motion CSS

**Files:**
- Modify: `app/globals.css`

- [ ] **Step 1: Replace the `:root` token block** (values only; names unchanged, three additions)

```css
:root {
  --bg: #0b0d12;
  --panel: #12151d;
  --panel-2: #171b26;
  --border: #232837;
  --border-strong: #313848;
  --text: #e8eaf0;
  --muted: #98a0b0;
  --accent: #8b83e8;
  --tako: #22b183;
  --model: #d0891f;
  --supports: #7fb02e;
  --contradicts: #e0603a;
  --feeds: #6a6f7c;
  --radius: 12px;
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4), 0 4px 16px rgba(0, 0, 0, 0.25);
}
```

- [ ] **Step 2: Append the polish layer at the end of `globals.css`**

```css
/* --- stage 5 polish --- */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
::selection { background: rgba(139, 131, 232, 0.35); }
* { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
*::-webkit-scrollbar-track { background: transparent; }

.node-shell { box-shadow: var(--shadow-1); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.node-shell:hover { border-color: var(--border-strong); }
.node-shell.selected:hover { border-color: var(--accent); }

/* edge draw-in: dash sweep on newly mounted edges */
.canvas-edge { stroke-dasharray: 1000; stroke-dashoffset: 0; animation: edge-draw 0.5s ease-out; }
@keyframes edge-draw {
  from { stroke-dashoffset: 1000; opacity: 0; }
  to { stroke-dashoffset: 0; opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .canvas-edge { animation: none; }
  .skeleton-card { animation: none; }
  .node-shell { transition: none; }
}
```

- [ ] **Step 3: Verify visually + commit**

Run: `npm run dev` → darker refined palette, hairline borders, subtle card shadows, edges sweep in on a new board; with macOS "Reduce Motion" on (or devtools emulation), edges appear instantly.

```bash
git add app/globals.css && git commit -m "feat: refined dark tokens, focus rings, edge draw-in" || true
```

---

## Task 3: Node entrance + leaderboard reorder motion

**Files:**
- Modify: `components/nodes/NodeShell.tsx`, `components/nodes/ConsensusNode.tsx`

**Interfaces:**
- No signature changes — `NodeShell` props and `ConsensusNode` behavior are identical; only rendering gains motion.

- [ ] **Step 1: Add the motion entrance to `NodeShell.tsx`**

Add imports at the top:

```tsx
import { motion, useReducedMotion } from "framer-motion";
```

Inside the component, before `return`, add:

```tsx
  const reduceMotion = useReducedMotion();
```

Replace the root element — `<div className={...} style={{ width }}>` and its matching closing `</div>` — with:

```tsx
    <motion.div
      className={`node-shell${selected ? " selected" : ""}`}
      style={{ width }}
      initial={reduceMotion ? false : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
```

…keeping every child (handles, header, actions, body) exactly as-is, and closing with `</motion.div>`.

- [ ] **Step 2: Animate rank reorder in `ConsensusNode.tsx`**

Add imports:

```tsx
import { motion, useReducedMotion } from "framer-motion";
```

Inside the component add `const reduceMotion = useReducedMotion();`, then replace the row `<div key={r.entity} className="consensus-row" …>` / `</div>` with:

```tsx
        <motion.div key={r.entity} className="consensus-row"
          layout={!reduceMotion}
          transition={{ duration: 0.25, ease: "easeOut" }}
          onMouseEnter={() => setHighlightEntity(r.entity)}
          onMouseLeave={() => setHighlightEntity(null)}>
```

…keeping the rank/entity/score spans unchanged, closing with `</motion.div>`.

- [ ] **Step 3: Verify build + behavior**

Run: `npx tsc --noEmit` → Expected: clean. `npm run build` → green.
Run: `npm run dev`: new nodes fade/rise in on a fresh board; dragging a criteria slider makes leaderboard rows slide to their new ranks; with reduced motion emulated, everything snaps instantly.

- [ ] **Step 4: Commit**

```bash
git add components/nodes/NodeShell.tsx components/nodes/ConsensusNode.tsx
git commit -m "feat: node entrance + leaderboard reorder motion, reduced-motion aware" || true
```

---

## Task 4: Final docs sweep + full spec verification

**Files:**
- Modify: `README.md`, `CLAUDE.md`; check `docs/agents-architecture.md`

- [ ] **Step 1: Final `README.md` pass**

Ensure it now documents, in one coherent read: the 3-provider set (default `tako`), graph-first pipeline + Tako Answer follow-ups, deterministic consensus/relate/layout, React Flow canvas features, sessions + persistence, ⌘K palette, comparison mode + scoreboard, motion/reduced-motion, `TAKO_HOST=staging.tako.com` (with the trytako.com warning), all deps, `npm test`.

- [ ] **Step 2: Final `CLAUDE.md` pass**

Add any Stage 5 finding that cost real time (e.g. framer-motion + React Flow interplay: motion wrappers live INSIDE the RF node, never around it — RF owns node positioning; animating the outer element fights the transform). Confirm the Tako host/key-namespace/graph-shape notes from Stage 1 are still accurate.

- [ ] **Step 3: Confirm `docs/agents-architecture.md`** still matches the code (4 Mermaid diagrams; no `tako_agent`/`tako_visualize` anywhere).

- [ ] **Step 4: Run the spec's full definition-of-done checklist** (from `docs/superpowers/specs/2026-07-06-spatial-canvas-polish-design.md` §Verification)

- `npm run build` passes, no type errors (strict); `npm test` green.
- Empty state → semiconductor chip → coherent Tako board: entity columns of cited cards + criteria + consensus with fan-in edges; Trace panel shows graph resolution, composed queries, fetched cards.
- Switching to `gpt`/`claude` → visibly thinner, amber-flagged board, no Tako refs.
- Comparison mode → two boards + populated scoreboard for one query.
- Selecting nodes + side chat → selection-scoped answer.
- Editing criteria weights → deterministic re-rank.
- Pan/zoom/drag/tidy/minimap work; user-moved nodes keep positions across turns.
- Sessions persist and switch cleanly.
- Agent output Zod-validated via the AI SDK; structural edges deterministic; graphology validation active.
- `tako` agent: graph pipeline on NEW_BOARD against `staging.tako.com`; follow-ups via `/api/v1/answer`; graph errors degrade gracefully with a trace note.
- README + `docs/agents-architecture.md` updated.

Record any failure as a bug to fix BEFORE calling the project done — do not check items off without running them.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs: final polish-stage docs sweep + spec verification" || true
```

---

## Self-Review

**Spec coverage (Stage 5 scope = spec §11 + closing verification):**
- Refined dark tokens, one neutral palette + semantic accents → Task 2 (names preserved so nothing else changes). ✓
- `next/font` Inter, two weights → Task 1. ✓
- framer-motion node entrance/mutation + edge draw-in → Tasks 2 (CSS edges), 3 (nodes, leaderboard). ✓
- `prefers-reduced-motion` respected → `useReducedMotion` + media query, Tasks 2–3. ✓
- Generous spacing / hairline borders / subtle depth → Task 2 (`--border`, `--shadow-1`, hover states). ✓
- Definition-of-done checklist executed → Task 4. ✓

**Placeholder scan:** all steps carry exact code or exact checklists. ✓

**Type consistency:** no interface changes anywhere in this stage — verified by design (Tasks 1–3 alter only rendering/CSS). ✓

**Risk notes for the executor:**
- framer-motion inside React Flow nodes: keep the motion element INSIDE the RF-positioned wrapper (NodeShell root is inside RF's node div, so this is already true). If nodes jitter on drag, drop the `y` offset from the entrance animation first.
- The CSS `stroke-dasharray: 1000` draw-in is approximate for paths longer than 1000px — acceptable; do not compute per-path lengths in JS for this.

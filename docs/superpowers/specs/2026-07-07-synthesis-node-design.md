# Top-Level Synthesis Node v2 — Design

**Date:** 2026-07-07
**Status:** Approved design, pending implementation plan
**Branch:** stage1-agentic-core

## Goal

Upgrade the top-level synthesis node so it (1) reviews all evidence from the
sub-query tree and runs **one gap-fill research round** for missing pieces,
(2) reuses the standard node flow (entity+metric → Tako fetch) via an
**extracted, reusable module**, (3) composes the final answer as an **agentic
GPT tool loop** with on-demand access to every Tako card's contents (CSV
series), and (4) presents the answer with a **richer, question-shaped block
vocabulary** (comparison chart, collapsible leaderboard, factor sections,
timeline) rendered by polished dedicated components.

## Decisions made during brainstorming

| Decision | Choice |
|---|---|
| Gap loop shape | One gap-fill round (not iterative, not suggest-only) |
| Card contents access | Agentic tool loop (`get_card_contents` tool + card catalog) |
| New block kinds | Comparison chart, collapsible leaderboard, factor sections, timeline |
| Gap-fill visibility | Fully visible: canvas nodes with badge + trace reasoning |
| Models | GPT everywhere at top level (deep model, high reasoning); Claude removed from compose |

## Current state (for context)

- `lib/agents/tako/research.ts` — recursive tree: decompose (entity+metric
  pairs) → leaves fetch Tako cards + web sources → branch synthesis. Root does
  `broadFetch` then defers to the composer.
- `lib/agents/tako/compose.ts` — composes `AnswerReport { verdict, blocks }`
  from extracted figures, branch claims, and web sources. Anthropic primary
  with GPT fallback. Numbers validated against gathered figures
  (`validateBlock`).
- Block kinds today: `prose | table | chart | tiles`, rendered by
  `components/AnswerReport.tsx` + `MiniChart`.
- Gaps vs the goal: composer sees only extracted figures/claims (not card
  CSVs); no gap-analysis loop; leaf flow embedded in `research.ts`
  (not reusable); small block vocabulary.

## Section 1 — Backend architecture

### Models

Everything top-level runs on **GPT** (OpenAI provider). Gap analysis and the
final composer use the deep model (`SYNTH_MODEL || "gpt-5.4"`, high reasoning
effort — the most thinking lives at the top node). The sub-query flow stays on
`gpt-5.4-mini` as today. Claude is removed from `compose.ts`; the current GPT
fallback becomes the primary path.

### Pipeline (`runTakoInitial`)

```
1. research tree (unchanged)           research.ts
2. analyzeGaps(ctx, question)          NEW lib/agents/tako/gaps.ts
3. gap-fill round (one round)          reuses researchLeaf() from flow.ts
4. composeReport v2 (tool loop)        compose.ts, rewritten
```

### `flow.ts` — reusable node flow

Extract the leaf machinery from `research.ts` into
`lib/agents/tako/flow.ts`, exposing:

- `researchLeaf(question, {entities, metrics}, ctx, opts)` — strategy →
  queries → `runSearches` → card noding/edges → CSV contents fetch → figure
  extraction → optional mini-synthesis stream.
- `research.ts` calls it for normal leaves; `gaps.ts` calls it for gap fills
  with `opts.gapFill: true`, which sets `gapFill` on the research node and
  skips decomposition (gap questions are already atomic entity+metric pairs
  by construction).
- Extraction is behavior-preserving: existing pipeline tests must stay green.

### `gaps.ts` — the gap round

- **Input digest:** sub-answers (question, claim, confidence), all gathered
  figures, the card catalog (id/title/description/entity per card), and the
  user question.
- **One `generateStructured` call** (deep GPT) returns
  `{ sufficient, rationale, gaps: [{question, entity, metric, why}] }`,
  capped at 4 gaps (enforced in code).
- Prompt teaches the classic gap shapes: comparison missing one side, ranking
  missing members, factor without its metric, stale series. Strong bias
  toward `sufficient: true` — the gap round is the exception, not a tax on
  every query.
- Emits a `reasoning` trace event per gap ("missing: AMD gross margin —
  needed to complete the comparison"), then runs all gap leaves **in
  parallel** via `researchLeaf`. New figures/cards/sources land in the same
  `ctx` accumulators, so the composer sees them with zero extra plumbing.
- **Budgeted:** gap nodes count against `TOTAL_RESEARCH_CAP`; the round is
  skipped when `sufficient: true` or the budget is exhausted.

### `compose.ts` v2 — agentic composer

- New LLM primitive `generateWithTools` in `lib/llm.ts` (AI SDK
  `generateText` + `tools` + `maxSteps`).
- **Context:** question, sub-answers, all figures, web sources, and the
  **full card catalog** — every Tako card found this turn (including
  gap-fill cards): id, title, description, entity, source.
- **One tool:** `get_card_contents(cardId)` → the card's CSV series via the
  existing `fetchContents` cache (leaf-fetched CSVs are cache hits, so cost
  stays bounded). Per-call cap ~8, `maxSteps` ~10.
- **Terminal step:** after tool use, a `generateObject` call emits the
  `AnswerReport` with the enriched block vocabulary, with tool-fetched CSVs
  inlined as evidence.
- **Validation extension:** every series the composer fetched gets its data
  points added to the allowed-figures set, so real chart points from card
  contents pass numeric validation (today they'd be dropped as untraceable).

### Error handling

- Gap analysis or gap round fails → log a ctx note, compose with existing
  evidence.
- Tool loop fails → fall back to today's single-shot compose.
- Nothing new can make the turn return empty.

## Section 2 — Schema & prompts

### New `AnswerBlock` kinds (`lib/schema.ts`)

Existing four kinds stay; new kinds are additions to the discriminated union
(old reports keep rendering).

```ts
// Multi-series comparison chart built from real card CSVs
{ kind: "comparison", title?: string, unit?: string,
  series: [{ label: string, entity: string, points: [{x: string, y: number}] }],
  insight?: string }          // one-line takeaway rendered under the chart

// Collapsible leaderboard for "top XYZ" questions
{ kind: "leaderboard", title?: string, metricLabel: string,
  rows: [{ rank: number, entity: string, value: string, delta?: string,
           detail?: { md: string, stats?: [{label, value}] } }] }

// Factor sections for "what's driving X" questions
{ kind: "sections",
  sections: [{ title: string, md: string,
               figure?: { label, value, delta? },
               chartSpec?: ChartSpec }] }

// Timeline for "how did X evolve" questions
{ kind: "timeline",
  events: [{ date: string, title: string, md?: string, value?: string }] }
```

Design choices:

- `comparison` is its own kind (not an overload of `chart`): carries `entity`
  per series (links back to canvas nodes), a required-multi-series shape, and
  an `insight` line. Composer rule: use `comparison` only when the underlying
  CSVs were fetched via `get_card_contents` — never from memory.
- `leaderboard.detail` is optional per row — filled only where real material
  exists (claim + figures for that entity); no empty accordions.
- All new kinds go through `validateBlock`: comparison points, leaderboard
  values/stats, timeline values, and section figures are checked against
  gathered figures **plus the CSV-derived allowed set**. Untraceable →
  dropped, exactly like today.

### Gap schema (`lib/agents/shared/schemas.ts`)

```ts
zGapPlan = { sufficient: boolean, rationale: string,
             gaps: [{ question, entity, metric, why }] }  // max 4 enforced in code
```

### Prompts (`lib/agents/tako/prompts.ts`)

- `GAP_SYSTEM` — lead analyst reviewing gathered evidence before the final
  report; list ONLY gaps that block a decisive answer; gap-shape patterns;
  strong bias to `sufficient: true`.
- `REPORT_SYSTEM` v2 — extends today's grounding/reconcile rules with:
  - **Block-choice playbook:** comparison question → `comparison` + prose;
    "top N" → `leaderboard`; "what factors/drivers" → `sections`; "how did X
    change/evolve" → `timeline`; simple lookup → tiles + prose.
  - **Tool protocol:** check CARD_CATALOG; fetch contents for any card whose
    real series is needed — especially both sides of any comparison.
  - Verbatim-numbers rule extended to fetched CSVs.

## Section 3 — Frontend & live-progress integration

### Report components (`components/report/`)

`AnswerReport.tsx` becomes a thin switch delegating each block kind;
existing prose/table/tiles/chart render inline as today. New per-block
components:

- `ComparisonChart.tsx` — multi-series overlay extending `MiniChart`'s
  approach: one line/bar group per entity, shared y-axis with the block's
  `unit`, color-coded legend chips (entity name + latest value), `insight`
  line beneath, hover per-point values.
- `Leaderboard.tsx` — ranked rows: rank medal/number, entity, headline value,
  optional delta arrow. Rows with `detail` get a chevron and expand
  (animated) to detail markdown + mini stat chips. Top-3 get subtle visual
  weight.
- `FactorSections.tsx` — each section a titled card: header row (title +
  headline figure chip), prose body, optional `MiniChart`. Vertical stack,
  all expanded by default (factors ARE the answer), collapsible to skim.
- `Timeline.tsx` — vertical spine with date markers, event title/value,
  optional prose per event.

Visual work follows the dataviz skill (palette, legends, axis rules) and the
existing stylesheet conventions.

### Canvas — gap-fill visibility

- `zCanvasNode` gains optional `gapFill: boolean`. Gap leaves are normal
  `role: "research"` nodes with `gapFill: true`; `NodeCard` renders a small
  "gap fill" badge with a distinct accent. Cards/edges attach exactly like
  normal research nodes.

### Trace & live events (`lib/agents/shared/types.ts`, `components/TraceNode.tsx`)

- `reasoning` event `kind` gains `"gap"` — trace tree shows the gap-analysis
  step under the root with rationale and each gap question.
- Composer activity streams as trace stages: "analyzing gaps",
  "filling gaps (2)", "composing report".
- Each `get_card_contents` call emits a `tako_call`-style record so the
  trace/Grounded-in UI shows which card series the final answer actually
  read.
- Gap-fill Tako searches flow through existing `tako_call` records unchanged
  (they go through `runSearches`).

## Testing

- `gaps.ts`: gap schema validation, 4-gap cap, `sufficient` short-circuit,
  budget respect, parallel leaf execution.
- `flow.ts`: extraction is behavior-preserving — existing pipeline tests
  stay green.
- `compose.ts` v2: validation of new block kinds (CSV-derived allowed set,
  untraceable drops), tool-loop fallback path.
- Component render tests for the four new block components.

## Out of scope

- Iterative multi-round gap loops (one round only).
- New Tako API surface — everything uses existing `takoSearch` /
  `takoContents` / graph strategy.
- Changes to the follow-up turn pipeline (`followup.ts`).

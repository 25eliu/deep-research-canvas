# Graphy hero chart in the synthesis node — design

**Date:** 2026-07-13
**Status:** approved (brainstorm w/ Eric)

## What

A per-turn "Graphy" toggle in the chat input. When on, the final synthesis
report gains one **hero Graphy chart** — a purpose-built flagship visualization
modeled from the Tako card contents (CSVs) the compose step already grabbed —
rendered directly under the report verdict in the synthesis node, above all
other blocks. Rendering uses the plain Graphy charting SDK (`@graphysdk/core`,
private npm — requires `NPM_TOKEN` in `.npmrc`). **No Graphy Agents API.**

## UX / flag threading

- "graphy chart" switch mirroring the existing `takoAnswer` pattern: on the
  Landing controls row (before the first question) and in the canvas topbar
  (for follow-up turns), off by default. **Per-turn semantics**: the switch
  state at submit time is what that run uses.
- Threading (same path as `takoAnswerEnabled`): `Session.graphy` →
  `AgentRequest.graphyEnabled` → `/api/agent` route (defaults `false`) →
  provider run → read as `ctx.req.graphyEnabled`.
- Only `composeReport` reads the flag; decompose/leaves/expand ignore it.

## Server-side modeling

New module `lib/agents/tako/graphy.ts`:

- `composeGraphyHero(ctx, question, report)` — called at the end of
  `composeReport` (lib/agents/tako/compose.ts) only when `ctx.graphy` is set.
- One structured LLM call (`generateStructured`, OpenAI, same pattern as the
  rest of the pipeline). Prompt input: the question, the report verdict, and
  CSV excerpts of the top fetched cards from the per-turn contents cache.
- Output validated against a new Zod schema `zGraphyConfig` authored from
  Graphy's data-structure spec:
  - `type`: enum `bar | column | line | area | pie | donut | scatter`
  - `data.columns`: `[{ key, label }]`
  - `data.rows`: array of records (string | number values), capped ~60 rows
  - optional `title`, `subtitle`
  - Schema keeps `.optional()` fields — `structuredOutputs: false` on OpenAI
    (see CLAUDE.md gotcha); do NOT rewrite to all-required.

### Accuracy enforcement (hard requirement)

Every numeric value in `data.rows` MUST be traceable to Tako card contents:
run the hero's numbers through the same `allowedSets` / `csvFigures`
machinery `composeReport` uses for report blocks, against the FULL per-turn
CSV cache. If the untraceable fraction exceeds the existing block-validation
tolerance, the modeled config is **discarded** (counts as a modeling failure
→ fallback). The Graphy chart can never show numbers Tako didn't return.

### Fallback (approach B)

Pure functions `chartSpecToGraphyConfig` / `comparisonToGraphyConfig` convert
the report's first existing `chart` or `comparison` block into a
`GraphConfig` when the modeling call errors, times out, or fails accuracy
validation. If no convertible block exists, the report ships without a hero —
silent degradation, `ctx.notes` entry only, never a user-facing error.

## Schema / data placement

- The hero does **NOT** join the `zAnswerBlock` union (that would let the
  report-composer LLM emit `graphy` blocks on its own). Instead
  `zAnswerReport` gains an optional `graphy: zGraphyBlock` field
  (`{ title?, config: zGraphyConfig }`), populated post-composition,
  server-side only. Composer prompt + schema untouched.
- Travels to the client on the synthesis node's existing `report` field
  (`lib/schema.ts` `zCanvasNode.report`).

## Client rendering

- **Revised 2026-07-13 (Eric):** `@graphysdk/core` is a private npm package
  and no Graphy credentials exist yet; there is no anonymous create-and-embed
  API. The render layer is LOCAL for now: `components/GraphyHero.tsx` renders
  the `GraphyConfig` with recharts using the existing chart idioms
  (`components/charts/theme.ts` — SERIES_COLORS, axis/tooltip theming).
  The config shape stays Graphy-native (`type` + `data.columns`/`data.rows`),
  so swapping in `<GraphProvider config={...}><Graph /></GraphProvider>` later
  is a one-component change once an npm token exists.
- `AnswerReport.tsx` renders `report.graphy` between the verdict div and the
  block loop.
- Height/width fit the node card.

## Error handling

- Modeling failure / validation failure / SDK render error → fallback config
  or no hero; report always renders. Client wraps GraphyHero in an error
  boundary so an SDK crash can't take down the node card.

## Testing (deliberately minimal, per Eric)

- Unit tests for `zGraphyConfig` validation and the accuracy-enforcement path
  (accepts traceable rows, discards untraceable configs).
- Unit test for the deterministic fallback converters.
- No E2E / extensive coverage for this feature.

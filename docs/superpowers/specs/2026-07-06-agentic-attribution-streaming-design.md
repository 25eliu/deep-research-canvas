# Agentic attribution + progressive streaming — design

**Date:** 2026-07-06
**Branch:** stage1-agentic-core
**Scope:** the Tako provider pipeline (`lib/agents/tako/*`), the agent route protocol, and the client stream consumer.

## Goal

Make the Tako agent:

1. **Mechanically ground every node in a discovered, attributable finding** — graphSearch → related → search → fetch card/web contents, and turn *each* result into exactly one node. Nothing invented; a node exists only if it maps to a real finding.
2. **Link findings together and synthesize a cited answer** — every finding is a linked node on the canvas AND is attributed in the streamed answer (inline `[n]` + an always-on Evidence footer).
3. **Enable web** — Tako search/answer run with web on; web-grounded facts are first-class findings the synthesis uses.
4. **Stream progressively** — graphs/cards render on the canvas the moment each search resolves; the answer prose then streams token-by-token.
5. **Record runtime per run** — per-stage timing breakdown in the trace + server log.

## Decisions (locked via brainstorming)

- **Board authorship: hybrid.** Nodes are minted only by code (mechanical, 1:1 to findings). The LLM structures sections/consensus and writes the streamed answer, but cannot mint nodes.
- **Source model:** graph entity → `entity_section` header (grouping only); Tako v3 data card → `data_card` node; web fact (from v3 web source or `/v1/answer`) → `text`/evidence node with source + URL. Every finding node is cited.
- **Attribution:** free prose streamed with inline `[n]` markers; an always-on **Evidence footer** lists all N findings (`title · source · url`) appended in finalize — 100% attributed on-screen regardless of prose.
- **Runtime:** per-stage breakdown in `trace.timings` + one server log line; ephemeral (no disk persistence).

## Pipeline stages (`lib/agents/tako/pipeline.ts`)

Each stage is timed and emits to the stream as it completes.

1. **breakdown** — LLM (buffered) → `{entities, metrics, subtypes}`.
2. **graph resolve + related** — mechanical HTTP per entity → one `entity_section` header per resolved entity. Emit `ops` as sections resolve → sections appear first.
3. **compose queries** — LLM (buffered) → web-enabled query list, each tagged with its source entity.
4. **search (web-enabled, concurrent)** + **takoAnswer** — per query `takoSearch({web:true})`; keep ALL findings; classify + dedup; one node per finding assigned to its entity section; emit each `ops` the moment its search resolves → graphs stream in. `takoAnswer` runs concurrently: its grounded prose seeds stage 6, its new cards become web-fact nodes.
5. **structure** — LLM (buffered, small) → section titles/summaries + optional consensus spec. Translated to ops mechanically. Consensus node built only when metric findings exist (no fabricated numbers).
6. **stream answer** — LLM `streamText` → prose citing every finding `[n]`; tokens streamed as `token` events.
7. **finalize** — mechanical: structural edges (`relate.ts`), consensus recompute, Evidence footer appended to narration, provenance assertion (drop any node not a section and not in the ledger), timings. Emit final `result`.

**Provenance invariant:** only stages 2 and 4 mint nodes. Stages 5–6 cannot. Every non-section node maps 1:1 to a discovered finding.

## Stream protocol (`route.ts` ↔ `app/page.tsx`)

Additive NDJSON events (existing `trace`/`error` unchanged):

- `ops` `{ops: CanvasOp[]}` — incremental canvas ops mid-run (idempotent add_node/upsert). Client applies immediately.
- `token` `{text}` — a chunk of answer prose. Client grows a live agent message.
- `result` `{canvasOps, narration, sideReply, trace}` — final. `canvasOps` = finalize delta only (edges, consensus, footer). `narration` = complete final text incl. footer. `trace.timings` included.

The pipeline receives a unified `emit(event)` callback (replaces the trace-only callback). `route.ts` maps each event to an NDJSON line.

## Mechanical attribution (`lib/agents/tako/findings.ts`, new)

- **Ledger:** `Map<key, {index, nodeId, kind, title, source, url}>`; dedup by cardId/url; one node each.
- **Classifier:** structured card (embedUrl/chartSpec) → `data_card`; web fact (url, no chart) → `text`/evidence.
- **Footer builder:** always lists all N findings.
- **Assertion:** finalize drops any node id not a section and not in the ledger.

## Web + runtime

- `takoSearch` gains `web?: boolean` → adds `sources.web` to the v3 body (exact shape verified against live staging during impl). Tako capabilities set `web_search: true`. Grounding: card→`tako`, web-fact→`web`.
- `Timings` accumulator (reuses `lib/log.ts` timer) → `trace.timings = {breakdown, graph, search, structure, stream, finalize, total}`.

## Testing

- **Unit:** classifier, ledger (1:1 + dedup), footer (all N), completeness (uncited → still footered), timings.
- **Integration:** mock search/answer/LLM → `ops` emitted before `token`s, every finding → node, footer complete, zero invented nodes.
- Existing 18 tests stay green.

## Files

`pipeline.ts` (rewrite), `route.ts` + `page.tsx` (protocol), `tako.ts` (web), `schema.ts`/`types.ts` (event + `Timings` types), **new** `findings.ts`, `agent.ts`/`registry.ts`/`baseline/agent.ts`/`followup.ts` (emit signature). `relate.ts`/`consensus.ts` untouched.

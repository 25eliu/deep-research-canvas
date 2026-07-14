# canvas-tako — working notes for agents

## Tako API (verified 2026-07-06)
- **Host MUST be `staging.tako.com`.** `staging.trytako.com` is Cloudflare-blocked (403 on /api/*).
- Staging has its OWN key namespace: prod `tako.com` keys 401 on staging and vice-versa.
- Search: `POST /api/v3/search` `{query, effort, sources:{data:{count}}}` → `{cards:[{card_id,title,embed_url,webpage_url,image_url,sources,card_type,...}]}`.
- Answer: `POST /api/v1/answer` `{query, effort}` → `{answer, cards:[...]}` (grounded prose + citable cards).
- Graph: `GET /api/beta/graph/search?q&types=entity|metric[&label]` → `{results:[...]}`;
  `GET /api/beta/graph/related?node_id&relation_type&q[&label]` → items live in **`relation.items`** (NOT `results`).
  Always pass `q` on related (unfiltered = tens of thousands of items).
- **`subtype` was REMOVED** (2026-07-14) — sending it 400s. Use `label` instead: a RANKING BOOST
  (not a filter — nothing is excluded, totals unchanged; supplying it disables label inference).
  Valid values (fixed 11-value NER enum): `PERSON, ORG, GPE, LOC, PRODUCT, EVENT, LANGUAGE, MONEY,
  METRIC, STOCK_TICKER, WEBSITE`. An out-of-enum value 400s (`Invalid label`). `subtype` still appears
  as a RESPONSE field. The metric fan-out on `/related` passes `label=METRIC` to rank metric items up.
- Card embeds post height via a `tako::resize` postMessage — do not hard-code iframe heights.

## Providers
- Three only: `gpt`, `claude` (baselines, no tools), `tako` (grounded, fixed to gpt-5.4-mini).
- NEVER call `tako_agent` or `tako_visualize`: cohort resolution via graph + LLM; consensus via `lib/consensus.ts`.

## Stack
- LLM layer = Vercel AI SDK `generateObject` + Zod schemas (structural validation, no JSON salvage).
- `ai@4` chosen for React 18.3 / Next 14.2 compatibility (server-only path avoids the React-19 UI hooks).

## Gotchas discovered during implementation

- **OpenAI structured outputs + Zod optional fields.** The Vercel AI SDK's OpenAI provider
  defaults to STRICT structured outputs, which requires every object property to appear in
  `required` and REJECTS `.optional()` Zod fields (error: `'required' is required to be
  supplied and to be an array including every key in properties`). Our scene-graph schemas
  (`zCanvasNode`, `zTakoRef`, etc.) use many `.optional()` fields, so `lib/llm.ts`'s
  `getModel` sets `structuredOutputs: false` on the OpenAI model. `generateObject` still
  validates against the Zod schema + auto-retries; we just don't use OpenAI's provider-side
  strict enforcement. Do NOT rewrite the schemas to all-required to "fix" this.
- **graphology duplicate `(from, to)` edges.** A non-multi directed `graphology` graph
  THROWS if `addEdge` is called twice for the same `(from, to)` pair — even when the two
  edges have distinct ids. In `lib/relate.ts`'s `validateGraph` this happened when an
  LLM-authored `supports` edge duplicated a structural `feeds` edge to the same consensus
  node. Guard every add with `g.hasEdge(from, to)` (only the first edge per node pair
  survives).

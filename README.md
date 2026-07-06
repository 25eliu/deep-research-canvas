# Spatial Research Canvas — Tako demo (starter)

A chat-driven spatial canvas that turns research questions into a board of connected,
cited data cards converging on a consensus verdict. The **data provider is a one-function
swap**, so you can compare the same board built by three providers:

- `gpt` / `claude` — **baselines with no tools.** They answer from memory and draw charts
  themselves (a `chartSpec` the frontend renders). No live data, no sources.
- `tako` — **grounded.** A graph-first pipeline (`graph/search` + `graph/related` +
  `/v3/search`) resolves entities/metrics and fetches real [Tako](https://trytako.com)
  knowledge cards for the initial board; follow-up questions and side-chat responses use
  **Tako Answer** (`/api/v1/answer`) for grounded prose + citable cards. Cards render as
  live embeds with source + as-of. The internal LLM sub-steps run on a fast model
  (`gpt-5.4-mini`); cohort resolution and ranking happen via the graph + LLM composition —
  never `tako_agent` — and the consensus/leaderboard is always deterministic app code
  (`lib/consensus.ts`), never `tako_visualize`.

The difference is visible on the canvas: grounded boards are dense with cited cards;
baseline boards are thinner and flagged `model · <confidence>` with no source.

## Why this is a repo, not a Claude.ai artifact

All three providers are **live**. That can't run inside a Claude.ai artifact: the artifact
sandbox can only reach Anthropic's API (no OpenAI), and it blocks the external iframes/
images Tako cards use. A tiny Next.js backend holds the keys and proxies to OpenAI,
Anthropic, and Tako — so everything is genuinely live here.

## Run

```bash
npm install
cp .env.example .env.local   # fill in TAKO_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY
npm run dev                  # http://localhost:3000
```

Set `ANTHROPIC_MODEL` / `OPENAI_MODEL` to current model strings for your accounts. Set
`TAKO_HOST=https://staging.tako.com` — `staging.trytako.com` is Cloudflare-blocked (403 on
`/api/*`), and staging uses its own key namespace (prod `tako.com` keys 401 on staging).

Run tests: `npm test`

Then type e.g. *"Research the best 5 semiconductor companies to invest in"*, switch the
provider in the top-left, select nodes to ask about them in the side chat.

## Architecture

```
app/page.tsx              Canvas UI: pan/zoom, drag, edges, provider switcher, main + side chat
app/api/agent/route.ts    Single entry point → runs the selected provider server-side
lib/schema.ts             Scene-graph contract (nodes, edges, ops) + applyOps()
lib/providers/registry.ts THE MODULAR SEAM — 3-provider registry + capabilities
lib/agents/baseline/      Baseline (gpt/claude) agent + prompts — no tools, model-drawn
lib/agents/tako/          Tako agent: graph-first pipeline, Tako Answer follow-ups, prompts
lib/agents/shared/        Router, TurnTrace/TraceFn types, shared schemas
lib/llm.ts                Vercel AI SDK generateObject wrapper (Zod-validated, no JSON salvage)
lib/tako.ts               Live Tako v3/search + Answer client + card mapping
lib/relate.ts             Structural edges + graph validation (dedupe via graphology)
lib/consensus.ts          Deterministic consensus/leaderboard scoring
lib/sanitize.ts           Strips hallucinated card refs / enforces allowTako per provider
components/NodeCard.tsx   Renders each node type (Tako iframe vs model MiniChart)
components/MiniChart.tsx  Dependency-free SVG chart for baseline model-drawn data
```

The agent is a pure function: `(message + canvasState + selection + provider) → { canvasOps, narration, sideReply }`.
The frontend applies the ops. Switching providers changes only the grounding step — the
decision tree is identical across providers; see `docs/agents-architecture.md` for the
four Mermaid diagrams (Tako initial/follow-up, baseline initial/follow-up).

### Stack

- **Vercel AI SDK** (`ai@4`, `@ai-sdk/openai`, `@ai-sdk/anthropic`) `generateObject` + **Zod**
  schemas for structural validation of every LLM call — no ad hoc JSON parsing/salvage.
  `ai@4` was chosen for React 18.3 / Next 14.2 compatibility.
- **graphology** — structural + LLM-authored edge validation in `lib/relate.ts`.
- **vitest** — unit/integration tests for sanitize, consensus, relate, and the Tako client.

### The router

Each message is classified into NEW_BOARD / REPLACE / AUGMENT / REFRAME / EXPLAIN, then
grounded via the active provider, connected (edges for genuinely related nodes), and
emitted as a diff. Selection biases toward EXPLAIN or a scoped AUGMENT; `side_chat`
messages answer in `sideReply`. See `lib/agents/shared/router.ts` and
`docs/agents-architecture.md` for the full decision trees per provider and turn type.

## Guardrails baked in

- Baseline `data_card`s can never carry a Tako ref; forced `grounding:"model"`, capped confidence.
- Grounded providers may only use cards actually fetched this turn; any hallucinated
  `cardId` is stripped and the node is downgraded to `model`. (See `sanitizeOps`.)
- Tako endpoints are `POST /api/v3/search` (initial-research grounding) and
  `POST /api/v1/answer` (follow-ups), both against **`TAKO_HOST=https://staging.tako.com`**
  with `X-API-Key`. No `tako_agent` or `tako_visualize` call exists anywhere in the
  codebase — cohort resolution runs via the graph + LLM composition
  (`lib/agents/tako/pipeline.ts`), and consensus/leaderboard scoring is deterministic app
  code (`lib/consensus.ts`).

## Extend next

- **Multi-canvas sessions.** `canvasId` is threaded through but state is single-board in
  memory; persist per-id for real chat history / new-canvas (Zustand + sessions — Stage 2+).
- **Side-by-side mode.** Run two providers on the same query and render two boards for
  direct comparison.
- **Canvas redesign.** xyflow-based canvas, node/edge/section visual redesign, criteria
  sliders, motion, skeleton loading states, command palette (Stages 2–5).
- **Layering polish.** Add section-container backgrounds and edge-kind color legend.

Not investment advice — the consensus is an analytical ranking on stated criteria.

# Spatial Research Canvas — Tako demo (starter)

A chat-driven spatial canvas that turns research questions into a board of connected,
cited data cards converging on a consensus verdict. The **data provider is a one-function
swap**, so you can compare the same board built by:

- `gpt` / `claude` — **baselines with no tools.** They answer from memory and draw charts
  themselves (a `chartSpec` the frontend renders). No live data, no sources.
- `gpt_tako` / `claude_tako` — **grounded.** They fetch real [Tako](https://trytako.com)
  knowledge cards and reason over them; cards render as live embeds with source + as-of.

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

Set `ANTHROPIC_MODEL` / `OPENAI_MODEL` to current model strings for your accounts.

Then type e.g. *"Research the best 5 semiconductor companies to invest in"*, switch the
provider in the top-left, select nodes to ask about them in the side chat.

## Architecture

```
app/page.tsx            Canvas UI: pan/zoom, drag, edges, provider switcher, main + side chat
app/api/agent/route.ts  Single entry point → runs the selected provider server-side
lib/schema.ts           Scene-graph contract (nodes, edges, ops) + applyOps()
lib/providers/index.ts  THE MODULAR SEAM — baseline vs Tako-grounded providers + registry
lib/tako.ts             Live Tako knowledge_search client + card mapping
lib/llm.ts              Live OpenAI / Anthropic JSON calls
components/NodeCard.tsx  Renders each node type (Tako iframe vs model MiniChart)
components/MiniChart.tsx Dependency-free SVG chart for baseline model-drawn data
```

The agent is a pure function: `(message + canvasState + selection + provider) → { canvasOps, narration, sideReply }`.
The frontend applies the ops. Switching providers changes only the grounding step.

### The router

Each message is classified into NEW_BOARD / REPLACE / AUGMENT / REFRAME / EXPLAIN, then
grounded via the active provider, connected (edges for genuinely related nodes), and
emitted as a diff. Selection biases toward EXPLAIN or a scoped AUGMENT; `side_chat`
messages answer in `sideReply`. See `lib/providers/index.ts` (ROUTER + SCHEMA_BRIEF) and
the full spec in `spatial-canvas-agent-prompt.md`.

## Guardrails baked in

- Baseline `data_card`s can never carry a Tako ref; forced `grounding:"model"`, capped confidence.
- Grounded providers may only use cards actually fetched this turn; any hallucinated
  `cardId` is stripped and the node is downgraded to `model`. (See `sanitizeOps`.)
- Tako endpoint/auth are the documented `POST /api/v1/knowledge_search` + `X-API-Key`.

## Extend next

- **Deterministic consensus.** `recompute_consensus` is a no-op hook today; move scoring
  into app code (read metric nodes × criteria weights) so rankings are provider-independent
  and reproducible across comparison runs.
- **Multi-canvas sessions.** `canvasId` is threaded through but state is single-board in
  memory; persist per-id for real chat history / new-canvas.
- **Side-by-side mode.** Run two providers on the same query and render two boards.
- **Tako Answer/Agent.** The `takoAnswer` toggle is wired; add the Answer/Agent endpoints
  in `lib/tako.ts` for prose grounding and cohort resolution.
- **Layering polish.** Add section-container backgrounds and edge-kind color legend.

Not investment advice — the consensus is an analytical ranking on stated criteria.

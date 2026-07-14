<div align="center">

# 🔭 Deep Research Canvas

### Ask a research question. Watch it become a board of cited, connected data cards — converging on a verdict.

<!--
  DEMO VIDEO SLOT:
  Drop your recording at docs/demo.gif and it renders below automatically.
  (Or drag-and-drop an .mp4 straight into this file in the GitHub web editor —
   GitHub hosts it and swaps in a <video> URL for you.)
-->
<img src="docs/demo.gif" alt="Deep Research Canvas — a research question becoming a board of cited data cards" width="820" />

</div>

---

## Why it's powerful

Most AI answers are a wall of text you just have to trust. Deep Research Canvas turns a
single question into a **spatial board** you can see, navigate, and interrogate:

- **🧩 A living canvas, not a chat log.** Every finding is a draggable card; edges show how
  sub-questions feed the consensus. Pan, zoom, select a node and ask about *that* node in
  the side chat.
- **📌 Grounded in real, cited data.** With the `tako` provider, cards are backed by live
  [Tako](https://tako.com) knowledge cards — real numbers, real sources, an "as-of" date —
  not the model's memory.
- **⚖️ See the difference, side by side.** Flip the provider to `gpt` or `claude` (baselines,
  no tools) and the board goes thin and flagged `model · <confidence>` with no sources.
  Grounded boards are dense with citations. **The gap is the whole point.**
- **🎯 A deterministic verdict.** The consensus / leaderboard ranking is plain app code over
  your stated criteria — reproducible, not vibes.

## Quick start

```bash
git clone https://github.com/25eliu/deep-research-canvas.git
cd deep-research-canvas
npm install
cp .env.example .env.local     # add your API keys (see below)
npm run dev                    # → http://localhost:3000
```

Then ask something like *"Research the best 5 semiconductor companies to invest in"*, switch
providers in the top-left, and select nodes to dig deeper in the side chat.

### Keys you'll need

Everything runs live and **server-side — keys never touch the browser**. Fill these into
`.env.local`:

| Variable | Powers | Where to get it |
|----------|--------|-----------------|
| `TAKO_API_KEY` | Grounded, cited data cards (the `tako` provider) | [developer.tako.com](https://developer.tako.com) · [docs.tako.com](https://docs.tako.com) |
| `OPENAI_API_KEY` | The `gpt` baseline | platform.openai.com |
| `ANTHROPIC_API_KEY` | The `claude` baseline | console.anthropic.com |

> `TAKO_HOST` defaults to `https://tako.com` (production) — no need to set it. Set
> `OPENAI_MODEL` / `ANTHROPIC_MODEL` to current model strings for your accounts.

Run the tests with `npm test`.

## How it works

The whole app is one idea: **the agent is a pure function** —
`(message + canvas state + selection + provider) → { canvasOps, narration, sideReply }` —
and the frontend just applies the ops. Switching providers changes **only** the grounding
step; the decision logic stays identical.

- `gpt` / `claude` answer from memory and draw their own charts — no tools, no sources.
- `tako` runs a graph-first pipeline (resolve entities/metrics → fetch real cards →
  deterministic consensus), with grounded follow-ups via Tako Answer.

That's the overview — the full decision trees and Mermaid diagrams live in
**[docs/agents-architecture.md](docs/agents-architecture.md)**. Built with Next.js, the
Vercel AI SDK + Zod, and [Tako](https://tako.com) for grounding.

## License

MIT — see [LICENSE](./LICENSE). Not investment advice; the consensus is an analytical
ranking on stated criteria.

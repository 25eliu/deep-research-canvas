# Stage 1 — Agentic Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the agent layer as three schema-strict providers (`gpt`, `claude`, `tako`) with a graph-first Tako pipeline, Tako-Answer follow-ups, deterministic consensus/relate/layout helpers, and a streamed per-turn trace — all behind a typed registry, keeping the frontend working.

**Architecture:** Zod schemas become the single source of truth for the scene-graph contract and every agent sub-step. `lib/llm.ts` is rewritten around the Vercel AI SDK (`generateObject`) so output is structurally validated. The `tako` provider (gpt-5.4-mini) resolves questions through the Tako graph API, composes grounded `/v3/search` queries, and uses `/v1/answer` for follow-ups; deterministic code owns consensus scoring, structural edges, and validation. The API route streams coarse trace events (NDJSON) as stages complete.

**Tech Stack:** Next.js 14.2 App Router, TypeScript strict, React 18.3, `ai` + `@ai-sdk/openai` + `@ai-sdk/anthropic` + `zod`, `graphology`, `vitest`.

## Global Constraints

- **Three providers only:** `gpt` (baseline OpenAI), `claude` (baseline Anthropic), `tako` (grounded, **fixed to gpt-5.4-mini via `@ai-sdk/openai`**, no Claude variant). Default provider = `tako`.
- **Tako host:** default `https://staging.tako.com` — NEVER `staging.trytako.com` (Cloudflare-blocked). Auth header `X-API-Key`. Same env keys as `.env.example` (`TAKO_API_KEY`, `TAKO_HOST`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`).
- **Honest grounding (invariant):** baselines can NEVER attach a Tako ref and are capped at `confidence <= 0.6`; the grounded provider may only use `cardId`s fetched that turn — `sanitizeOps` strips the rest and downgrades to `grounding:"model"`. Never fabricate a number, cardId, source, or date.
- **No `tako_agent`, no `tako_visualize`** anywhere: cohort resolution/ranking via graph + LLM composition; consensus via deterministic code (`lib/consensus.ts`).
- **The agent is a pure function** `(req, onTrace?) => Promise<AgentResponse>`. `onTrace` is a progress callback, not a rendering side-effect.
- **Scene-graph is canonical.** The frontend only applies ops via `applyOps`.
- **Living docs:** as findings emerge, record non-obvious gotchas in root `CLAUDE.md` and update `README.md`.
- **Keys never reach the client.** All Tako/LLM calls are server-side only.

---

## File Structure

**Create:**
- `lib/sanitize.ts` — `sanitizeOps` (moved out of `providers/index.ts`), unit-tested.
- `lib/sanitize.test.ts` — the required test.
- `lib/consensus.ts` — deterministic `computeConsensusRows` + `recomputeConsensus` + `normalize`.
- `lib/consensus.test.ts` — determinism test.
- `lib/relate.ts` — deterministic structural edges + `graphology` validation.
- `lib/relate.test.ts` — structural-edge + hairball test.
- `lib/agents/shared/schemas.ts` — Zod schemas for `AgentResponse` + sub-steps.
- `lib/agents/shared/router.ts` — `ROUTER` prompt + `RouteAction` type.
- `lib/agents/shared/ctx.ts` — `ctxBlock(req)`.
- `lib/agents/shared/types.ts` — `TurnTrace`, `TraceFn`, `AgentContext`.
- `lib/agents/baseline/prompts.ts` — all baseline prompts.
- `lib/agents/baseline/agent.ts` — `runBaseline`.
- `lib/agents/tako/prompts.ts` — all tako prompts (breakdown, compose, synth, follow-up).
- `lib/agents/tako/graph.ts` — `graphSearch`, `graphRelated`.
- `lib/agents/tako/pipeline.ts` — initial-research pipeline.
- `lib/agents/tako/followup.ts` — Tako-Answer follow-up flow.
- `lib/agents/tako/agent.ts` — `runTako` orchestrator.
- `lib/providers/registry.ts` — typed `PROVIDERS` + `runProvider`.
- `vitest.config.ts` — test runner config.
- `docs/agents-architecture.md` — the 4 Mermaid diagrams.
- `CLAUDE.md` — findings log.

**Modify:**
- `lib/schema.ts` — add Zod schemas, derive types, `ProviderId`, `TurnTrace` on `AgentResponse`, wire `recompute_consensus`.
- `lib/llm.ts` — rewrite around AI SDK.
- `lib/tako.ts` — host fix, `/v3/search` migration, `takoAnswer`, timeout, defensive mapping.
- `app/api/agent/route.ts` — stream NDJSON trace events.
- `app/page.tsx` — 3-provider set + consume the stream (minimal).
- `.env.example` — host default + note.
- `package.json` — deps + `test` script.

**Delete:**
- `lib/providers/index.ts` (replaced by `registry.ts` + `agents/`).
- The stray `{lib` garbage directory.

---

## Task 1: Dependencies + test runner

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: `npm test` (vitest) and the installed libraries used by every later task.

- [ ] **Step 1: Install runtime deps**

```bash
npm install ai@^4 @ai-sdk/openai@^1 @ai-sdk/anthropic@^1 zod@^3 graphology@^0.25 graphology-types@^0.24
```

(If `ai@^4` resolves to a version needing React 19, pin the latest 4.x that supports React 18.3; the server-only `generateObject` path does not require the React UI hooks.)

- [ ] **Step 2: Install dev deps**

```bash
npm install -D vitest@^2
```

- [ ] **Step 3: Add the test script**

In `package.json` `"scripts"`, add:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: { environment: "node", include: ["lib/**/*.test.ts"] },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
```

- [ ] **Step 5: Verify tooling**

Run: `npx vitest run` → Expected: "No test files found" (exit 0, acceptable at this point).
Run: `npm run build` → Expected: builds green (no code changed yet).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts 2>/dev/null; git commit -m "chore: add ai-sdk, zod, graphology, vitest" || true
```

(Repo may not be git-initialized; `|| true` keeps the step non-fatal. If not a repo, skip commits throughout.)

---

## Task 2: Zod schemas as source of truth (`lib/schema.ts`)

**Files:**
- Modify: `lib/schema.ts`

**Interfaces:**
- Produces: `ProviderId = "gpt"|"claude"|"tako"`; Zod schemas `zCanvasNode`, `zCanvasEdge`, `zCanvasOp`, `zCanvasOps`; types `CanvasNode`, `CanvasEdge`, `CanvasOp`, `CanvasState` (unchanged shapes); `AgentRequest.providerId: ProviderId`; `AgentResponse.trace?: TurnTrace` (imported from `agents/shared/types`); `applyOps` unchanged except `recompute_consensus` now delegates (wired in Task 5).

- [ ] **Step 1: Add zod import and schemas at the top of `lib/schema.ts`**

Insert after line 1:

```ts
import { z } from "zod";

export const zGrounding = z.enum(["tako", "model", "web"]);
export const zNodeType = z.enum([
  "entity_section", "data_card", "metric", "criteria", "consensus", "text",
]);
export const zEdgeKind = z.enum([
  "feeds", "supports", "contradicts", "derived_from", "sibling",
]);

export const zChartSpec = z.object({
  kind: z.enum(["bar", "line"]),
  unit: z.string().optional(),
  series: z.array(z.object({
    label: z.string(),
    points: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })),
  })),
});

export const zTakoRef = z.object({
  cardId: z.string(),
  embedUrl: z.string().optional(),
  imageUrl: z.string().optional(),
  webpageUrl: z.string().optional(),
  source: z.string().optional(),
  asOf: z.string().optional(),
});

export const zConsensusRow = z.object({
  rank: z.number(),
  entity: z.string(),
  score: z.number().optional(),
  note: z.string().optional(),
});

export const zCanvasNode = z.object({
  id: z.string(),
  type: zNodeType,
  section: z.string().optional(),
  role: z.enum(["header", "evidence", "criteria", "consensus", "note"]).optional(),
  rank: z.number().nullable().optional(),
  title: z.string(),
  summary: z.string().optional(),
  tako: zTakoRef.optional(),
  chartSpec: zChartSpec.optional(),
  metric: z.object({ value: z.string(), label: z.string(), delta: z.string().optional() }).optional(),
  criteria: z.object({ weights: z.record(z.number()) }).optional(),
  consensusRows: z.array(zConsensusRow).optional(),
  grounding: zGrounding,
  confidence: z.number(),
  position: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
});

export const zCanvasEdge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: zEdgeKind,
  label: z.string().optional(),
});

export const zCanvasOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_node"), node: zCanvasNode }),
  z.object({ op: z.literal("upsert_node"), node: zCanvasNode }),
  z.object({ op: z.literal("update_node"), id: z.string(), patch: zCanvasNode.partial() }),
  z.object({ op: z.literal("remove_node"), id: z.string(), cascade: z.boolean().optional() }),
  z.object({ op: z.literal("add_edge"), edge: zCanvasEdge }),
  z.object({ op: z.literal("move_node"), id: z.string(), position: z.object({ x: z.number(), y: z.number() }) }),
  z.object({ op: z.literal("recompute_consensus"), target: z.string() }),
]);
export const zCanvasOps = z.array(zCanvasOp);
```

- [ ] **Step 2: Replace the hand-written interfaces with derived types**

Delete the old `ChartSpec`, `TakoRef`, `ConsensusRow`, `CanvasNode`, `EdgeKind`, `CanvasEdge`, `CanvasOp` interface/type declarations (lines 13–75 in the original) and replace with:

```ts
export type Grounding = z.infer<typeof zGrounding>;
export type NodeType = z.infer<typeof zNodeType>;
export type EdgeKind = z.infer<typeof zEdgeKind>;
export type ChartSpec = z.infer<typeof zChartSpec>;
export type TakoRef = z.infer<typeof zTakoRef>;
export type ConsensusRow = z.infer<typeof zConsensusRow>;
export type CanvasNode = z.infer<typeof zCanvasNode>;
export type CanvasEdge = z.infer<typeof zCanvasEdge>;
export type CanvasOp = z.infer<typeof zCanvasOp>;
```

Keep the existing `CanvasState` interface as-is.

- [ ] **Step 3: Update `ProviderId`, `AgentRequest`, `AgentResponse`**

Replace the `AgentRequest`/`AgentResponse` block:

```ts
export type ProviderId = "gpt" | "claude" | "tako";

export interface AgentRequest {
  canvasId: string;
  message: string;
  surface: "main" | "side_chat";
  canvasState: CanvasState;
  selection?: { nodeIds: string[]; nodes: Partial<CanvasNode>[] };
  providerId: ProviderId;
  takoAnswerEnabled?: boolean;
}

// TurnTrace is defined in lib/agents/shared/types.ts to keep this file dependency-free.
export interface AgentResponse {
  canvasOps: CanvasOp[];
  narration: string;
  sideReply: string | null;
  trace?: import("./agents/shared/types").TurnTrace;
  debug?: unknown;
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit` → Expected: errors only in files that still import the old `providerId` union (`app/page.tsx`, `providers/index.ts`) — those are fixed in later tasks. `lib/schema.ts` itself must be clean.

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts && git commit -m "feat: zod schemas as scene-graph source of truth" || true
```

---

## Task 3: AI SDK wrappers (`lib/llm.ts`)

**Files:**
- Modify: `lib/llm.ts`

**Interfaces:**
- Produces:
  - `getModel(provider: "openai" | "anthropic")` → an AI SDK `LanguageModel`.
  - `generateStructured<T>(opts: { provider, system, prompt, schema: z.ZodType<T> }): Promise<T>` — schema-validated generation.
  - `generateText2(opts: { provider, system, prompt }): Promise<string>` — free-text (for prose answers).
- Consumes: env `OPENAI_MODEL` (default `gpt-5.4-mini`), `ANTHROPIC_MODEL` (default `claude-sonnet-4-5`).

- [ ] **Step 1: Replace the entire contents of `lib/llm.ts`**

```ts
// LLM layer built on the Vercel AI SDK. Output is schema-validated (generateObject),
// so callers get typed, structurally-valid objects — no manual JSON salvage.
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText, type LanguageModel } from "ai";
import type { z } from "zod";

export type LlmProvider = "openai" | "anthropic";

export function getModel(provider: LlmProvider): LanguageModel {
  if (provider === "openai") {
    return openai(process.env.OPENAI_MODEL || "gpt-5.4-mini");
  }
  return anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5");
}

export async function generateStructured<T>(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
}): Promise<T> {
  const { object } = await generateObject({
    model: getModel(opts.provider),
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
    temperature: 0.2,
  });
  return object;
}

export async function generateFreeText(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
}): Promise<string> {
  const { text } = await generateText({
    model: getModel(opts.provider),
    system: opts.system,
    prompt: opts.prompt,
    temperature: 0.2,
  });
  return text;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npx tsc --noEmit lib/llm.ts` (or full `npx tsc --noEmit`) → Expected: `lib/llm.ts` clean. (`providers/index.ts` still references the removed `reasoner`; it is deleted in Task 14.)

- [ ] **Step 3: Manual smoke test against OpenAI**

Create a throwaway `scripts/smoke-llm.mjs` is unnecessary; instead verify during Task 10/11 end-to-end. For now confirm the import graph builds:

Run: `npm run build` → Expected: build fails ONLY on `providers/index.ts` (old imports). That file is removed in Task 14; acceptable interim.

- [ ] **Step 4: Commit**

```bash
git add lib/llm.ts && git commit -m "feat: rewrite llm layer on ai-sdk generateObject" || true
```

---

## Task 4: Extract `sanitizeOps` + required test (`lib/sanitize.ts`)

**Files:**
- Create: `lib/sanitize.ts`, `lib/sanitize.test.ts`

**Interfaces:**
- Produces: `sanitizeOps(ops: unknown, opt: { allowTako: boolean; validCardIds?: Set<string> }): CanvasOp[]`.

- [ ] **Step 1: Write the failing test (`lib/sanitize.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { sanitizeOps } from "./sanitize";

const takoNode = (over: any = {}) => ({
  op: "add_node",
  node: { id: "c1", type: "data_card", title: "Rev", grounding: "tako", confidence: 0.9,
    tako: { cardId: "REAL" }, ...over },
});

describe("sanitizeOps", () => {
  it("strips any tako ref from baseline providers and forces grounding=model", () => {
    const out = sanitizeOps([takoNode()], { allowTako: false });
    const n = (out[0] as any).node;
    expect(n.tako).toBeUndefined();
    expect(n.grounding).toBe("model");
  });

  it("drops a hallucinated cardId not fetched this turn and downgrades", () => {
    const out = sanitizeOps([takoNode({ tako: { cardId: "FAKE" } })],
      { allowTako: true, validCardIds: new Set(["REAL"]) });
    const n = (out[0] as any).node;
    expect(n.tako).toBeUndefined();
    expect(n.grounding).toBe("model");
    expect(n.confidence).toBeLessThanOrEqual(0.4);
  });

  it("keeps a real fetched cardId", () => {
    const out = sanitizeOps([takoNode({ tako: { cardId: "REAL" } })],
      { allowTako: true, validCardIds: new Set(["REAL"]) });
    const n = (out[0] as any).node;
    expect(n.tako?.cardId).toBe("REAL");
    expect(n.grounding).toBe("tako");
  });

  it("returns [] for non-array input and skips malformed ops", () => {
    expect(sanitizeOps("nope" as any, { allowTako: false })).toEqual([]);
    expect(sanitizeOps([{ nope: true }], { allowTako: false })).toEqual([]);
  });

  it("backfills confidence and forces position:null", () => {
    const out = sanitizeOps([{ op: "add_node", node: { id: "x", type: "data_card",
      title: "T", grounding: "model" } }], { allowTako: false });
    const n = (out[0] as any).node;
    expect(n.confidence).toBe(0.5);
    expect(n.position).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/sanitize.test.ts` → Expected: FAIL, "Cannot find module './sanitize'".

- [ ] **Step 3: Write `lib/sanitize.ts`**

```ts
import type { CanvasOp } from "./schema";

// Reconciles model output against reality: baselines never carry a Tako ref;
// grounded providers may only reference cardIds actually fetched this turn.
export function sanitizeOps(
  ops: unknown,
  opt: { allowTako: boolean; validCardIds?: Set<string> },
): CanvasOp[] {
  if (!Array.isArray(ops)) return [];
  const out: CanvasOp[] = [];
  for (const op of ops) {
    if (!op || typeof (op as any).op !== "string") continue;
    if (((op as any).op === "add_node" || (op as any).op === "upsert_node") && (op as any).node) {
      const n = (op as any).node;
      if (n.position == null) n.position = null;
      if (n.type === "data_card") {
        if (!opt.allowTako) {
          delete n.tako;
          n.grounding = "model";
        } else if (n.tako && opt.validCardIds && !opt.validCardIds.has(n.tako.cardId)) {
          delete n.tako;
          n.grounding = "model";
          n.confidence = Math.min(typeof n.confidence === "number" ? n.confidence : 0.4, 0.4);
        }
      }
      if (typeof n.confidence !== "number") n.confidence = opt.allowTako && n.tako ? 0.9 : 0.5;
    }
    out.push(op as CanvasOp);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/sanitize.test.ts` → Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/sanitize.ts lib/sanitize.test.ts && git commit -m "feat: extract sanitizeOps with unit tests" || true
```

---

## Task 5: Deterministic consensus (`lib/consensus.ts`) + wire `applyOps`

**Files:**
- Create: `lib/consensus.ts`, `lib/consensus.test.ts`
- Modify: `lib/schema.ts` (wire `recompute_consensus`)

**Interfaces:**
- Produces:
  - `normalize(values: number[]): number[]` — min-max to 0..1 (all-equal → all 1).
  - `computeConsensusRows(state: CanvasState, target: string): ConsensusRow[]`.
  - `recomputeConsensus(state: CanvasState, target: string): CanvasOp[]` — one `update_node` op.
- Consumes: `metric` nodes grouped by `section`; the `criteria` node's `weights`.

- [ ] **Step 1: Write the failing test (`lib/consensus.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { normalize, computeConsensusRows } from "./consensus";
import type { CanvasState } from "./schema";

const state: CanvasState = {
  edges: [],
  nodes: [
    { id: "s-a", type: "entity_section", section: "A", title: "A", grounding: "tako", confidence: 1 },
    { id: "s-b", type: "entity_section", section: "B", title: "B", grounding: "tako", confidence: 1 },
    { id: "m-a", type: "metric", section: "A", title: "Rev A", grounding: "tako", confidence: 1,
      metric: { value: "100", label: "Revenue" } },
    { id: "m-b", type: "metric", section: "B", title: "Rev B", grounding: "tako", confidence: 1,
      metric: { value: "50", label: "Revenue" } },
    { id: "crit", type: "criteria", title: "Criteria", grounding: "model", confidence: 1,
      criteria: { weights: { Revenue: 1 } } },
    { id: "cons", type: "consensus", title: "Verdict", grounding: "model", confidence: 1, consensusRows: [] },
  ],
};

describe("consensus", () => {
  it("normalize maps min→0 and max→1", () => {
    expect(normalize([50, 100])).toEqual([0, 1]);
    expect(normalize([7, 7])).toEqual([1, 1]);
  });

  it("ranks entities deterministically by weighted normalized score", () => {
    const rows = computeConsensusRows(state, "cons");
    expect(rows.map((r) => r.entity)).toEqual(["A", "B"]);
    expect(rows[0].rank).toBe(1);
    expect(rows[1].rank).toBe(2);
  });

  it("is stable across repeated runs", () => {
    expect(computeConsensusRows(state, "cons")).toEqual(computeConsensusRows(state, "cons"));
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/consensus.test.ts` → Expected: FAIL, "Cannot find module './consensus'".

- [ ] **Step 3: Write `lib/consensus.ts`**

```ts
import type { CanvasState, CanvasOp, ConsensusRow } from "./schema";

const num = (s: string): number => {
  const m = String(s).replace(/[^0-9.\-]/g, "");
  const v = parseFloat(m);
  return Number.isFinite(v) ? v : 0;
};

export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

export function computeConsensusRows(state: CanvasState, _target: string): ConsensusRow[] {
  const criteria = state.nodes.find((n) => n.type === "criteria");
  const weights = criteria?.criteria?.weights ?? {};
  const weightKeys = Object.keys(weights);

  // entities = sections that have an entity_section header
  const entities = state.nodes
    .filter((n) => n.type === "entity_section" && n.section)
    .map((n) => n.section as string);
  const uniqueEntities = Array.from(new Set(entities)).sort();

  // metric value per entity per criterion (case-insensitive label match)
  const metricValue = (entity: string, key: string): number => {
    const m = state.nodes.find(
      (n) => n.type === "metric" && n.section === entity &&
        (n.metric?.label ?? "").toLowerCase() === key.toLowerCase(),
    );
    return m?.metric ? num(m.metric.value) : 0;
  };

  // normalize each criterion across entities, then weight+sum
  const perKeyNorm: Record<string, number[]> = {};
  for (const key of weightKeys) {
    perKeyNorm[key] = normalize(uniqueEntities.map((e) => metricValue(e, key)));
  }

  const scored = uniqueEntities.map((entity, i) => {
    let score = 0;
    for (const key of weightKeys) score += (weights[key] ?? 0) * (perKeyNorm[key][i] ?? 0);
    return { entity, score };
  });

  // deterministic: sort by score desc, tie-break by entity name asc
  scored.sort((a, b) => (b.score - a.score) || a.entity.localeCompare(b.entity));

  return scored.map((s, i) => ({
    rank: i + 1,
    entity: s.entity,
    score: Math.round(s.score * 1000) / 1000,
  }));
}

export function recomputeConsensus(state: CanvasState, target: string): CanvasOp[] {
  const rows = computeConsensusRows(state, target);
  return [{ op: "update_node", id: target, patch: { consensusRows: rows } }];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/consensus.test.ts` → Expected: 3 passing.

- [ ] **Step 5: Wire `recompute_consensus` in `applyOps` (`lib/schema.ts`)**

Add near the top of `lib/schema.ts` (after the zod imports):

```ts
import { computeConsensusRows } from "./consensus";
```

Replace the `recompute_consensus` case in `applyOps`:

```ts
      case "recompute_consensus": {
        const rows = computeConsensusRows({ nodes, edges }, op.target);
        const i = nodes.findIndex((n) => n.id === op.target);
        if (i >= 0) nodes[i] = { ...nodes[i], consensusRows: rows };
        break;
      }
```

(`consensus.ts` imports only `type`s from `schema.ts`, so there is no runtime cycle.)

- [ ] **Step 6: Verify build + tests**

Run: `npx vitest run` → Expected: consensus + sanitize green.
Run: `npx tsc --noEmit` → Expected: `lib/schema.ts` and `lib/consensus.ts` clean.

- [ ] **Step 7: Commit**

```bash
git add lib/consensus.ts lib/consensus.test.ts lib/schema.ts && git commit -m "feat: deterministic consensus scoring wired into applyOps" || true
```

---

## Task 6: Deterministic relate + validation (`lib/relate.ts`)

**Files:**
- Create: `lib/relate.ts`, `lib/relate.test.ts`

**Interfaces:**
- Produces:
  - `structuralEdges(state: CanvasState): CanvasEdge[]` — deterministic `feeds`/`sibling`.
  - `validateGraph(state: CanvasState, opts?: { maxDegree?: number }): CanvasState` — dedupe edges, drop edges to missing nodes, cap fan-in to suppress hairballs, guarantee no duplicate ids.
  - `finalizeOps(state: CanvasState, ops: CanvasOp[]): CanvasOp[]` — appends missing structural edges as `add_edge` ops and drops any `add_edge` op the validation rejects. Called by BOTH agents after `sanitizeOps` (Tasks 10, 13).
- Consumes: `graphology`, `applyOps` (schema.ts).

- [ ] **Step 1: Write the failing test (`lib/relate.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { structuralEdges, validateGraph, finalizeOps } from "./relate";
import type { CanvasState } from "./schema";

const base: CanvasState = {
  edges: [],
  nodes: [
    { id: "cons", type: "consensus", role: "consensus", title: "V", grounding: "model", confidence: 1 },
    { id: "e-a", type: "data_card", section: "A", role: "evidence", title: "A", grounding: "tako", confidence: 1 },
    { id: "e-b", type: "data_card", section: "B", role: "evidence", title: "B", grounding: "tako", confidence: 1 },
  ],
};

describe("relate", () => {
  it("feeds every evidence node into the consensus node", () => {
    const edges = structuralEdges(base);
    const feeds = edges.filter((e) => e.kind === "feeds" && e.to === "cons");
    expect(feeds.map((e) => e.from).sort()).toEqual(["e-a", "e-b"]);
  });

  it("dedupes edges and drops edges to missing nodes", () => {
    const dirty: CanvasState = {
      nodes: base.nodes,
      edges: [
        { id: "x", from: "e-a", to: "cons", kind: "feeds" },
        { id: "x", from: "e-a", to: "cons", kind: "feeds" },
        { id: "y", from: "e-a", to: "GHOST", kind: "feeds" },
      ],
    };
    const out = validateGraph(dirty);
    expect(out.edges.map((e) => e.id)).toEqual(["x"]);
  });

  it("finalizeOps appends feeds edges for evidence added by ops", () => {
    const start: CanvasState = { nodes: [base.nodes[0]], edges: [] }; // consensus only
    const ops = [{ op: "add_node" as const, node: base.nodes[1] }]; // add evidence e-a
    const out = finalizeOps(start, ops);
    const edgeOps = out.filter((o) => o.op === "add_edge") as Extract<typeof out[number], { op: "add_edge" }>[];
    expect(edgeOps.map((o) => o.edge.kind)).toContain("feeds");
    expect(out[0]).toEqual(ops[0]); // agent ops preserved, in order
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/relate.test.ts` → Expected: FAIL, "Cannot find module './relate'".

- [ ] **Step 3: Write `lib/relate.ts`**

```ts
import Graph from "graphology";
import type { CanvasState, CanvasEdge, CanvasOp } from "./schema";
import { applyOps } from "./schema";

// Deterministic structural edges: evidence -> consensus (feeds),
// same-metric across entities (sibling). Semantic supports/contradicts are LLM-authored.
export function structuralEdges(state: CanvasState): CanvasEdge[] {
  const edges: CanvasEdge[] = [];
  const consensus = state.nodes.find((n) => n.type === "consensus");
  if (consensus) {
    for (const n of state.nodes) {
      if (n.role === "evidence" || (n.type === "data_card" && n.section)) {
        edges.push({ id: `feeds:${n.id}->${consensus.id}`, from: n.id, to: consensus.id, kind: "feeds" });
      }
    }
  }
  // sibling: same metric label across sections
  const metrics = state.nodes.filter((n) => n.type === "metric" && n.metric?.label);
  const byLabel: Record<string, string[]> = {};
  for (const m of metrics) {
    const key = (m.metric!.label).toLowerCase();
    (byLabel[key] ||= []).push(m.id);
  }
  for (const ids of Object.values(byLabel)) {
    const sorted = [...ids].sort();
    for (let i = 0; i + 1 < sorted.length; i++) {
      edges.push({ id: `sibling:${sorted[i]}~${sorted[i + 1]}`, from: sorted[i], to: sorted[i + 1], kind: "sibling" });
    }
  }
  return edges;
}

// Dedupe by id, drop edges to/from missing nodes, cap fan-in per target (anti-hairball).
export function validateGraph(state: CanvasState, opts: { maxDegree?: number } = {}): CanvasState {
  const maxDegree = opts.maxDegree ?? 12;
  const g = new Graph({ multi: false, type: "directed", allowSelfLoops: false });
  const nodeIds = new Set(state.nodes.map((n) => n.id));
  for (const id of nodeIds) g.addNode(id);

  const seen = new Set<string>();
  const kept: CanvasEdge[] = [];
  const inDegree: Record<string, number> = {};
  for (const e of state.edges) {
    if (seen.has(e.id)) continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    if (e.from === e.to) continue;
    if ((inDegree[e.to] ?? 0) >= maxDegree) continue;
    seen.add(e.id);
    inDegree[e.to] = (inDegree[e.to] ?? 0) + 1;
    kept.push(e);
  }
  return { nodes: state.nodes, edges: kept };
}

// Post-process an agent's ops: preview the resulting board, append the structural
// edges the model didn't emit, then drop any add_edge the validation rejects.
// Deterministic — code owns structure; the model only owns semantic edges.
export function finalizeOps(state: CanvasState, ops: CanvasOp[]): CanvasOp[] {
  const preview = applyOps(state, ops);
  const existing = new Set(preview.edges.map((e) => e.id));
  const structural = structuralEdges(preview).filter((e) => !existing.has(e.id));
  const withStructural: CanvasOp[] = [
    ...ops,
    ...structural.map((edge) => ({ op: "add_edge" as const, edge })),
  ];
  const validated = validateGraph(applyOps(state, withStructural));
  const keptEdges = new Set(validated.edges.map((e) => e.id));
  return withStructural.filter((o) => o.op !== "add_edge" || keptEdges.has(o.edge.id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/relate.test.ts` → Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/relate.ts lib/relate.test.ts && git commit -m "feat: deterministic structural edges + graphology validation" || true
```

---

## Task 7: Tako v3 search + answer client (`lib/tako.ts`)

**Files:**
- Modify: `lib/tako.ts`

**Interfaces:**
- Produces:
  - `takoSearch(text: string, opts?: { count?: number; effort?: "fast" | "instant" }): Promise<TakoCard[]>` — now `POST /api/v3/search`.
  - `takoAnswer(query: string, opts?: { effort?: "fast" | "instant" }): Promise<{ answer: string; cards: TakoCard[] }>` — `POST /api/v1/answer`.
  - `mapCard(c: any): TakoCard` (exported for testing).
  - `TAKO_HOST` default `https://staging.tako.com`.

- [ ] **Step 1: Write the failing test (`lib/tako.test.ts`)**

```ts
import { describe, it, expect } from "vitest";
import { mapCard } from "./tako";

describe("mapCard", () => {
  it("maps a v3 card shape defensively", () => {
    const c = mapCard({
      card_id: "abc", title: "Nvidia Revenue",
      embed_url: "https://e", webpage_url: "https://w", image_url: "https://i",
      sources: [{ source_name: "SEC" }],
      description: "…last updated on Jan 5, 2026.",
    });
    expect(c.cardId).toBe("abc");
    expect(c.source).toBe("SEC");
    expect(c.embedUrl).toBe("https://e");
    expect(c.asOf).toBe("Jan 5, 2026");
  });

  it("returns undefined cardId when absent (filtered by caller)", () => {
    expect(mapCard({ title: "x" }).cardId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tako.test.ts` → Expected: FAIL, `mapCard` not exported.

- [ ] **Step 3: Replace the contents of `lib/tako.ts`**

```ts
// Live Tako REST client (v3 search + v1 answer + graph via agents/tako/graph.ts).
// IMPORTANT: host must be staging.tako.com — staging.trytako.com is Cloudflare-blocked (403).
import type { TakoRef } from "./schema";

const HOST = process.env.TAKO_HOST || "https://staging.tako.com";
const BASE = `${HOST}/api`;
const TIMEOUT_MS = 25_000;

export interface TakoCard extends TakoRef {
  title: string;
  description?: string;
}

export function mapCard(c: any): TakoCard {
  const id = c.card_id || c.cardId || c.pub_id;
  return {
    cardId: id,
    title: c.title || "Untitled",
    description: c.description,
    embedUrl: c.embed_url,
    imageUrl: c.image_url,
    webpageUrl: c.webpage_url,
    source: c.sources?.[0]?.source_name || c.source,
    asOf: extractAsOf(c.description),
  };
}

function extractAsOf(desc?: string): string | undefined {
  if (!desc) return undefined;
  const m = desc.match(/last updated on ([A-Za-z]+ \d{1,2},? \d{4})/i);
  return m ? m[1] : undefined;
}

async function post(path: string, body: unknown): Promise<any> {
  const key = process.env.TAKO_API_KEY;
  if (!key) throw new Error("TAKO_API_KEY not set");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Tako ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let loggedShapeOnce = false;

export async function takoSearch(
  text: string,
  opts: { count?: number; effort?: "fast" | "instant" } = {},
): Promise<TakoCard[]> {
  const data = await post("/v3/search", {
    query: text,
    effort: opts.effort || "fast",
    sources: { data: { count: opts.count ?? 5 } },
  });
  const cards = data?.cards || [];
  if (!loggedShapeOnce && cards[0]) {
    console.log("[tako] v3 card keys:", Object.keys(cards[0]));
    loggedShapeOnce = true;
  }
  return cards.map(mapCard).filter((c: TakoCard) => !!c.cardId);
}

export async function takoAnswer(
  query: string,
  opts: { effort?: "fast" | "instant" } = {},
): Promise<{ answer: string; cards: TakoCard[] }> {
  const data = await post("/v1/answer", { query, effort: opts.effort || "fast" });
  const cards = (data?.cards || []).map(mapCard).filter((c: TakoCard) => !!c.cardId);
  return { answer: typeof data?.answer === "string" ? data.answer : "", cards };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/tako.test.ts` → Expected: 2 passing.

- [ ] **Step 5: Manual live verification against staging**

Run (from repo root, key in `.env.local`):

```bash
set -a; source .env.local; set +a
node --input-type=module -e "
import('./lib/tako.ts').catch(()=>{}); // ts not directly runnable; use curl instead
"
```

Since `.ts` isn't node-runnable directly, verify with curl:

```bash
set -a; source .env.local; set +a
curl -sS -m 30 -X POST -H "X-API-Key: $TAKO_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"NVIDIA revenue annual","effort":"fast","sources":{"data":{"count":3}}}' \
  "${TAKO_HOST:-https://staging.tako.com}/api/v3/search" | head -c 200
```

Expected: `{"cards":[{"card_id":...`.

- [ ] **Step 6: Commit**

```bash
git add lib/tako.ts lib/tako.test.ts && git commit -m "feat: migrate tako client to v3 search + v1 answer, host fix, timeout" || true
```

---

## Task 8: Tako graph client (`lib/agents/tako/graph.ts`)

**Files:**
- Create: `lib/agents/tako/graph.ts`

**Interfaces:**
- Produces:
  - `graphSearch(q: string, opts: { types: "entity" | "metric"; subtype?: string; limit?: number }): Promise<GraphNode[]>`
  - `graphRelated(nodeId: string, opts: { relationType: "entity" | "metric"; q: string; limit?: number }): Promise<GraphItem[]>`
  - types `GraphNode = { id; name; type; subtype?; aliases?: string[]; description? }`, `GraphItem = { id; name; aliases?: string[]; description? }`.
- Notes: results parsed from `results[]` (search) and `relation.items[]` (related) — NOT `results` for related.

- [ ] **Step 1: Write `lib/agents/tako/graph.ts`**

```ts
// Tako graph discovery client. Base must be staging.tako.com (trytako.com is CF-blocked).
const HOST = process.env.TAKO_HOST || "https://staging.tako.com";
const BASE = `${HOST}/api/beta/graph`;
const TIMEOUT_MS = 15_000;

export interface GraphNode { id: string; name: string; type: string; subtype?: string; aliases?: string[]; description?: string; }
export interface GraphItem { id: string; name: string; aliases?: string[]; description?: string; }

async function get(path: string): Promise<any> {
  const key = process.env.TAKO_API_KEY;
  if (!key) throw new Error("TAKO_API_KEY not set");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { "X-API-Key": key }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Tako graph ${res.status} on ${path}: ${(await res.text()).slice(0, 160)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function graphSearch(
  q: string,
  opts: { types: "entity" | "metric"; subtype?: string; limit?: number },
): Promise<GraphNode[]> {
  const p = new URLSearchParams({ q, types: opts.types, limit: String(opts.limit ?? 5) });
  if (opts.subtype && opts.types === "entity") p.set("subtype", opts.subtype);
  const data = await get(`/search?${p.toString()}`);
  return Array.isArray(data?.results) ? data.results : [];
}

export async function graphRelated(
  nodeId: string,
  opts: { relationType: "entity" | "metric"; q: string; limit?: number },
): Promise<GraphItem[]> {
  const p = new URLSearchParams({
    node_id: nodeId, relation_type: opts.relationType, q: opts.q, limit: String(opts.limit ?? 6),
  });
  const data = await get(`/related?${p.toString()}`);
  return Array.isArray(data?.relation?.items) ? data.relation.items : [];
}
```

- [ ] **Step 2: Manual live verification**

```bash
set -a; source .env.local; set +a
H="${TAKO_HOST:-https://staging.tako.com}"
curl -sS -m 15 -H "X-API-Key: $TAKO_API_KEY" "$H/api/beta/graph/search?q=nvidia&types=entity&limit=2" | head -c 200
```

Expected: `{"results":[{"id":"nvidia-...`.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` → Expected: `graph.ts` clean.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/tako/graph.ts && git commit -m "feat: tako graph search/related client" || true
```

---

## Task 9: Shared agent scaffolding (`lib/agents/shared/`)

**Files:**
- Create: `lib/agents/shared/types.ts`, `lib/agents/shared/router.ts`, `lib/agents/shared/ctx.ts`, `lib/agents/shared/schemas.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `TurnTrace`, `TraceFn = (step: Partial<TurnTrace> & { note?: string }) => void`.
  - `router.ts`: `ROUTER` string; `RouteAction = "NEW_BOARD"|"REPLACE"|"AUGMENT"|"REFRAME"|"EXPLAIN"`; `zRouteAction` (zod enum).
  - `ctx.ts`: `ctxBlock(req: AgentRequest): string`.
  - `schemas.ts`: `zAgentBody` (`{ canvasOps, narration, sideReply }`), `zBreakdown`, `zQueries`, `zRoute`.

- [ ] **Step 1: Write `lib/agents/shared/types.ts`**

```ts
import type { ProviderId } from "../../schema";

export type RouteAction = "NEW_BOARD" | "REPLACE" | "AUGMENT" | "REFRAME" | "EXPLAIN";

export interface TurnTrace {
  action: RouteAction;
  provider: ProviderId;
  graph?: { resolved: { query: string; node: string }[]; related: { node: string; items: string[] }[] };
  queries: string[];
  answerUsed?: boolean;
  cards: { id: string; title: string; url: string }[];
  opsApplied: number;
  notes: string[];
  ms: number;
}

export type TraceFn = (step: { stage: string; note?: string; data?: unknown }) => void;
```

- [ ] **Step 2: Write `lib/agents/shared/router.ts`**

```ts
import { z } from "zod";

export const zRouteAction = z.enum(["NEW_BOARD", "REPLACE", "AUGMENT", "REFRAME", "EXPLAIN"]);
export const zRoute = z.object({ action: zRouteAction, reason: z.string() });

export const ROUTER = `Route each message to ONE action, then emit a canvas diff:
NEW_BOARD (fresh investigation), REPLACE (swap existing data — rewire edges, leave untouched nodes+positions),
AUGMENT (add data and connect it), REFRAME (change criteria/ranking only, no new data), EXPLAIN (answer; mutate little).
If a selection is present, prefer EXPLAIN about it or AUGMENT scoped to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.`;
```

- [ ] **Step 3: Write `lib/agents/shared/ctx.ts`**

```ts
import type { AgentRequest } from "../../schema";

export function ctxBlock(req: AgentRequest): string {
  const nodes = req.canvasState.nodes.map((n) => ({
    id: n.id, type: n.type, section: n.section, role: n.role, title: n.title, grounding: n.grounding,
  }));
  return [
    `MESSAGE: ${req.message}`,
    `SURFACE: ${req.surface}`,
    `SELECTION: ${JSON.stringify(req.selection?.nodeIds || [])}`,
    `CURRENT_NODES: ${JSON.stringify(nodes)}`,
    `CURRENT_EDGES: ${JSON.stringify(req.canvasState.edges)}`,
  ].join("\n");
}
```

- [ ] **Step 4: Write `lib/agents/shared/schemas.ts`**

```ts
import { z } from "zod";
import { zCanvasOps } from "../../schema";

// The board-diff body every agent returns (before sanitize/relate/consensus).
export const zAgentBody = z.object({
  canvasOps: zCanvasOps,
  narration: z.string(),
  sideReply: z.string().nullable(),
});
export type AgentBody = z.infer<typeof zAgentBody>;

// Tako pipeline sub-steps
export const zBreakdown = z.object({
  entities: z.array(z.string()),
  metrics: z.array(z.string()),
  subtypes: z.record(z.string()).optional(),
});
export const zQueries = z.object({ queries: z.array(z.string()) });
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit` → Expected: all four files clean.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/shared && git commit -m "feat: shared agent scaffolding (types, router, ctx, schemas)" || true
```

---

## Task 10: Baseline agent (`lib/agents/baseline/`)

**Files:**
- Create: `lib/agents/baseline/prompts.ts`, `lib/agents/baseline/agent.ts`

**Interfaces:**
- Consumes: `generateStructured` (Task 3), `zAgentBody`/`ROUTER`/`ctxBlock` (Task 9), `sanitizeOps` (Task 4), `finalizeOps` (Task 6).
- Produces: `runBaseline(model: "openai" | "anthropic", req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse>`.

- [ ] **Step 1: Write `lib/agents/baseline/prompts.ts`**

```ts
import { ROUTER } from "../shared/router";

export const BASELINE_SYSTEM = `You are the reasoning core of a spatial research canvas, running WITHOUT any data tools.
You have no live data and no retrieval. Answer from your own knowledge only.
When a chart would help, draw it yourself as a chartSpec on a data_card node:
  chartSpec = { kind:"bar"|"line", unit?, series:[{label, points:[{x,y}]}] } using your best remembered numbers.
Every data_card you emit MUST set grounding:"model" and an HONEST confidence (<=0.6), and MUST NOT include a tako ref.
Build entity_section columns, a criteria node with weights, and a consensus node; connect only genuinely related nodes.
${ROUTER}
Return canvasOps (a JSON array of ops), a <=2 sentence narration, and sideReply (string or null).`;
```

- [ ] **Step 2: Write `lib/agents/baseline/agent.ts`**

```ts
import type { AgentRequest, AgentResponse } from "../../schema";
import type { TraceFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { zAgentBody } from "../shared/schemas";
import { BASELINE_SYSTEM } from "./prompts";

export async function runBaseline(
  model: "openai" | "anthropic",
  req: AgentRequest,
  onTrace?: TraceFn,
): Promise<AgentResponse> {
  onTrace?.({ stage: "routing", note: `baseline:${model}` });
  const body = await generateStructured({
    provider: model,
    system: BASELINE_SYSTEM,
    prompt: ctxBlock(req),
    schema: zAgentBody,
  });
  onTrace?.({ stage: "laying out", note: `${body.canvasOps.length} ops` });
  const ops = finalizeOps(req.canvasState, sanitizeOps(body.canvasOps, { allowTako: false }));
  return { canvasOps: ops, narration: body.narration, sideReply: body.sideReply };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` → Expected: baseline files clean.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/baseline && git commit -m "feat: baseline agent on ai-sdk with strict schema" || true
```

---

## Task 11: Tako initial-research pipeline (`lib/agents/tako/pipeline.ts` + prompts)

**Files:**
- Create: `lib/agents/tako/prompts.ts`, `lib/agents/tako/pipeline.ts`

**Interfaces:**
- Consumes: `graphSearch`/`graphRelated` (Task 8), `takoSearch` (Task 7), `generateStructured` (Task 3), `zBreakdown`/`zQueries`/`zAgentBody` (Task 9), `sanitizeOps` (Task 4).
- Produces: `runTakoInitial(req: AgentRequest, onTrace?: TraceFn): Promise<{ body: AgentBody; validCardIds: Set<string>; trace: Partial<TurnTrace> }>`.

- [ ] **Step 1: Write `lib/agents/tako/prompts.ts`**

```ts
import { ROUTER } from "../shared/router";

export const BREAKDOWN_SYSTEM = `You break a research question into parts for the Tako graph.
Return { entities: string[], metrics: string[], subtypes?: {name:type} }.
- entities = the concrete things to compare (companies, countries, indices). Resolve a cohort ("top 5 chip makers") into concrete names.
- metrics = the measures the question needs (e.g. "Revenue", "P/E", "unemployment rate").
- subtypes = disambiguation for ambiguous entity names (e.g. {"Georgia":"Countries"}).
Prefer a handful, not an exhaustive list.`;

export const COMPOSE_SYSTEM = `You write Tako /v3/search queries grounded in resolved graph nodes.
You are given RESOLVED (entity/metric names + aliases + descriptions). Write one short search query per
data point you need, using the resolved names/aliases (a metric aliased "inflation" IS the inflation metric).
Also include entity-level queries where no specific metric fits (rankings, prices, overviews).
Return { queries: string[] } — deduped, <= 10.`;

export const SYNTH_SYSTEM = `You are the reasoning core of a spatial research canvas grounded in Tako structured data.
${ROUTER}
Build the board from AVAILABLE_CARDS ONLY: for each card create a data_card node, copy the tako ref verbatim
(cardId, embedUrl, imageUrl, webpageUrl, source, asOf) and set grounding:"tako". Never invent a cardId or number.
Create one entity_section per entity (nodes share its section), one criteria node with weights, one consensus node.
For any part you could not ground, add a text node stating the gap ("Tako has X and Y, not Z").
Return canvasOps, a <=2 sentence narration, and sideReply (usually null on NEW_BOARD).`;
```

- [ ] **Step 2: Write `lib/agents/tako/pipeline.ts`**

```ts
import type { AgentRequest } from "../../schema";
import type { TraceFn, TurnTrace } from "../shared/types";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zAgentBody, zBreakdown, zQueries, type AgentBody } from "../shared/schemas";
import { graphSearch, graphRelated, type GraphNode } from "./graph";
import { takoSearch, type TakoCard } from "../../tako";
import { BREAKDOWN_SYSTEM, COMPOSE_SYSTEM, SYNTH_SYSTEM } from "./prompts";

const OPENAI = "openai" as const; // tako agent is fixed to gpt-5.4-mini via OPENAI_MODEL

export async function runTakoInitial(
  req: AgentRequest,
  onTrace?: TraceFn,
): Promise<{ body: AgentBody; validCardIds: Set<string>; trace: Partial<TurnTrace> }> {
  const notes: string[] = [];
  const resolved: { query: string; node: string }[] = [];
  const related: { node: string; items: string[] }[] = [];

  // 1) breakdown
  onTrace?.({ stage: "planning queries" });
  const breakdown = await generateStructured({
    provider: OPENAI, system: BREAKDOWN_SYSTEM, prompt: ctxBlock(req), schema: zBreakdown,
  });

  // 2) resolve + related (graph); degrade gracefully on error
  const resolvedInfo: string[] = [];
  try {
    for (const name of breakdown.entities.slice(0, 6)) {
      const nodes = await graphSearch(name, { types: "entity", subtype: breakdown.subtypes?.[name] });
      const node: GraphNode | undefined = nodes[0];
      if (!node) { notes.push(`No graph node for "${name}"`); continue; }
      resolved.push({ query: name, node: node.name });
      const topic = breakdown.metrics[0] || "overview";
      const items = await graphRelated(node.id, { relationType: "metric", q: topic });
      related.push({ node: node.name, items: items.map((i) => i.name) });
      resolvedInfo.push(`${node.name}: ${items.slice(0, 5).map((i) => `${i.name} [${(i.aliases || []).join(", ")}]`).join("; ")}`);
    }
    onTrace?.({ stage: `resolved ${resolved.length} graph nodes` });
  } catch (e: any) {
    notes.push(`graph unavailable — grounding on v3/search only (${e?.message ?? e})`);
  }

  // 3) compose grounded queries
  const composePrompt = `${ctxBlock(req)}\n\nRESOLVED:\n${resolvedInfo.join("\n") || "(none — compose from the question directly)"}`;
  const composed = await generateStructured({
    provider: OPENAI, system: COMPOSE_SYSTEM, prompt: composePrompt, schema: zQueries,
  });
  const queries = Array.from(new Set(composed.queries.map((q) => q.trim().toLowerCase())))
    .map((q) => q).slice(0, 10);

  // 4) search concurrently, keep top card per query
  const settled = await Promise.allSettled(queries.map((q) => takoSearch(q, { effort: "fast", count: 3 })));
  const cards: TakoCard[] = [];
  settled.forEach((s) => { if (s.status === "fulfilled" && s.value[0]) cards.push(s.value[0]); });
  onTrace?.({ stage: `fetched ${cards.length} Tako cards` });
  if (cards.length === 0) notes.push("No structured data returned for this query.");

  const cardMenu = cards.map((c) => ({
    cardId: c.cardId, title: c.title, description: c.description,
    source: c.source, asOf: c.asOf, embedUrl: c.embedUrl, imageUrl: c.imageUrl, webpageUrl: c.webpageUrl,
  }));

  // 5) synthesize board from cards only
  onTrace?.({ stage: "laying out" });
  const body = await generateStructured({
    provider: OPENAI, system: SYNTH_SYSTEM,
    prompt: `${ctxBlock(req)}\n\nAVAILABLE_CARDS: ${JSON.stringify(cardMenu)}`,
    schema: zAgentBody,
  });

  const validCardIds = new Set(cards.map((c) => c.cardId));
  return {
    body,
    validCardIds,
    trace: {
      graph: { resolved, related },
      queries,
      cards: cards.map((c) => ({ id: c.cardId, title: c.title, url: c.webpageUrl || "" })),
      notes,
    },
  };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` → Expected: pipeline + prompts clean.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/tako/pipeline.ts lib/agents/tako/prompts.ts && git commit -m "feat: tako initial-research graph pipeline" || true
```

---

## Task 12: Tako follow-up flow (`lib/agents/tako/followup.ts`)

**Files:**
- Modify: `lib/agents/tako/prompts.ts` (add follow-up prompt)
- Create: `lib/agents/tako/followup.ts`

**Interfaces:**
- Consumes: `takoAnswer` (Task 7), `generateStructured` (Task 3), `zAgentBody` (Task 9).
- Produces: `runTakoFollowup(req, onTrace?): Promise<{ body: AgentBody; validCardIds: Set<string>; trace: Partial<TurnTrace> }>`.

- [ ] **Step 1: Append the follow-up prompt to `lib/agents/tako/prompts.ts`**

```ts
export const FOLLOWUP_SYSTEM = `You answer a follow-up on a spatial research canvas grounded in Tako.
You are given a TAKO_ANSWER (grounded prose) and ANSWER_CARDS (real Tako cards) fetched for this question.
- If the surface is side_chat or the action is EXPLAIN: put the answer in sideReply; optionally attach ONE
  answer card as a data_card (grounding:"tako", copy the ref verbatim) with a supporting edge to the discussed node.
- If AUGMENT: add the answer cards as data_card nodes near the selection and connect them.
- If REPLACE: swap the affected data_card(s) using the answer cards; leave untouched nodes and positions alone.
Never invent a cardId or number. Return canvasOps, a <=2 sentence narration, and sideReply.`;
```

- [ ] **Step 2: Write `lib/agents/tako/followup.ts`**

```ts
import type { AgentRequest } from "../../schema";
import type { TraceFn, TurnTrace } from "../shared/types";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zAgentBody, type AgentBody } from "../shared/schemas";
import { takoAnswer } from "../../tako";
import { FOLLOWUP_SYSTEM } from "./prompts";

const OPENAI = "openai" as const;

export async function runTakoFollowup(
  req: AgentRequest,
  onTrace?: TraceFn,
): Promise<{ body: AgentBody; validCardIds: Set<string>; trace: Partial<TurnTrace> }> {
  const notes: string[] = [];
  onTrace?.({ stage: "asking Tako" });
  let answer = "";
  let cards: { cardId: string; title: string; webpageUrl?: string }[] = [];
  try {
    const res = await takoAnswer(req.message, { effort: "fast" });
    answer = res.answer;
    cards = res.cards.map((c) => ({ cardId: c.cardId, title: c.title, webpageUrl: c.webpageUrl }));
  } catch (e: any) {
    notes.push(`Tako Answer unavailable (${e?.message ?? e})`);
  }
  onTrace?.({ stage: `Tako answered with ${cards.length} cards` });

  const body = await generateStructured({
    provider: OPENAI, system: FOLLOWUP_SYSTEM,
    prompt: `${ctxBlock(req)}\n\nTAKO_ANSWER: ${answer || "(none)"}\n\nANSWER_CARDS: ${JSON.stringify(cards)}`,
    schema: zAgentBody,
  });

  const validCardIds = new Set(cards.map((c) => c.cardId));
  return {
    body,
    validCardIds,
    trace: {
      queries: [req.message],
      answerUsed: true,
      cards: cards.map((c) => ({ id: c.cardId, title: c.title, url: c.webpageUrl || "" })),
      notes,
    },
  };
}
```

- [ ] **Step 3: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add lib/agents/tako/followup.ts lib/agents/tako/prompts.ts && git commit -m "feat: tako follow-up flow via Tako Answer" || true
```

---

## Task 13: Tako orchestrator (`lib/agents/tako/agent.ts`)

**Files:**
- Create: `lib/agents/tako/agent.ts`

**Interfaces:**
- Consumes: `runTakoInitial` (Task 11), `runTakoFollowup` (Task 12), `zRoute`/`ROUTER` (Task 9), `sanitizeOps` (Task 4), `finalizeOps` (Task 6), `generateStructured` (Task 3).
- Produces: `runTako(req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse>`.

- [ ] **Step 1: Write `lib/agents/tako/agent.ts`**

```ts
import type { AgentRequest, AgentResponse } from "../../schema";
import type { TraceFn } from "../shared/types";
import { generateStructured } from "../../llm";
import { sanitizeOps } from "../../sanitize";
import { finalizeOps } from "../../relate";
import { ctxBlock } from "../shared/ctx";
import { ROUTER, zRoute } from "../shared/router";
import { runTakoInitial } from "./pipeline";
import { runTakoFollowup } from "./followup";

const OPENAI = "openai" as const;

export async function runTako(req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse> {
  // Route first (fast, cheap).
  onTrace?.({ stage: "routing" });
  const hasBoard = req.canvasState.nodes.length > 0;
  const route = await generateStructured({
    provider: OPENAI,
    system: `${ROUTER}\nReturn { action, reason }.`,
    prompt: ctxBlock(req),
    schema: zRoute,
  });
  // NEW_BOARD when empty board regardless of model guess.
  const action = hasBoard ? route.action : "NEW_BOARD";

  const isFollowup = action === "EXPLAIN" || action === "AUGMENT" || action === "REPLACE";
  const { body, validCardIds, trace } = isFollowup
    ? await runTakoFollowup(req, onTrace)
    : await runTakoInitial(req, onTrace);

  const ops = finalizeOps(req.canvasState, sanitizeOps(body.canvasOps, { allowTako: true, validCardIds }));
  return {
    canvasOps: ops,
    narration: body.narration,
    sideReply: body.sideReply,
    trace: { action, provider: "tako", queries: [], cards: [], opsApplied: ops.length, notes: [], ms: 0, ...trace } as any,
  };
}
```

(REFRAME is handled deterministically at apply-time via `recompute_consensus`; the model still emits the criteria `update_node` through the follow-up/initial body when weights are described in text. Slider-driven REFRAME arrives in Stage 2.)

- [ ] **Step 2: Type-check + commit**

Run: `npx tsc --noEmit` → Expected: clean.

```bash
git add lib/agents/tako/agent.ts && git commit -m "feat: tako orchestrator routing initial vs follow-up" || true
```

---

## Task 14: Typed provider registry (`lib/providers/registry.ts`)

**Files:**
- Create: `lib/providers/registry.ts`
- Delete: `lib/providers/index.ts`

**Interfaces:**
- Produces:
  - `ProviderCapabilities`, `ProviderDef`, `PROVIDERS: Record<ProviderId, ProviderDef>`.
  - `runProvider(req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse>`.

- [ ] **Step 1: Write `lib/providers/registry.ts`**

```ts
import type { AgentRequest, AgentResponse, ProviderId } from "../schema";
import type { TraceFn } from "../agents/shared/types";
import { runBaseline } from "../agents/baseline/agent";
import { runTako } from "../agents/tako/agent";

export interface ProviderCapabilities {
  structured_cards: boolean;
  tako_search: boolean;
  tako_graph: boolean;
  tako_answer: boolean;
  web_search: boolean;
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  run: (req: AgentRequest, onTrace?: TraceFn) => Promise<AgentResponse>;
}

const NO_TAKO: ProviderCapabilities = {
  structured_cards: false, tako_search: false, tako_graph: false, tako_answer: false, web_search: false,
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  gpt: { id: "gpt", label: "GPT", capabilities: NO_TAKO, run: (r, t) => runBaseline("openai", r, t) },
  claude: { id: "claude", label: "Claude", capabilities: NO_TAKO, run: (r, t) => runBaseline("anthropic", r, t) },
  tako: {
    id: "tako", label: "LLM + Tako",
    capabilities: { structured_cards: true, tako_search: true, tako_graph: true, tako_answer: true, web_search: false },
    run: (r, t) => runTako(r, t),
  },
};

export function runProvider(req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse> {
  const def = PROVIDERS[req.providerId] ?? PROVIDERS.tako;
  return def.run(req, onTrace);
}
```

- [ ] **Step 2: Delete the old seam**

```bash
rm lib/providers/index.ts
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit` → Expected: only `app/page.tsx` (old providerId strings) and `app/api/agent/route.ts` remain — fixed next.

- [ ] **Step 4: Commit**

```bash
git add lib/providers/registry.ts && git rm lib/providers/index.ts 2>/dev/null; git commit -m "feat: typed provider registry (gpt/claude/tako)" || true
```

---

## Task 15: Streaming API route (`app/api/agent/route.ts`)

**Files:**
- Modify: `app/api/agent/route.ts`

**Interfaces:**
- Consumes: `runProvider` (Task 14).
- Produces: an NDJSON stream — zero or more `{"type":"trace", ...}` lines, then one final `{"type":"result", canvasOps, narration, sideReply, trace}` line. On error, a single `{"type":"error", error}` line.

- [ ] **Step 1: Replace `app/api/agent/route.ts`**

```ts
import type { AgentRequest } from "@/lib/schema";
import { runProvider } from "@/lib/providers/registry";
import type { TurnTrace } from "@/lib/agents/shared/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<AgentRequest>;
  if (!body.message) {
    return new Response(JSON.stringify({ type: "error", error: "message required" }), { status: 400 });
  }
  const request: AgentRequest = {
    canvasId: body.canvasId || "default",
    message: body.message,
    surface: body.surface || "main",
    canvasState: body.canvasState || { nodes: [], edges: [] },
    selection: body.selection,
    providerId: body.providerId || "tako",
    takoAnswerEnabled: body.takoAnswerEnabled ?? true,
  };

  const started = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await runProvider(request, (step) =>
          send({ type: "trace", stage: step.stage, note: step.note }));
        const trace = (result.trace ?? {}) as TurnTrace;
        trace.ms = Date.now() - started;
        send({ type: "result", canvasOps: result.canvasOps, narration: result.narration, sideReply: result.sideReply, trace });
      } catch (e: any) {
        send({ type: "error", error: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit` → Expected: route clean.

- [ ] **Step 3: Commit**

```bash
git add app/api/agent/route.ts && git commit -m "feat: NDJSON streaming agent route with trace events" || true
```

---

## Task 16: Wire the client + cleanup (`app/page.tsx`, `.env.example`)

**Files:**
- Modify: `app/page.tsx`, `.env.example`
- Delete: stray `{lib` directory

**Interfaces:**
- Consumes: the NDJSON stream from Task 15.
- Produces: a working 3-provider UI (existing look preserved; full redesign is Stage 2).

- [ ] **Step 1: Update the provider list + type in `app/page.tsx`**

Find the `Provider` type (line ~7) and `PROVIDERS` array (lines ~8–13). Replace with:

```tsx
type Provider = "gpt" | "claude" | "tako";
const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "tako", label: "LLM + Tako" },
  { id: "gpt", label: "GPT" },
  { id: "claude", label: "Claude" },
];
```

Update the default provider state (line ~53) to `useState<Provider>("tako")`.

- [ ] **Step 2: Replace the fetch/apply block in `send` to read the NDJSON stream**

Replace the body of `send` after building `body` (the `fetch` + `res.json()` + `applyOps` section) with:

```tsx
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          canvasId: "default", message: text, surface,
          canvasState: state,
          selection: { nodeIds: selection, nodes: selection.map((id) => nodeById[id]).filter(Boolean) },
          providerId: provider, takoAnswerEnabled: takoAnswer,
        }),
      });
      if (!res.body) throw new Error("no response stream");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const evt = JSON.parse(line);
          if (evt.type === "trace") {
            setLoadingStage(evt.stage as string);
          } else if (evt.type === "error") {
            setError(evt.error);
          } else if (evt.type === "result") {
            if (evt.canvasOps?.length) setState((s) => applyOps(s, evt.canvasOps));
            if (surface === "main") setMainLog((l) => [...l, { role: "agent", text: evt.narration || "" }]);
            if (evt.sideReply) setSideLog((l) => [...l, { role: "agent", text: evt.sideReply }]);
            setLastTrace(evt.trace);
          }
        }
      }
```

Add the supporting state near the other `useState`s:

```tsx
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [lastTrace, setLastTrace] = useState<any>(null);
```

(Show `loadingStage` wherever the current loading text renders. `lastTrace` powers the Stage 3 Trace panel; storing it now is harmless.)

- [ ] **Step 3: Update `.env.example` host**

Change the Tako block to:

```
# Tako (structured data) — STAGING. Get a staging token at https://developer.staging.tako.com
TAKO_API_KEY=
# Staging host. MUST be staging.tako.com — staging.trytako.com is Cloudflare-blocked (403).
TAKO_HOST=https://staging.tako.com
```

- [ ] **Step 4: Delete the stray garbage directory**

```bash
rm -rf '{lib'
```

- [ ] **Step 5: Verify build + full run**

Run: `npx tsc --noEmit` → Expected: clean across the repo.
Run: `npm run build` → Expected: green.
Run: `npm run dev`, open http://localhost:3000, send the seeded semiconductor prompt with provider `tako` → Expected: loading stages update ("routing" → "planning queries" → "resolved N graph nodes" → "fetched N Tako cards" → "laying out"), a board of cited cards appears. Switch to `gpt` → a thinner amber board with no Tako refs.

- [ ] **Step 6: Commit**

```bash
git add app/page.tsx .env.example && git commit -m "feat: wire client to 3 providers + NDJSON stream; cleanup" || true
```

---

## Task 17: Living docs — architecture diagrams, CLAUDE.md, README

**Files:**
- Create: `docs/agents-architecture.md`, `CLAUDE.md`
- Modify: `README.md`

**Interfaces:**
- Produces: the 4 Mermaid decision-tree diagrams; a findings log; updated README.

- [ ] **Step 1: Create `docs/agents-architecture.md`** with the four Mermaid diagrams

Copy the four `mermaid` blocks verbatim from the design spec §2 (Tako initial, Tako follow-up) and §3 (Baseline initial, Baseline follow-up), each under a `##` heading, plus a one-paragraph intro naming the 3 providers and the "tree identical across providers, only fidelity changes" principle.

- [ ] **Step 2: Create root `CLAUDE.md`** with the findings discovered this stage

```markdown
# canvas-tako — working notes for agents

## Tako API (verified 2026-07-06)
- **Host MUST be `staging.tako.com`.** `staging.trytako.com` is Cloudflare-blocked (403 on /api/*).
- Staging has its OWN key namespace: prod `tako.com` keys 401 on staging and vice-versa.
- Search: `POST /api/v3/search` `{query, effort, sources:{data:{count}}}` → `{cards:[{card_id,title,embed_url,webpage_url,image_url,sources,card_type,...}]}`.
- Answer: `POST /api/v1/answer` `{query, effort}` → `{answer, cards:[...]}` (grounded prose + citable cards).
- Graph: `GET /api/beta/graph/search?q&types=entity|metric[&subtype]` → `{results:[...]}`;
  `GET /api/beta/graph/related?node_id&relation_type&q` → items live in **`relation.items`** (NOT `results`).
  Always pass `q` on related (unfiltered = tens of thousands of items).
- Card embeds post height via a `tako::resize` postMessage — do not hard-code iframe heights.

## Providers
- Three only: `gpt`, `claude` (baselines, no tools), `tako` (grounded, fixed to gpt-5.4-mini).
- NEVER call `tako_agent` or `tako_visualize`: cohort resolution via graph + LLM; consensus via `lib/consensus.ts`.

## Stack
- LLM layer = Vercel AI SDK `generateObject` + Zod schemas (structural validation, no JSON salvage).
- `ai@4` chosen for React 18.3 / Next 14.2 compatibility (server-only path avoids the React-19 UI hooks).
```

- [ ] **Step 3: Update `README.md`**

Update the "Extend next" / features section to reflect: the 3-provider set, the graph-first Tako pipeline + Tako Answer follow-ups, deterministic consensus, the `TAKO_HOST=staging.tako.com` fix, and the new deps (ai-sdk, zod, graphology, vitest). Add a "Run tests: `npm test`" line.

- [ ] **Step 4: Verify + commit**

Run: `npm test` → Expected: sanitize + consensus + relate + tako green.
Run: `npm run build` → Expected: green.

```bash
git add docs/agents-architecture.md CLAUDE.md README.md && git commit -m "docs: agent architecture diagrams, findings log, README" || true
```

---

## Self-Review

**Spec coverage (Stage 1 scope):**
- 3-provider registry + capabilities → Task 14. ✓
- Prompts one file per agent → Tasks 10, 11, 12 (`baseline/prompts.ts`, `tako/prompts.ts`). ✓
- Graph pipeline (host fix, v3 migration, graph clients) → Tasks 7, 8, 11. ✓
- Tako Answer follow-ups → Task 12. ✓
- Deterministic consensus + relate + normalization → Tasks 5, 6; structural edges + validation wired into BOTH agents via `finalizeOps` (Tasks 10, 13). ✓
- Trace + streaming route → Tasks 9 (TurnTrace), 15. ✓
- sanitizeOps extracted + test → Task 4. ✓
- AI SDK + Zod strict schemas → Tasks 2, 3, 9. ✓
- No tako_agent/tako_visualize; grounding tree identical across providers → enforced in prompts (Tasks 10–12) + registry capabilities (Task 14). ✓
- Living docs → Task 17. ✓
- Deferred to later stages (correctly): xyflow canvas, node/edge/section redesign, criteria sliders, sessions/zustand, comparison mode, motion, skeletons, command palette (Stages 2–5).

**Placeholder scan:** No "TBD"/"handle errors appropriately" — every code step has complete code. ✓

**Type consistency:** `AgentBody` (`{canvasOps,narration,sideReply}`) is produced by every agent and consumed by orchestrator/registry; `TurnTrace`/`TraceFn` defined once (Task 9) and used in Tasks 10–15; `runProvider(req, onTrace?)` signature consistent Tasks 14–15; `sanitizeOps` signature consistent Tasks 4, 10, 13; `validCardIds: Set<string>` consistent Tasks 11–13. ✓

**Risk notes for the executor:**
- `ai`/`@ai-sdk/*` major versions move fast; if `generateObject`'s signature differs from Task 3, adapt the wrapper only — callers use `generateStructured`, so the blast radius is one file.
- If Anthropic `generateObject` rejects the discriminated-union schema, fall back to a `zAgentBody` variant using `z.array(z.any())` for ops + re-validate with `zCanvasOps.safeParse` inside `generateStructured`; keep the strict path for OpenAI.
- Commits use `|| true` because the repo is not currently git-initialized; if `git init` is desired, do it before Task 1.

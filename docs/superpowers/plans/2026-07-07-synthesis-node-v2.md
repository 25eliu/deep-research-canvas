# Top-Level Synthesis Node v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the top-level synthesis node a gap-analysis → one-round gap-fill loop, a reusable leaf research flow, an agentic GPT composer with on-demand Tako card contents, and four new question-shaped report block kinds with polished React components.

**Architecture:** The deterministic pipeline (`runTakoInitial`) grows two stages between the research tree and the composer: `analyzeGaps`/`runGapRound` (new `gaps.ts`) and the composer's gather phase (tool loop via new `generateWithTools`). The leaf machinery is extracted verbatim from `research.ts` into a reusable `flow.ts` that both the tree and the gap round call. The composer is GPT-only (deep model, high reasoning), fetches card CSVs through a `get_card_contents` tool, and emits an `AnswerReport` whose block union gains `comparison | leaderboard | sections | timeline`, all validated against gathered figures plus CSV-derived values.

**Tech Stack:** Next.js 14.2 / React 18.3, TypeScript 5.5, Vercel AI SDK `ai@4` (`generateText` tool loop, `generateObject`), Zod 3, Vitest 2 (+ jsdom & @testing-library/react for the new component tests).

**Spec:** `docs/superpowers/specs/2026-07-07-synthesis-node-design.md`

## Global Constraints

- All top-level LLM calls use OpenAI. Deep model = `process.env.SYNTH_MODEL || "gpt-5.4"` with `reasoningEffort: "high"`. Claude/Anthropic is REMOVED from `compose.ts`.
- The OpenAI provider must keep `structuredOutputs: false` (Zod `.optional()` fields break strict mode — see CLAUDE.md). Do NOT rewrite schemas to all-required.
- Gap round: ONE round, max 4 gaps, gap nodes count against `TOTAL_RESEARCH_CAP` (20).
- Composer contents budget: +8 fetches of headroom (`COMPOSER_CONTENTS_BUDGET = 8`) on top of the turn's `CONTENTS_CAP`; tool loop `maxSteps: 10`.
- Behavior-preserving refactors must keep every existing test green (`npm test`).
- Existing block kinds (`prose | table | chart | tiles`) keep working — new kinds are pure additions to the discriminated union.
- Commit format: `<type>: <description>` (feat/fix/refactor/test/chore). No attribution footer.
- graphology / canvas-op invariants and Tako API rules in `CLAUDE.md` apply throughout.
- Run tests with `npx vitest run <file>` (or `npm test` for the full suite).

---

### Task 1: Four new AnswerBlock kinds in the shared schema

**Files:**
- Modify: `lib/schema.ts` (zAnswerBlock union, ~line 51)
- Test: `lib/agents/shared/schemas.test.ts` (append)

**Interfaces:**
- Consumes: existing `zChartSpec` (defined above in the same file).
- Produces: `zAnswerBlock` accepts `{kind:"comparison"}`, `{kind:"leaderboard"}`, `{kind:"sections"}`, `{kind:"timeline"}` shapes exactly as below. `AnswerBlock` TS type widens automatically via `z.infer`. Later tasks (3, 8, 10–13) rely on these exact property names.

- [ ] **Step 1: Write the failing tests**

Append to `lib/agents/shared/schemas.test.ts`:

```ts
import { zAnswerBlock } from "./schemas";

describe("zAnswerBlock — new question-shaped kinds", () => {
  it("accepts a comparison block", () => {
    const b = {
      kind: "comparison", title: "Revenue", unit: "USD",
      series: [
        { label: "Nvidia", entity: "Nvidia", points: [{ x: "2023", y: 27 }, { x: "2024", y: 61 }] },
        { label: "AMD", entity: "AMD", points: [{ x: "2023", y: 23 }, { x: "2024", y: 26 }] },
      ],
      insight: "Nvidia pulled away in 2024.",
    };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("accepts a leaderboard block with optional expandable detail", () => {
    const b = {
      kind: "leaderboard", metricLabel: "Market cap",
      rows: [
        { rank: 1, entity: "Nvidia", value: "$3.4T", delta: "+12%",
          detail: { md: "Dominates AI accelerators.", stats: [{ label: "Revenue", value: "$75.2B" }] } },
        { rank: 2, entity: "AMD", value: "$0.3T" },
      ],
    };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("accepts a sections block", () => {
    const b = {
      kind: "sections",
      sections: [{ title: "Rates", md: "Higher for longer.", figure: { label: "Fed funds", value: "5.5%" } }],
    };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("accepts a timeline block", () => {
    const b = { kind: "timeline", events: [{ date: "2024-03", title: "Blackwell announced", value: "$30B" }] };
    expect(zAnswerBlock.safeParse(b).success).toBe(true);
  });
  it("rejects empty series/rows/sections/events", () => {
    expect(zAnswerBlock.safeParse({ kind: "comparison", series: [] }).success).toBe(false);
    expect(zAnswerBlock.safeParse({ kind: "leaderboard", metricLabel: "x", rows: [] }).success).toBe(false);
    expect(zAnswerBlock.safeParse({ kind: "sections", sections: [] }).success).toBe(false);
    expect(zAnswerBlock.safeParse({ kind: "timeline", events: [] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/shared/schemas.test.ts`
Expected: FAIL — the new kinds are not in the union (`invalid_union_discriminator`).

- [ ] **Step 3: Add the four kinds to `zAnswerBlock` in `lib/schema.ts`**

Replace the existing `zAnswerBlock` definition with:

```ts
export const zAnswerBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prose"), md: z.string() }),
  z.object({ kind: z.literal("table"), columns: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ kind: z.literal("chart"), title: z.string().optional(), chartSpec: zChartSpec }),
  z.object({ kind: z.literal("tiles"), tiles: z.array(z.object({ label: z.string(), value: z.string(), delta: z.string().optional() })) }),
  // Multi-entity comparison built from REAL card CSVs (composer fetches via get_card_contents).
  z.object({
    kind: z.literal("comparison"),
    title: z.string().optional(),
    unit: z.string().optional(),
    series: z.array(z.object({
      label: z.string(),
      entity: z.string(),
      points: z.array(z.object({ x: z.union([z.string(), z.number()]), y: z.number() })),
    })).min(1),
    insight: z.string().optional(),
  }),
  // Ranked entities for "top XYZ" questions; detail = expandable row body.
  z.object({
    kind: z.literal("leaderboard"),
    title: z.string().optional(),
    metricLabel: z.string(),
    rows: z.array(z.object({
      rank: z.number(),
      entity: z.string(),
      value: z.string(),
      delta: z.string().optional(),
      detail: z.object({
        md: z.string(),
        stats: z.array(z.object({ label: z.string(), value: z.string() })).optional(),
      }).optional(),
    })).min(1),
  }),
  // One titled section per factor/driver for "what's affecting X" questions.
  z.object({
    kind: z.literal("sections"),
    sections: z.array(z.object({
      title: z.string(),
      md: z.string(),
      figure: z.object({ label: z.string(), value: z.string(), delta: z.string().optional() }).optional(),
      chartSpec: zChartSpec.optional(),
    })).min(1),
  }),
  // Dated milestones for "how did X evolve" questions.
  z.object({
    kind: z.literal("timeline"),
    events: z.array(z.object({
      date: z.string(),
      title: z.string(),
      md: z.string().optional(),
      value: z.string().optional(),
    })).min(1),
  }),
]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/agents/shared/schemas.test.ts` → PASS. Then `npm test` — everything else must stay green.

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts lib/agents/shared/schemas.test.ts
git commit -m "feat: add comparison/leaderboard/sections/timeline answer block kinds"
```

---

### Task 2: zGapPlan schema

**Files:**
- Modify: `lib/agents/shared/schemas.ts`
- Test: `lib/agents/shared/schemas.test.ts` (append)

**Interfaces:**
- Produces: `zGapPlan` + `type GapPlan = z.infer<typeof zGapPlan>` — `{ sufficient: boolean, rationale: string, gaps: { question, entity, metric, why }[] }`. Task 6 consumes it.

- [ ] **Step 1: Write the failing tests**

Append to `lib/agents/shared/schemas.test.ts`:

```ts
import { zGapPlan } from "./schemas";

describe("zGapPlan — gap-analysis output", () => {
  const gap = { question: "amd revenue", entity: "AMD", metric: "Revenue", why: "missing comparison half" };
  it("accepts sufficient with empty gaps, and a gap list", () => {
    expect(zGapPlan.safeParse({ sufficient: true, rationale: "covered", gaps: [] }).success).toBe(true);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "one side missing", gaps: [gap] }).success).toBe(true);
  });
  it("rejects a gap missing its entity/metric pair or with empty strings", () => {
    const { metric: _m, ...noMetric } = gap;
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [noMetric] }).success).toBe(false);
    expect(zGapPlan.safeParse({ sufficient: false, rationale: "r", gaps: [{ ...gap, entity: "" }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/agents/shared/schemas.test.ts` → FAIL (no export `zGapPlan`).

- [ ] **Step 3: Implement in `lib/agents/shared/schemas.ts`**

```ts
// Gap-analysis output: what the evidence review says is still missing before the
// final report can answer decisively. Each gap is a ready-to-run lookup PAIR.
export const zGapPlan = z.object({
  sufficient: z.boolean(),
  rationale: z.string(),
  gaps: z.array(z.object({
    question: z.string().min(1),
    entity: z.string().min(1),
    metric: z.string().min(1),
    why: z.string(),
  })),
});
export type GapPlan = z.infer<typeof zGapPlan>;
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run lib/agents/shared/schemas.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/schemas.ts lib/agents/shared/schemas.test.ts
git commit -m "feat: zGapPlan schema for the gap-analysis round"
```

---

### Task 3: Numeric validation for the new block kinds + CSV-derived figures

**Files:**
- Modify: `lib/agents/tako/compose.ts`
- Test: `lib/agents/tako/compose.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 block shapes; existing `numericMagnitude`, `allowedSets`, `traceable`, `GatheredFigure`.
- Produces: `export function csvFigures(csv: string, label: string): GatheredFigure[]` and `export function validateBlock(block, allowed, drop): AnswerBlock | null` (currently private — export it). Task 8 consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `lib/agents/tako/compose.test.ts`:

```ts
import { csvFigures, validateBlock } from "./compose";

const allow = (values: string[]) => {
  // mirror allowedSets(): normalized strings + magnitudes
  const figs = values.map((value) => ({ label: "f", value }));
  return {
    strings: new Set(figs.map((f) => f.value.replace(/\s+/g, "").toLowerCase())),
    mags: figs.map((f) => Number(String(f.value).replace(/[^0-9.\-]/g, ""))).filter((n) => !Number.isNaN(n)),
  };
};

describe("csvFigures", () => {
  it("turns every numeric cell (per column) into a gathered figure", () => {
    const csv = "Timestamp,Revenue,Margin\n2023,26974,0.56\n2024,60922,0.72";
    const figs = csvFigures(csv, "NVDA");
    expect(figs.some((f) => f.value === "26974")).toBe(true);
    expect(figs.some((f) => f.value === "0.72")).toBe(true);
    expect(figs.every((f) => f.label.startsWith("NVDA"))).toBe(true);
  });
  it("returns [] for a header-only or empty csv", () => {
    expect(csvFigures("", "x")).toEqual([]);
    expect(csvFigures("Timestamp,V", "x")).toEqual([]);
  });
});

describe("validateBlock — new kinds", () => {
  it("comparison: drops untraceable points, drops emptied series, keeps traceable", () => {
    const block: any = { kind: "comparison", series: [
      { label: "NVDA", entity: "Nvidia", points: [{ x: "2024", y: 60922 }, { x: "2023", y: 999999 }] },
      { label: "AMD", entity: "AMD", points: [{ x: "2024", y: 424242 }] },
    ] };
    const out: any = validateBlock(block, allow(["60922"]), () => {});
    expect(out.series).toHaveLength(1);
    expect(out.series[0].points).toEqual([{ x: "2024", y: 60922 }]);
  });
  it("leaderboard: drops rows with untraceable values, filters detail stats", () => {
    const block: any = { kind: "leaderboard", metricLabel: "Rev", rows: [
      { rank: 1, entity: "Nvidia", value: "$60,922", detail: { md: "ok", stats: [{ label: "fake", value: "$1" }] } },
      { rank: 2, entity: "AMD", value: "$999" },
    ] };
    const out: any = validateBlock(block, allow(["$60,922"]), () => {});
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].detail.stats).toEqual([]);
  });
  it("sections: strips an untraceable figure but keeps the section prose", () => {
    const block: any = { kind: "sections", sections: [
      { title: "Rates", md: "Higher.", figure: { label: "Fed", value: "9.9%" } },
    ] };
    const out: any = validateBlock(block, allow(["5.5%"]), () => {});
    expect(out.sections[0].figure).toBeUndefined();
    expect(out.sections[0].md).toBe("Higher.");
  });
  it("timeline: strips untraceable values, keeps the event", () => {
    const block: any = { kind: "timeline", events: [{ date: "2024", title: "Launch", value: "$77B" }] };
    const out: any = validateBlock(block, allow(["$30B"]), () => {});
    expect(out.events[0].value).toBeUndefined();
    expect(out.events[0].title).toBe("Launch");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/agents/tako/compose.test.ts` → FAIL (no exports; switch misses kinds).

- [ ] **Step 3: Implement in `lib/agents/tako/compose.ts`**

Export `validateBlock` (change `function validateBlock` → `export function validateBlock`). Add `csvFigures` below `numericMagnitude`:

```ts
const CSV_FIGURES_CAP = 500; // bound memory on very long series

// Every numeric cell of a fetched card CSV becomes an allowed figure, so real
// chart points the composer copies from card contents pass validation.
export function csvFigures(csv: string, label: string): GatheredFigure[] {
  const lines = csv.split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",");
  const out: GatheredFigure[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    for (let i = 1; i < cells.length; i++) {
      const v = cells[i]?.trim();
      if (!v || !/\d/.test(v)) continue;
      out.push({ label: `${label} ${header[i]?.trim() ?? ""}`.trim(), value: v });
      if (out.length >= CSV_FIGURES_CAP) return out;
    }
  }
  return out;
}
```

Add the four cases to `validateBlock`'s switch (before the closing brace):

```ts
    case "comparison": {
      const series = block.series
        .map((s) => ({ ...s, points: s.points.filter((p) => {
          const ok = traceable(String(p.y), allowed);
          if (!ok) drop(`comparison point ${s.label}:${p.y}`);
          return ok;
        }) }))
        .filter((s) => s.points.length > 0);
      return series.length ? { ...block, series } : null;
    }
    case "leaderboard": {
      const rows = block.rows
        .filter((r) => {
          const ok = traceable(r.value, allowed);
          if (!ok) drop(`leaderboard row "${r.entity}: ${r.value}"`);
          return ok;
        })
        .map((r) => (r.detail?.stats
          ? { ...r, detail: { ...r.detail, stats: r.detail.stats.filter((s) => {
              const ok = traceable(s.value, allowed);
              if (!ok) drop(`leaderboard stat "${s.label}: ${s.value}"`);
              return ok;
            }) } }
          : r));
      return rows.length ? { ...block, rows } : null;
    }
    case "sections": {
      const sections = block.sections.map((s) => {
        let next = s;
        if (s.figure && !traceable(s.figure.value, allowed)) {
          drop(`section figure "${s.figure.label}: ${s.figure.value}"`);
          const { figure: _f, ...rest } = next;
          next = rest;
        }
        if (next.chartSpec) {
          const series = next.chartSpec.series
            .map((se) => ({ ...se, points: se.points.filter((p) => traceable(String(p.y), allowed)) }))
            .filter((se) => se.points.length > 0);
          const { chartSpec: _c, ...rest } = next;
          next = series.length ? { ...rest, chartSpec: { ...next.chartSpec, series } } : rest;
        }
        return next;
      });
      return { ...block, sections };
    }
    case "timeline": {
      const events = block.events.map((e) => {
        if (e.value && !traceable(e.value, allowed)) {
          drop(`timeline value "${e.title}: ${e.value}"`);
          const { value: _v, ...rest } = e;
          return rest;
        }
        return e;
      });
      return { ...block, events };
    }
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run lib/agents/tako/compose.test.ts` → PASS. `npm test` → green.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/tako/compose.ts lib/agents/tako/compose.test.ts
git commit -m "feat: validate new block kinds and derive allowed figures from card CSVs"
```

---

### Task 4: Extract the reusable leaf flow into `flow.ts` (behavior-preserving)

**Files:**
- Create: `lib/agents/tako/flow.ts`
- Modify: `lib/agents/tako/research.ts`
- Test: existing suite (no new tests — the deliverable is "everything still green")

**Interfaces:**
- Produces (all exported from `flow.ts`; `research.ts` re-exports the public ones so `pipeline.ts`, `compose.ts`, `strategy.ts`, and tests keep importing from `./research` / `"./research"` unchanged):
  - `SYNTH_ID`, `synthNode`, `researchNode(id, question, summary)`, `feedsEdge`, `derivedEdge`, `supportsEdge`
  - `interface ResearchCtx`, `newResearchCtx(req, ledger, push, emit?, strategy?)`
  - `interface WebSource`, `toNodeSources`, `interface GatheredFigure`, `interface ResearchResult`
  - `extractFigures(findings)`, `excerptCsv(csv, chars?, rows?)`, `csvLatestFigure`, `fetchContents(ctx, url?)`
  - `filterWebSources`, `runSearches(question, nodeId, queries, ctx)`
  - `uniqueResearchId(ctx, question)`, `firstSentence(prose)`
  - `researchLeaf(question, depth, nodeId, root, ctx, entities, metrics, rationale?)` — the old `leaf()`, identical behavior.
- Consumes: nothing new — verbatim moves.

- [ ] **Step 1: Create `lib/agents/tako/flow.ts`**

Move VERBATIM from `research.ts` (cut from there, paste here, keep comments): the imports they need, `SYNTH_ID`, `MAX-`independent constants `CONTENTS_CAP`, `CSV_EXCERPT`, `TOTAL_RESEARCH_CAP`, `WEB_CONTENT_CAP`, `errorMessage`, `slug`, `synthNode`, `researchNode`, `feedsEdge`, `derivedEdge`, `supportsEdge`, `WebSource`, `toNodeSources`, `GatheredFigure`, `ResearchResult`, figure regexes + `pickFigure` + `extractFigures`, `excerptCsv`, `csvLatestFigure`, `fetchContents`, `ResearchCtx`, `newResearchCtx`, `uniqueResearchId`, `filterWebSources`, `runSearches`, `firstSentence`, and `leaf` renamed to `researchLeaf` (same parameters and body — every internal call target now lives in this file).

Two signature tweaks (still behavior-preserving):
- `excerptCsv(csv: string, chars = CSV_EXCERPT, rows = 24)` — existing callers pass no extra args.
- All moved functions `export`ed.

Top-of-file comment: `// Reusable leaf research flow: strategy → queries → searches → card noding → CSV contents → figures → mini-synthesis. Called by the research tree (research.ts) and the gap-fill round (gaps.ts).`

- [ ] **Step 2: Slim `research.ts` down to the tree logic**

`research.ts` keeps: `MAX_DEPTH`, `MAX_CHILDREN`, `depthLean`, `decomposePrompt`, `research()`, `broadFetch()`. It imports everything it needs from `./flow` and replaces internal `leaf(...)` calls with `researchLeaf(...)`. Add re-exports at the top so no other file changes:

```ts
export {
  SYNTH_ID, synthNode, newResearchCtx, toNodeSources,
} from "./flow";
export type { ResearchCtx, GatheredFigure, WebSource, ResearchResult } from "./flow";
```

(`strategy.ts` imports `type ResearchCtx` from `./research`; `compose.ts` imports `type ResearchCtx, GatheredFigure` from `./research`; `pipeline.ts` imports `research, newResearchCtx, toNodeSources, SYNTH_ID` — all satisfied by the re-exports.)

- [ ] **Step 3: Verify everything is still green**

Run: `npm test` → all existing tests PASS (pipeline, strategy, decompose, queries, followup, agent, compose, schemas, findings, ctx, memory, retrieval).
Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/agents/tako/flow.ts lib/agents/tako/research.ts
git commit -m "refactor: extract reusable leaf research flow into flow.ts"
```

---

### Task 5: Type plumbing — gapFill flag, "gap" reasoning kind, contents endpoint

**Files:**
- Modify: `lib/agents/shared/types.ts`, `lib/schema.ts`, `lib/trace.ts`, `lib/agents/tako/flow.ts`
- Test: `lib/agents/shared/schemas.test.ts` (append), Create: `lib/trace.test.ts`

**Interfaces:**
- Produces:
  - `zCanvasNode.gapFill?: boolean` (schema) — a research node minted by the gap round.
  - `AgentEvent` reasoning `kind: "branch" | "leaf" | "gap"`.
  - `TraceTreeNode.gapFill?: boolean`; `TakoCallRecord.endpoint` gains `"/v1/contents"`.
  - `TraceNodeView.gapFill?: boolean` (lib/trace.ts), carried by `buildTree` and `stepsToDisplay`; `LiveStep` reasoning kind widened the same way.
  - `flow.ts`: `researchNode(id, question, summary, gapFill?)` and `researchLeaf(..., opts?: { gapFill?: boolean })` — when set, the canvas node and the tree node carry `gapFill: true`.
- Consumes: Task 4's `flow.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/agents/shared/schemas.test.ts`:

```ts
import { zCanvasNode } from "../../schema";

describe("zCanvasNode.gapFill", () => {
  it("accepts a research node flagged as gap-fill", () => {
    const n = { id: "rq_x", type: "text", role: "research", title: "amd revenue", grounding: "tako", confidence: 0.85, gapFill: true };
    expect(zCanvasNode.safeParse(n).success).toBe(true);
  });
});
```

Create `lib/trace.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildTree, stepsToDisplay } from "./trace";

describe("gap-fill trace plumbing", () => {
  it("buildTree carries gapFill onto the view node", () => {
    const flat = [
      { nodeId: "synth", depth: 0, question: "q", kind: "branch" as const, findingCount: 0, children: ["rq_gap"] },
      { nodeId: "rq_gap", depth: 1, question: "amd revenue", kind: "leaf" as const, findingCount: 1, children: [], gapFill: true },
    ];
    const roots = buildTree(flat);
    expect(roots[0].children[0].gapFill).toBe(true);
  });
  it("stepsToDisplay accepts a kind:'gap' reasoning step", () => {
    const views = stepsToDisplay([
      { t: "reasoning", nodeId: "rq_gap", depth: 1, question: "amd revenue", kind: "gap", rationale: "missing half" },
    ]);
    expect(views[0].kind).toBe("gap");
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/trace.test.ts lib/agents/shared/schemas.test.ts` → FAIL (type errors / missing fields).

- [ ] **Step 3: Implement**

`lib/schema.ts` — in `zCanvasNode`, after `report:` line, add:

```ts
  gapFill: z.boolean().optional(), // research node minted by the post-tree gap-fill round
```

`lib/agents/shared/types.ts`:
- `TakoCallRecord.endpoint: "/v3/search" | "/v1/answer" | "/v1/contents";`
- `TraceTreeNode` gains `gapFill?: boolean; // minted by the gap-fill round (renders with a badge)`
- reasoning event: `kind: "branch" | "leaf" | "gap";`

`lib/trace.ts`:
- `TraceNodeView` gains `gapFill?: boolean;` and `kind: "branch" | "leaf" | "gap";`
- `LiveStep` reasoning kind: `"branch" | "leaf" | "gap"`.
- `buildTree`'s `toView`: add `gapFill: n.gapFill,`.
- `stepsToDisplay`: in the reasoning case nothing extra (kind already copied via `v.kind = s.kind`).

`lib/agents/tako/flow.ts`:
- `researchNode(id, question, summary, gapFill?: boolean)` → spread `...(gapFill ? { gapFill: true } : {})` into the returned node.
- `researchLeaf(question, depth, nodeId, root, ctx, entities, metrics, rationale?, opts?: { gapFill?: boolean })`:
  - the `add_node` call becomes `researchNode(nodeId, question, "", opts?.gapFill)`;
  - both `ctx.tree.push({...})` calls in the leaf gain `...(opts?.gapFill ? { gapFill: true } : {})`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run lib/trace.test.ts lib/agents/shared/schemas.test.ts` → PASS; `npm test` + `npx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add lib/schema.ts lib/agents/shared/types.ts lib/trace.ts lib/trace.test.ts lib/agents/tako/flow.ts lib/agents/shared/schemas.test.ts
git commit -m "feat: gapFill flag + gap reasoning kind + contents endpoint plumbing"
```

---

### Task 6: `gaps.ts` — the one-round gap analysis + fill

**Files:**
- Create: `lib/agents/tako/gaps.ts`
- Modify: `lib/agents/tako/prompts.ts` (add `GAP_SYSTEM`)
- Test: Create `lib/agents/tako/gaps.test.ts`

**Interfaces:**
- Consumes: `researchLeaf`, `uniqueResearchId`, `derivedEdge`, `SYNTH_ID`, `type ResearchCtx` from `./flow`; `zGapPlan` from Task 2; `generateStructured` from `../../llm`.
- Produces: `export async function runGapRound(ctx: ResearchCtx, question: string): Promise<{ ran: boolean; gaps: GapPlan["gaps"]; filled: number }>` — Task 9 calls it between the tree and the composer.

- [ ] **Step 1: Write the failing tests**

Create `lib/agents/tako/gaps.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentEvent } from "../shared/types";

const h = vi.hoisted(() => ({
  plan: { sufficient: true, rationale: "covered", gaps: [] } as any,
  leafResult: { nodeId: "rq_gap", title: "g", synthesis: "s", findingCount: 1, children: [], depth: 1, kind: "leaf" } as any,
  leafCalls: [] as any[],
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "gap-analysis") {
      if (h.plan instanceof Error) throw h.plan;
      return h.plan;
    }
    return {};
  }),
}));

vi.mock("./flow", () => ({
  SYNTH_ID: "synth",
  uniqueResearchId: vi.fn((_ctx: any, q: string) => `rq_${q.replace(/\W+/g, "_")}`),
  derivedEdge: vi.fn((from: string, to: string) => ({ op: "add_edge", edge: { id: `derives:${from}->${to}`, from, to, kind: "derived_from" } })),
  researchLeaf: vi.fn(async (...args: any[]) => { h.leafCalls.push(args); return { ...h.leafResult, nodeId: args[2] }; }),
}));

import { runGapRound } from "./gaps";
import { researchLeaf } from "./flow";

function fakeCtx(overrides: Partial<any> = {}) {
  const events: AgentEvent[] = [];
  const ops: any[] = [];
  return {
    req: { canvasId: "c", message: "q", surface: "main", canvasState: { nodes: [], edges: [] }, providerId: "tako", history: [] },
    ledger: { list: () => [{ card: { cardId: "nvda", description: "d" }, title: "NVDA rev", source: "S&P", kind: "data_card" }] },
    push: (o: any[]) => ops.push(...o),
    emit: (e: AgentEvent) => events.push(e),
    budget: { researchNodes: 2, maxNodes: 20 },
    notes: [], figures: [], branchResults: [{ question: "nvidia revenue", claim: "up", confidence: 0.8, figures: [] }],
    reasoning: [], tree: [], usedIds: new Set(["synth"]),
    _events: events, _ops: ops,
    ...overrides,
  } as any;
}

const gap = (n: number) => ({ question: `gap ${n}`, entity: `E${n}`, metric: "Revenue", why: "missing" });

beforeEach(() => {
  vi.clearAllMocks();
  h.plan = { sufficient: true, rationale: "covered", gaps: [] };
  h.leafCalls = [];
});

describe("runGapRound", () => {
  it("sufficient → no research, notes the rationale", async () => {
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res).toEqual({ ran: true, gaps: [], filled: 0 });
    expect(researchLeaf).not.toHaveBeenCalled();
    expect(ctx.notes.some((n: string) => n.includes("sufficient"))).toBe(true);
  });

  it("runs each gap as a gapFill leaf, emits kind:'gap' reasoning, wires derived edges to synth", async () => {
    h.plan = { sufficient: false, rationale: "one side missing", gaps: [gap(1), gap(2)] };
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res.filled).toBe(2);
    expect(h.leafCalls).toHaveLength(2);
    // opts.gapFill on every call (last arg)
    for (const args of h.leafCalls) expect(args[args.length - 1]).toEqual({ gapFill: true });
    const reasoning = ctx._events.filter((e: any) => e.type === "reasoning");
    expect(reasoning).toHaveLength(2);
    for (const r of reasoning) expect(r.kind).toBe("gap");
    const edges = ctx._ops.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.filter((e: any) => e.kind === "derived_from" && e.to === "synth")).toHaveLength(2);
    expect(ctx.budget.researchNodes).toBe(4); // reserved
  });

  it("caps at 4 gaps and respects remaining budget", async () => {
    h.plan = { sufficient: false, rationale: "r", gaps: [gap(1), gap(2), gap(3), gap(4), gap(5), gap(6)] };
    const ctx = fakeCtx({ budget: { researchNodes: 18, maxNodes: 20 } }); // room for only 2
    await runGapRound(ctx, "q");
    expect(h.leafCalls).toHaveLength(2);
  });

  it("budget exhausted → skips entirely", async () => {
    const ctx = fakeCtx({ budget: { researchNodes: 20, maxNodes: 20 } });
    const res = await runGapRound(ctx, "q");
    expect(res.ran).toBe(false);
  });

  it("analysis failure → ran:false with a note, never throws", async () => {
    h.plan = new Error("llm down");
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res).toEqual({ ran: false, gaps: [], filled: 0 });
    expect(ctx.notes.some((n: string) => n.includes("gap analysis failed"))).toBe(true);
  });

  it("a gap leaf that finds nothing is not counted as filled and gets no edge", async () => {
    h.plan = { sufficient: false, rationale: "r", gaps: [gap(1)] };
    h.leafResult = { ...h.leafResult, nodeId: null, findingCount: 0 };
    const ctx = fakeCtx();
    const res = await runGapRound(ctx, "q");
    expect(res.filled).toBe(0);
    expect(ctx._ops.filter((o: any) => o.op === "add_edge")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/agents/tako/gaps.test.ts` → FAIL (module not found).

- [ ] **Step 3: Add `GAP_SYSTEM` to `lib/agents/tako/prompts.ts`**

```ts
export const GAP_SYSTEM = `You are the lead analyst reviewing gathered evidence BEFORE the final report is written.
You are given the user's QUESTION and the EVIDENCE digest: subAnswers (each sub-question's one-line claim),
figures (every real number gathered), and cards (every Tako data card found).
Decide whether the evidence can answer the question DECISIVELY. List ONLY gaps that BLOCK a decisive answer:
- a comparison missing one side (entity A has the metric, entity B doesn't)
- a ranking/"top N" missing obvious members
- a claimed factor/driver with no metric behind it
- a headline series that is clearly stale for a "now/current" question
Each gap is a ready-to-run lookup PAIR: {question, entity, metric, why} — exactly ONE entity and ONE metric,
phrased like the existing sub-questions (e.g. "amd revenue"). NEVER invent nice-to-have expansions; if the
evidence already supports a decisive answer, return sufficient:true with an empty gaps list. That is the
EXPECTED outcome for most questions. At most 4 gaps.
Return { sufficient, rationale, gaps }.`;
```

- [ ] **Step 4: Implement `lib/agents/tako/gaps.ts`**

```ts
// One-round gap analysis + fill: after the research tree completes, a deep-model
// review of the gathered evidence lists what still BLOCKS a decisive answer; each
// gap runs the standard leaf flow (visible on canvas with gapFill:true) so its
// findings land in the same ctx accumulators the composer reads.
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zGapPlan, type GapPlan } from "../shared/schemas";
import { GAP_SYSTEM } from "./prompts";
import { SYNTH_ID, derivedEdge, researchLeaf, uniqueResearchId, type ResearchCtx } from "./flow";

const MAX_GAPS = 4;
const deepModel = () => process.env.SYNTH_MODEL || "gpt-5.4";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface GapRoundResult { ran: boolean; gaps: GapPlan["gaps"]; filled: number }

export async function runGapRound(ctx: ResearchCtx, question: string): Promise<GapRoundResult> {
  if (ctx.budget.researchNodes >= ctx.budget.maxNodes) {
    ctx.notes.push("gap round skipped — research budget exhausted");
    return { ran: false, gaps: [], filled: 0 };
  }
  ctx.emit?.({ type: "trace", stage: "analyzing gaps" });

  const digest = {
    subAnswers: ctx.branchResults.map((b) => ({ question: b.question, claim: b.claim, confidence: b.confidence })),
    figures: ctx.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity })),
    cards: ctx.ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, source: f.source })),
  };

  let plan: GapPlan;
  try {
    plan = await generateStructured({
      provider: "openai", model: deepModel(), reasoningEffort: "high",
      system: GAP_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nEVIDENCE: ${JSON.stringify(digest)}`,
      schema: zGapPlan, label: "gap-analysis",
    });
  } catch (e: unknown) {
    ctx.notes.push(`gap analysis failed — ${errorMessage(e)}`);
    return { ran: false, gaps: [], filled: 0 };
  }

  if (plan.sufficient || plan.gaps.length === 0) {
    ctx.notes.push(`gap analysis: sufficient — ${plan.rationale}`);
    return { ran: true, gaps: [], filled: 0 };
  }

  const room = ctx.budget.maxNodes - ctx.budget.researchNodes;
  const gaps = plan.gaps.slice(0, Math.min(MAX_GAPS, room));
  ctx.budget.researchNodes += gaps.length; // reserve before the parallel fills
  ctx.emit?.({ type: "trace", stage: `filling gaps (${gaps.length})` });

  const results = await Promise.all(gaps.map(async (g) => {
    const nodeId = uniqueResearchId(ctx, g.question);
    ctx.emit?.({
      type: "reasoning", nodeId, depth: 1, question: g.question, kind: "gap",
      rationale: g.why, entities: [g.entity], metrics: [g.metric],
    });
    ctx.reasoning.push({ nodeId, question: g.question, rationale: g.why });
    return researchLeaf(g.question, 1, nodeId, false, ctx, [g.entity], [g.metric], g.why, { gapFill: true });
  }));

  let filled = 0;
  for (const r of results) {
    if (!r.nodeId || r.findingCount === 0) continue;
    filled++;
    ctx.push([derivedEdge(r.nodeId, SYNTH_ID)]); // gap answer feeds the synthesis
  }
  return { ran: true, gaps, filled };
}
```

Note: `reasoningEffort` on `generateStructured` doesn't exist yet — Task 7 adds it. To keep this task green NOW, omit `reasoningEffort: "high",` here and add it in Task 7's integration step (Task 7 lists this edit).

- [ ] **Step 5: Run to verify pass** — `npx vitest run lib/agents/tako/gaps.test.ts` → PASS; `npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/gaps.ts lib/agents/tako/gaps.test.ts lib/agents/tako/prompts.ts
git commit -m "feat: one-round gap analysis + gap-fill via the reusable leaf flow"
```

---

### Task 7: `generateWithTools` + `reasoningEffort` in the LLM layer

**Files:**
- Modify: `lib/llm.ts`, `lib/agents/tako/gaps.ts` (add `reasoningEffort: "high"`)
- Test: Create `lib/llm.test.ts`

**Interfaces:**
- Produces:
  - `export async function generateWithTools(opts: { provider: LlmProvider; system: string; prompt: string; tools: Record<string, CoreTool>; maxSteps?: number; label?: string; model?: string; reasoningEffort?: "low" | "medium" | "high"; languageModel?: LanguageModel }): Promise<{ text: string; steps: number }>` — runs an AI-SDK tool loop; `languageModel` is a test seam that bypasses `getModel`.
  - `getModel(provider, model?, reasoningEffort?)` — threads `reasoningEffort` into the OpenAI settings; `generateStructured` gains the same optional field.
- Consumes: `ai@4` `generateText` + `tool`; `MockLanguageModelV1` from `ai/test` in tests.

- [ ] **Step 1: Write the failing test**

Create `lib/llm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { generateWithTools } from "./llm";

function toolLoopModel() {
  let call = 0;
  return new MockLanguageModelV1({
    doGenerate: async () => {
      call++;
      if (call === 1) {
        return {
          finishReason: "tool-calls" as const,
          usage: { promptTokens: 1, completionTokens: 1 },
          toolCalls: [{
            toolCallType: "function" as const, toolCallId: "t1",
            toolName: "get_card_contents", args: JSON.stringify({ cardId: "nvda" }),
          }],
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      }
      return {
        finishReason: "stop" as const,
        usage: { promptTokens: 1, completionTokens: 1 },
        text: "gathered nvda",
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

describe("generateWithTools", () => {
  it("executes tools across steps and returns the final text", async () => {
    const fetched: string[] = [];
    const res = await generateWithTools({
      provider: "openai", system: "s", prompt: "p",
      languageModel: toolLoopModel(),
      maxSteps: 3,
      tools: {
        get_card_contents: tool({
          description: "fetch csv",
          parameters: z.object({ cardId: z.string() }),
          execute: async ({ cardId }) => { fetched.push(cardId); return "Timestamp,V\n2024,1"; },
        }),
      },
    });
    expect(fetched).toEqual(["nvda"]);
    expect(res.text).toBe("gathered nvda");
    expect(res.steps).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/llm.test.ts` → FAIL (no export).

- [ ] **Step 3: Implement in `lib/llm.ts`**

Update imports and `getModel`:

```ts
import { generateObject, generateText, streamText, type LanguageModel, type CoreTool } from "ai";

export type ReasoningEffort = "low" | "medium" | "high";

export function getModel(provider: LlmProvider, model?: string, reasoningEffort?: ReasoningEffort): LanguageModel {
  if (provider === "openai") {
    return openai(model || modelId("openai"), {
      structuredOutputs: false,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
  }
  return anthropic(model || modelId("anthropic"));
}
```

Add `reasoningEffort?: ReasoningEffort` to `generateStructured`'s opts and pass it: `getModel(opts.provider, opts.model, opts.reasoningEffort)`.

Add below `generateStructured`:

```ts
// Multi-step tool loop (AI SDK generateText + tools + maxSteps). The model calls
// the provided tools as needed; the final text and step count come back. Used by
// the composer's gather phase. `languageModel` is a test seam bypassing getModel.
export async function generateWithTools(opts: {
  provider: LlmProvider;
  system: string;
  prompt: string;
  tools: Record<string, CoreTool>;
  maxSteps?: number;
  label?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  languageModel?: LanguageModel;
}): Promise<{ text: string; steps: number }> {
  const model = opts.model || modelId(opts.provider);
  const timer = startTimer("llm", `generateWithTools ${opts.label ?? ""}`.trim(), {
    provider: opts.provider, model, prompt: preview(opts.prompt),
  });
  try {
    const { text, steps } = await generateText({
      model: opts.languageModel ?? getModel(opts.provider, opts.model, opts.reasoningEffort),
      system: opts.system,
      prompt: opts.prompt,
      tools: opts.tools,
      maxSteps: opts.maxSteps ?? 10,
      temperature: 0.2,
    });
    timer.done(`generateWithTools ${opts.label ?? ""}`.trim(), { steps: steps.length, chars: text.length });
    return { text, steps: steps.length };
  } catch (e: unknown) {
    timer.fail(`generateWithTools ${opts.label ?? ""} failed`.trim(), {
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}
```

Then in `lib/agents/tako/gaps.ts`, add `reasoningEffort: "high",` to the `generateStructured` call (deferred from Task 6).

- [ ] **Step 4: Run to verify pass** — `npx vitest run lib/llm.test.ts lib/agents/tako/gaps.test.ts` → PASS; `npx tsc --noEmit` → clean.

- [ ] **Step 5: Commit**

```bash
git add lib/llm.ts lib/llm.test.ts lib/agents/tako/gaps.ts
git commit -m "feat: generateWithTools tool loop + reasoningEffort in the LLM layer"
```

---

### Task 8: Agentic composer — gather phase + GPT-only report emit

**Files:**
- Modify: `lib/agents/tako/compose.ts`, `lib/agents/tako/prompts.ts` (REPORT_SYSTEM v2 + new REPORT_GATHER_SYSTEM)
- Test: `lib/agents/tako/compose.test.ts` (append)

**Interfaces:**
- Consumes: `generateWithTools`, `generateStructured` (+`reasoningEffort`), `csvFigures`/`validateBlock` (Task 3), `fetchContents`/`excerptCsv` from `./flow`, `zGapPlan`-adjacent ctx fields.
- Produces: `composeReport(ctx, question)` — same signature as today, now: (1) builds a CARD_CATALOG from `ctx.ledger`, (2) runs a gather tool loop on the deep GPT model with a `get_card_contents(cardId)` tool (contents budget +8; each call emits a `"/v1/contents"` `tako_call` record on nodeId `"synth"`), (3) emits the report via one `generateStructured` on deep GPT (Anthropic removed), (4) validates against `ctx.figures` + `csvFigures` of everything fetched. Gather failure → compose proceeds without CARD_CONTENTS; report failure → `null` (unchanged contract).

- [ ] **Step 1: Rewrite the prompts in `lib/agents/tako/prompts.ts`**

Add:

```ts
export const REPORT_GATHER_SYSTEM = `You prepare the FINAL ANSWER for a research question. You are given SUB_ANSWERS,
FIGURES, WEB_SOURCES, and CARD_CATALOG — every real Tako data card found this turn ({id, title, entity, source, description}).
You have ONE tool: get_card_contents(cardId) → the card's REAL underlying data series as CSV.
Fetch the series you need to answer precisely — ALWAYS fetch both/all sides of a comparison, the members of a
ranking, and any series you intend to chart. Do NOT fetch cards irrelevant to the question. Then reply with a
SHORT analyst note (<=150 words): what the fetched data shows, which cards matter most, and any conflict between
sources. Plain text only.`;
```

Replace `REPORT_SYSTEM` with:

```ts
export const REPORT_SYSTEM = `You are the lead analyst composing the FINAL ANSWER as a clear, well-made report for the top of a research canvas.
You are given the QUESTION, SUB_ANSWERS (each {question, claim, keyFigures, confidence}), the full gathered FIGURES
(every real number available this turn, each {label, value, entity, source}), WEB_SOURCES (title, publisher, snippet,
content excerpt), CARD_CONTENTS (real CSV series fetched from Tako cards this turn), and ANALYST_NOTES.
GROUND THE ANSWER IN THE TAKO DATA FIRST — FIGURES, CARD_CONTENTS and SUB_ANSWERS are the backbone; use WEB_SOURCES
for context, recency, and drivers. RECONCILE the evidence into a decisive verdict.
Return { verdict, blocks } — an ORDERED list of representation blocks. CHOOSE THE SHAPE THAT FITS THE QUESTION:
- comparison question ("X vs Y", "which is better") → { kind:"comparison", title?, unit?, series:[{label, entity, points:[{x,y}]}], insight? }
  built ONLY from CARD_CONTENTS series (copy real values; align the x axes), plus a prose block reconciling them.
- "top N / best / largest" → { kind:"leaderboard", title?, metricLabel, rows:[{rank, entity, value, delta?, detail?:{md, stats?}}] }
  — fill detail ONLY where SUB_ANSWERS/FIGURES give real material for that entity.
- "what factors/drivers affect X" → { kind:"sections", sections:[{title, md, figure?, chartSpec?}] } — one section per factor.
- "how did X change/evolve/what happened" → { kind:"timeline", events:[{date, title, md?, value?}] }.
- simple lookup → { kind:"tiles", tiles:[{label, value, delta?}] } + short prose.
Also available: { kind:"prose", md } (reasoning; markdown: **bold**, "## ", "- " only), { kind:"table", columns, rows },
{ kind:"chart", title?, chartSpec:{kind:"bar"|"line", unit?, series:[{label, points}]} }.
Rules: verdict first; include ONLY blocks that genuinely add clarity (usually 2-3). Use ONLY numbers present in
FIGURES / SUB_ANSWERS / CARD_CONTENTS — copy values verbatim; NEVER invent, extrapolate, or round beyond what's given.
Draw on WEB_SOURCES for qualitative context; name the publisher inline (e.g. "per Reuters"). No citation markers.`;
```

- [ ] **Step 2: Write the failing tests**

Create a NEW file `lib/agents/tako/compose.report.test.ts` (do NOT add these to `compose.test.ts` — vitest hoists `vi.mock` file-wide and would break its pure-function tests):

```ts
// lib/agents/tako/compose.report.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  report: {} as any,
  gatherFails: false,
  csv: "Timestamp,Revenue\n2023,26974\n2024,60922",
}));

vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: any) => {
    if (opts.label === "answer-report") return h.report;
    return {};
  }),
  generateWithTools: vi.fn(async (opts: any) => {
    if (h.gatherFails) throw new Error("tool loop down");
    // simulate the model fetching one card then answering
    const out = await opts.tools.get_card_contents.execute({ cardId: "nvda" });
    expect(String(out)).toContain("Timestamp");
    return { text: "nvda series fetched", steps: 2 };
  }),
}));

vi.mock("./flow", async (importOriginal) => {
  const mod: any = await importOriginal();
  return { ...mod, fetchContents: vi.fn(async () => h.csv) };
});

import { composeReport } from "./compose";
import { newResearchCtx } from "./research";
import { FindingLedger } from "./findings";

function ctxWithCard() {
  const ledger = new FindingLedger();
  ledger.add({ cardId: "nvda", title: "NVDA revenue", embedUrl: "https://e/nvda", webpageUrl: "https://w/nvda", source: "S&P Global", description: "Revenue" } as any, "synth");
  const ctx = newResearchCtx(
    { canvasId: "c", message: "q", surface: "main", canvasState: { nodes: [], edges: [] }, providerId: "tako", history: [] } as any,
    ledger, () => {},
  );
  ctx.branchResults.push({ question: "nvidia revenue", claim: "up", confidence: 0.8, figures: [] });
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.gatherFails = false;
  h.report = { verdict: "**Up.**", blocks: [{ kind: "prose", md: "Because." }] };
});

describe("composeReport v2 — agentic gather + GPT emit", () => {
  it("comparison points copied from a fetched CSV survive validation", async () => {
    h.report = { verdict: "**Nvidia leads.**", blocks: [{
      kind: "comparison", series: [
        { label: "NVDA", entity: "Nvidia", points: [{ x: "2024", y: 60922 }, { x: "fake", y: 123456789 }] },
      ],
    }] };
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    const comp: any = report!.blocks[0];
    expect(comp.series[0].points).toEqual([{ x: "2024", y: 60922 }]); // real CSV value kept, invented dropped
  });

  it("records a /v1/contents tako_call on synth for each tool fetch", async () => {
    const ctx = ctxWithCard();
    await composeReport(ctx, "q");
    const contentsCalls = ctx.calls.filter((c) => c.endpoint === "/v1/contents");
    expect(contentsCalls).toHaveLength(1);
    expect(contentsCalls[0].nodeId).toBe("synth");
    expect(contentsCalls[0].cards[0].id).toBe("nvda");
  });

  it("gather failure falls back to composing without card contents", async () => {
    h.gatherFails = true;
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    expect(report?.verdict).toContain("Up");
    expect(ctx.notes.some((n) => n.includes("report gather failed"))).toBe(true);
  });

  it("report failure returns null with a note (no Claude fallback anymore)", async () => {
    const { generateStructured } = await import("../../llm");
    (generateStructured as any).mockRejectedValueOnce(new Error("model down"));
    const ctx = ctxWithCard();
    const report = await composeReport(ctx, "q");
    expect(report).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run lib/agents/tako/compose.report.test.ts` → FAIL.

- [ ] **Step 4: Rewrite `composeReport` in `lib/agents/tako/compose.ts`**

Replace the imports and body (keep `numericMagnitude`, `allowedSets`, `traceable`, `csvFigures`, `validateBlock` as-is):

```ts
import type { AnswerReport, AnswerBlock } from "../../schema";
import type { TakoCallRecord } from "../shared/types";
import { generateStructured, generateWithTools } from "../../llm";
import { tool } from "ai";
import { z } from "zod";
import { zAnswerReport } from "../shared/schemas";
import { ctxBlock } from "../shared/ctx";
import { REPORT_SYSTEM, REPORT_GATHER_SYSTEM } from "./prompts";
import { log } from "../../log";
import { fetchContents, excerptCsv, SYNTH_ID, type ResearchCtx, type GatheredFigure } from "./flow";

const deepModel = () => process.env.SYNTH_MODEL || "gpt-5.4";
const COMPOSER_CONTENTS_BUDGET = 8; // extra fetch headroom for the gather phase (cache hits are free)
const COMPOSER_MAX_STEPS = 10;
const COMPOSER_CSV_EXCERPT = 2400; // larger than leaf excerpts — the composer charts real series
const COMPOSER_CSV_ROWS = 60;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Phase A: the gather tool loop. The deep model reads the card catalog and pulls
// the REAL series it needs (both sides of a comparison, ranking members, …).
// Returns the analyst note + everything fetched; failure returns empty (compose
// proceeds without card contents — never throws).
async function gatherCardContents(
  ctx: ResearchCtx, question: string,
  catalog: { id: string; title: string; entity?: string; source?: string; description?: string }[],
): Promise<{ notes: string; fetched: Map<string, string> }> {
  const fetched = new Map<string, string>();
  if (catalog.length === 0) return { notes: "", fetched };
  ctx.contents.cap = ctx.contents.fetched + COMPOSER_CONTENTS_BUDGET;
  try {
    const res = await generateWithTools({
      provider: "openai", model: deepModel(), reasoningEffort: "high",
      system: REPORT_GATHER_SYSTEM,
      prompt: `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nCARD_CATALOG: ${JSON.stringify(catalog)}\n\nSUB_ANSWERS: ${JSON.stringify(ctx.branchResults.map((b) => ({ question: b.question, claim: b.claim })))}`,
      maxSteps: COMPOSER_MAX_STEPS, label: "report-gather",
      tools: {
        get_card_contents: tool({
          description: "Fetch the real underlying data series (CSV) behind a Tako card from CARD_CATALOG.",
          parameters: z.object({ cardId: z.string() }),
          execute: async ({ cardId }) => {
            const f = ctx.ledger.list().find((x) => x.card.cardId === cardId);
            if (!f) return "unknown cardId";
            const t0 = Date.now();
            const csv = await fetchContents(ctx, f.card.webpageUrl);
            const call: TakoCallRecord = {
              callId: `${SYNTH_ID}:contents:${ctx.calls.length}`, nodeId: SYNTH_ID,
              query: f.title, endpoint: "/v1/contents", effort: "fast", ms: Date.now() - t0,
              cards: [{ id: cardId, title: f.title, source: f.source, url: f.url }],
              ...(csv ? {} : { error: "no data available" }),
            };
            ctx.calls.push(call);
            ctx.emit?.({ type: "tako_call", call });
            if (!csv) return "no data available";
            fetched.set(cardId, csv);
            return excerptCsv(csv, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS);
          },
        }),
      },
    });
    return { notes: res.text, fetched };
  } catch (e: unknown) {
    ctx.notes.push(`report gather failed — ${errorMessage(e)}`);
    return { notes: "", fetched };
  }
}

// Compose the final report from the tree's gathered evidence + on-demand card
// contents. Returns null when there's nothing to report (caller falls back).
export async function composeReport(ctx: ResearchCtx, question: string): Promise<AnswerReport | null> {
  if (ctx.figures.length === 0 && ctx.branchResults.length === 0) return null;

  const catalog = ctx.ledger.list()
    .filter((f) => f.kind === "data_card")
    .map((f) => ({
      id: f.card.cardId, title: f.title, entity: f.section, source: f.source,
      description: f.card.description?.slice(0, 200),
    }));

  const { notes: analystNotes, fetched } = await gatherCardContents(ctx, question, catalog);

  const subAnswers = ctx.branchResults.map((b) => ({
    question: b.question, claim: b.claim, confidence: b.confidence,
    keyFigures: b.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity })),
  }));
  const figures = ctx.figures.map((f) => ({ label: f.label, value: f.value, entity: f.entity, source: f.source }));
  const webSources = ctx.webSources.map((w) => ({
    title: w.title, publisher: w.source, snippet: w.summary,
    content: (w.content || w.summary || "").slice(0, 1500),
  }));
  const cardContents = Array.from(fetched.entries()).map(([id, csv]) => ({
    cardId: id,
    title: catalog.find((c) => c.id === id)?.title,
    data: excerptCsv(csv, COMPOSER_CSV_EXCERPT, COMPOSER_CSV_ROWS),
  }));

  const prompt = `${ctxBlock(ctx.req)}\n\nQUESTION: ${question}\n\nSUB_ANSWERS: ${JSON.stringify(subAnswers)}\n\nFIGURES: ${JSON.stringify(figures)}\n\nWEB_SOURCES: ${JSON.stringify(webSources)}\n\nCARD_CONTENTS: ${JSON.stringify(cardContents)}\n\nANALYST_NOTES: ${analystNotes || "(none)"}`;

  let report: AnswerReport;
  try {
    report = await generateStructured({
      provider: "openai", model: deepModel(), reasoningEffort: "high",
      system: REPORT_SYSTEM, prompt, schema: zAnswerReport, label: "answer-report",
    });
  } catch (e: unknown) {
    ctx.notes.push(`answer-report failed — ${errorMessage(e)}`);
    return null;
  }

  // Validate every number against gathered figures PLUS the fetched CSV values.
  const csvDerived: GatheredFigure[] = [];
  for (const [id, csv] of fetched) {
    csvDerived.push(...csvFigures(csv, catalog.find((c) => c.id === id)?.title || id));
  }
  const allowed = allowedSets([...ctx.figures, ...csvDerived]);
  let dropped = 0;
  const blocks = report.blocks
    .map((b) => validateBlock(b, allowed, () => { dropped++; }))
    .filter((b): b is AnswerBlock => b !== null);
  if (dropped > 0) log("tako", "answer-report dropped untraceable numbers", { dropped });
  return { verdict: report.verdict, blocks };
}
```

(Delete the old `ANTHROPIC` const and the Claude→GPT fallback chain.)

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run lib/agents/tako/compose.report.test.ts lib/agents/tako/compose.test.ts` → PASS.
Run: `npm test` — `pipeline.test.ts` will FAIL if its `../../llm` mock lacks `generateWithTools`. Add to that mock factory: `generateWithTools: vi.fn(async () => ({ text: "", steps: 0 })),` (Task 9 extends it properly; add the stub now to stay green).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/compose.ts lib/agents/tako/compose.report.test.ts lib/agents/tako/prompts.ts lib/agents/tako/pipeline.test.ts
git commit -m "feat: agentic composer — card-contents tool loop + GPT-only report emit"
```

---

### Task 9: Pipeline integration — gap round between tree and composer

**Files:**
- Modify: `lib/agents/tako/pipeline.ts`, `lib/agents/tako/pipeline.test.ts`

**Interfaces:**
- Consumes: `runGapRound` (Task 6).
- Produces: the pipeline order `research → runGapRound → composeReport`, with trace stage `"composing report"` emitted before compose. No signature changes.

- [ ] **Step 1: Write the failing test**

In `lib/agents/tako/pipeline.test.ts`: extend the `vi.hoisted` block with `gapPlan: { sufficient: true, rationale: "covered", gaps: [] } as any`; in the `generateStructured` mock add `if (opts.label === "gap-analysis") return h.gapPlan;`; ensure the mock exports `generateWithTools: vi.fn(async () => ({ text: "", steps: 0 }))`; add `takoContents: vi.fn(async () => ({ csv: "Timestamp,V\n2024,1" }))` to the `../../tako` mock; reset `h.gapPlan` in `beforeEach`. Then add:

```ts
  it("runs ONE gap-fill round: gap leaf renders with gapFill, wires derived_from to synth", async () => {
    h.plans["compare Nvidia and AMD"] = {
      atomic: false, rationale: "split", entity: "Nvidia", metric: "Revenue",
      subQuestions: [
        { question: "nvidia revenue", entity: "Nvidia", metric: "Revenue" },
        { question: "nvidia margin", entity: "Nvidia", metric: "Revenue" },
      ],
    };
    h.gapPlan = { sufficient: false, rationale: "AMD side missing", gaps: [
      { question: "amd revenue", entity: "AMD", metric: "Revenue", why: "comparison half missing" },
    ] };
    const events: any[] = [];
    const result = await runTakoInitial(req, (e) => events.push(e));

    const gapNode = result.nodeOps.find((o: any) => o.op === "add_node" && o.node.gapFill) as any;
    expect(gapNode).toBeTruthy();
    expect(gapNode.node.role).toBe("research");

    const edges = result.nodeOps.filter((o: any) => o.op === "add_edge").map((o: any) => o.edge);
    expect(edges.some((e: any) => e.kind === "derived_from" && e.from === gapNode.node.id && e.to === "synth")).toBe(true);

    // gap reasoning event streamed with kind "gap"; trace tree records the gap leaf
    expect(events.some((e) => e.type === "reasoning" && e.kind === "gap")).toBe(true);
    const treeGap = result.trace.tree?.find((n) => n.gapFill);
    expect(treeGap?.question).toBe("amd revenue");

    // gap findings reached the composer's figure pool → its card exists on the canvas
    expect(result.nodeOps.some((o: any) => o.op === "add_node" && o.node.tako?.cardId === "amd")).toBe(true);
  });

  it("sufficient gap analysis adds no research nodes beyond the tree", async () => {
    h.plans["compare Nvidia and AMD"] = twoBranchPlan;
    const result = await runTakoInitial(req, () => {});
    const research = result.nodeOps.filter((o: any) => o.op === "add_node" && o.node.role === "research") as any[];
    expect(research).toHaveLength(2);
    expect(research.every((o) => !o.node.gapFill)).toBe(true);
  });
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run lib/agents/tako/pipeline.test.ts` → the new tests FAIL (no gap round in the pipeline).

- [ ] **Step 3: Implement in `lib/agents/tako/pipeline.ts`**

Import `runGapRound` and insert between the tree and the composer (inside the `else` branch, before the `synthesis start` emit):

```ts
import { runGapRound } from "./gaps";
// …
  } else {
    // One gap-fill round: review the gathered evidence, fetch what's missing.
    await runGapRound(ctx, req.message);
    emit?.({ type: "trace", stage: "composing report" });
    emit?.({ type: "synthesis", phase: "start", nodeId: SYNTH_ID, kind: "root" });
    // … (existing composeReport block unchanged)
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run lib/agents/tako/pipeline.test.ts` → PASS; `npm test` + `npx tsc --noEmit` → green.

- [ ] **Step 5: Commit**

```bash
git add lib/agents/tako/pipeline.ts lib/agents/tako/pipeline.test.ts
git commit -m "feat: run the gap-fill round between the research tree and the composer"
```

---

### Task 10: Component test infra + ComparisonChart

**Files:**
- Modify: `package.json` (devDeps), `vitest.config.ts`
- Create: `components/report/ComparisonChart.tsx`
- Test: Create `components/report/ComparisonChart.test.tsx`

**Interfaces:**
- Produces: `export default function ComparisonChart({ block }: { block: Extract<AnswerBlock, { kind: "comparison" }> })` and `export const SERIES_COLORS: string[]`. Task 13 imports the component; Tasks 11–12 reuse the test infra.
- Consumes: `AnswerBlock` from Task 1.

- [ ] **Step 1: Install test infra + configure vitest**

```bash
npm i -D jsdom @testing-library/react@14
```

Update `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  esbuild: { jsx: "automatic" }, // Next's tsconfig says "preserve"; tests need real JSX transform
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.tsx"],
    environmentMatchGlobs: [["components/**", "jsdom"]],
  },
  resolve: { alias: { "@": resolve(__dirname, ".") } },
});
```

- [ ] **Step 2: Write the failing test**

Create `components/report/ComparisonChart.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ComparisonChart from "./ComparisonChart";

const block = {
  kind: "comparison" as const,
  title: "Revenue", unit: "USD bn",
  series: [
    { label: "Nvidia", entity: "Nvidia", points: [{ x: "2022", y: 27 }, { x: "2023", y: 61 }, { x: "2024", y: 130 }] },
    { label: "AMD", entity: "AMD", points: [{ x: "2022", y: 24 }, { x: "2023", y: 23 }, { x: "2024", y: 26 }] },
  ],
  insight: "Nvidia tripled while AMD stayed flat.",
};

describe("ComparisonChart", () => {
  it("renders a legend chip per series with the latest value", () => {
    render(<ComparisonChart block={block} />);
    expect(screen.getByText("Nvidia")).toBeTruthy();
    expect(screen.getByText("AMD")).toBeTruthy();
    expect(screen.getByText("130")).toBeTruthy();
    expect(screen.getByText("26")).toBeTruthy();
  });
  it("renders one polyline per series and the insight line", () => {
    const { container } = render(<ComparisonChart block={block} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    expect(screen.getByText(/tripled/)).toBeTruthy();
  });
  it("falls back to grouped bars when a series has under 3 points", () => {
    const bars = { ...block, series: block.series.map((s) => ({ ...s, points: s.points.slice(0, 2) })) };
    const { container } = render(<ComparisonChart block={bars} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(0);
    expect(container.querySelectorAll("rect").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run components/report/ComparisonChart.test.tsx` → FAIL (module missing).

- [ ] **Step 4: Implement `components/report/ComparisonChart.tsx`**

```tsx
"use client";
import type { AnswerBlock } from "@/lib/schema";

type ComparisonBlock = Extract<AnswerBlock, { kind: "comparison" }>;

// Categorical palette (colorblind-safe, Observable-10-derived). Index-stable so a
// series keeps its color between renders.
export const SERIES_COLORS = ["#4269d0", "#efb118", "#ff725c", "#6cc5b0", "#a463f2", "#9c6b4e"];

const W = 560, H = 240, PAD = 34;

function fmt(n: number): string {
  return Math.abs(n) >= 1000 ? n.toLocaleString("en-US") : String(n);
}

// Multi-entity overlay built from REAL card series: shared x domain (union, in
// first-appearance order), shared y scale, one color per entity, legend chips
// carrying the latest value, optional insight line beneath.
export default function ComparisonChart({ block }: { block: ComparisonBlock }) {
  const xs: string[] = [];
  for (const s of block.series) for (const p of s.points) {
    const k = String(p.x);
    if (!xs.includes(k)) xs.push(k);
  }
  const ys = block.series.flatMap((s) => s.points.map((p) => p.y));
  if (!xs.length || !ys.length) return <div className="empty-note">no data</div>;
  const max = Math.max(...ys, 0), min = Math.min(...ys, 0);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i * (W - 2 * PAD)) / Math.max(xs.length - 1, 1);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - 2 * PAD);
  const asLines = block.series.every((s) => s.points.length >= 3);

  return (
    <div className="report-comparison">
      {block.title ? <div className="report-chart-title">{block.title}</div> : null}
      <div className="comparison-legend">
        {block.series.map((s, i) => {
          const last = s.points[s.points.length - 1];
          return (
            <span key={s.label} className="comparison-chip">
              <span className="comparison-swatch" style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }} />
              {s.label}
              {last ? <strong>{fmt(last.y)}</strong> : null}
            </span>
          );
        })}
        {block.unit ? <span className="comparison-unit">{block.unit}</span> : null}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={block.title || "comparison chart"}>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="var(--line-strong, #ccc)" />
        {asLines
          ? block.series.map((s, si) => (
              <g key={s.label}>
                <polyline
                  fill="none" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth={2.2}
                  strokeLinejoin="round" strokeLinecap="round"
                  points={s.points.map((p) => `${x(xs.indexOf(String(p.x)))},${y(p.y)}`).join(" ")}
                />
                {s.points.map((p, i) => (
                  <circle key={i} cx={x(xs.indexOf(String(p.x)))} cy={y(p.y)} r={2.8}
                    fill="#fff" stroke={SERIES_COLORS[si % SERIES_COLORS.length]} strokeWidth={1.6}>
                    <title>{`${s.label} ${p.x}: ${fmt(p.y)}`}</title>
                  </circle>
                ))}
              </g>
            ))
          : xs.map((xv, xi) => {
              const group = (W - 2 * PAD) / xs.length;
              const bw = Math.max(4, (group - 10) / block.series.length);
              return block.series.map((s, si) => {
                const p = s.points.find((pt) => String(pt.x) === xv);
                if (!p) return null;
                const bx = PAD + xi * group + 5 + si * bw;
                return (
                  <rect key={`${s.label}-${xv}`} x={bx} y={y(p.y)} width={bw - 2}
                    height={Math.max(0, H - PAD - y(p.y))} rx={2}
                    fill={SERIES_COLORS[si % SERIES_COLORS.length]} opacity={0.9}>
                    <title>{`${s.label} ${xv}: ${fmt(p.y)}`}</title>
                  </rect>
                );
              });
            })}
        {xs.map((xv, i) => (
          <text key={xv} x={asLines ? x(i) : PAD + (i + 0.5) * ((W - 2 * PAD) / xs.length)} y={H - PAD + 14}
            fontSize={10} fill="var(--muted, #888)" textAnchor="middle">
            {xv.slice(0, 7)}
          </text>
        ))}
      </svg>
      {block.insight ? <div className="comparison-insight">{block.insight}</div> : null}
    </div>
  );
}
```

- [ ] **Step 5: Run to verify pass** — `npx vitest run components/report/ComparisonChart.test.tsx` → PASS; `npm test` still green.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json vitest.config.ts components/report/ComparisonChart.tsx components/report/ComparisonChart.test.tsx
git commit -m "feat: ComparisonChart report block + component test infra"
```

---

### Task 11: Leaderboard component

**Files:**
- Create: `components/report/Leaderboard.tsx`
- Test: Create `components/report/Leaderboard.test.tsx`

**Interfaces:**
- Produces: `export default function Leaderboard({ block }: { block: Extract<AnswerBlock, { kind: "leaderboard" }> })`. Task 13 imports it.
- Consumes: `Markdown` from `components/Markdown.tsx` (existing: `<Markdown text={string} compact />`).

- [ ] **Step 1: Write the failing test**

Create `components/report/Leaderboard.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Leaderboard from "./Leaderboard";

const block = {
  kind: "leaderboard" as const, metricLabel: "Market cap",
  rows: [
    { rank: 1, entity: "Nvidia", value: "$3.4T", delta: "+12%",
      detail: { md: "Dominates accelerators.", stats: [{ label: "Revenue", value: "$130B" }] } },
    { rank: 2, entity: "Apple", value: "$3.2T" },
  ],
};

describe("Leaderboard", () => {
  it("renders ranked rows with values", () => {
    render(<Leaderboard block={block} />);
    expect(screen.getByText("Nvidia")).toBeTruthy();
    expect(screen.getByText("$3.4T")).toBeTruthy();
    expect(screen.getByText("Apple")).toBeTruthy();
  });
  it("expands a row with detail on click, revealing prose and stats", () => {
    render(<Leaderboard block={block} />);
    expect(screen.queryByText(/Dominates/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Nvidia/ }));
    expect(screen.getByText(/Dominates/)).toBeTruthy();
    expect(screen.getByText("$130B")).toBeTruthy();
  });
  it("rows without detail are not buttons", () => {
    render(<Leaderboard block={block} />);
    expect(screen.queryByRole("button", { name: /Apple/ })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run components/report/Leaderboard.test.tsx` → FAIL.

- [ ] **Step 3: Implement `components/report/Leaderboard.tsx`**

```tsx
"use client";
import { useState } from "react";
import type { AnswerBlock } from "@/lib/schema";
import Markdown from "../Markdown";
import { IconChevronRight } from "../icons";

type LeaderboardBlock = Extract<AnswerBlock, { kind: "leaderboard" }>;

function deltaClass(delta?: string): string {
  if (!delta) return "";
  return delta.trim().startsWith("-") ? " down" : " up";
}

// Collapsible leaderboard for "top XYZ" answers: rank, entity, headline value,
// optional delta; rows with real material expand to detail prose + stat chips.
export default function Leaderboard({ block }: { block: LeaderboardBlock }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (rank: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(rank)) next.delete(rank); else next.add(rank);
      return next;
    });
  const rows = [...block.rows].sort((a, b) => a.rank - b.rank);

  return (
    <div className="report-leaderboard">
      {block.title ? <div className="report-chart-title">{block.title}</div> : null}
      <div className="leaderboard-metric">{block.metricLabel}</div>
      {rows.map((r) => {
        const expandable = !!r.detail;
        const isOpen = open.has(r.rank);
        const rowBody = (
          <>
            <span className={`leaderboard-rank${r.rank <= 3 ? " top" : ""}`}>{r.rank}</span>
            <span className="leaderboard-entity">{r.entity}</span>
            <span className="leaderboard-value">{r.value}</span>
            {r.delta ? <span className={`leaderboard-delta${deltaClass(r.delta)}`}>{r.delta}</span> : null}
            {expandable ? <IconChevronRight className={`disclosure-chev${isOpen ? " open" : ""}`} /> : null}
          </>
        );
        return (
          <div key={r.rank} className={`leaderboard-row-wrap${r.rank <= 3 ? " top" : ""}`}>
            {expandable ? (
              <button type="button" className="leaderboard-row" aria-expanded={isOpen} onClick={() => toggle(r.rank)}>
                {rowBody}
              </button>
            ) : (
              <div className="leaderboard-row">{rowBody}</div>
            )}
            {expandable && isOpen && r.detail ? (
              <div className="leaderboard-detail">
                <Markdown text={r.detail.md} compact />
                {r.detail.stats?.length ? (
                  <div className="leaderboard-stats">
                    {r.detail.stats.map((s) => (
                      <span key={s.label} className="leaderboard-stat">
                        <span className="leaderboard-stat-value">{s.value}</span> {s.label}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run components/report/Leaderboard.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add components/report/Leaderboard.tsx components/report/Leaderboard.test.tsx
git commit -m "feat: collapsible Leaderboard report block"
```

---

### Task 12: FactorSections + Timeline components

**Files:**
- Create: `components/report/FactorSections.tsx`, `components/report/Timeline.tsx`
- Test: Create `components/report/FactorSections.test.tsx`, `components/report/Timeline.test.tsx`

**Interfaces:**
- Produces: `export default function FactorSections({ block }: { block: Extract<AnswerBlock, { kind: "sections" }> })` and `export default function Timeline({ block }: { block: Extract<AnswerBlock, { kind: "timeline" }> })`. Task 13 imports both.
- Consumes: `Markdown`, `MiniChart` (existing components).

- [ ] **Step 1: Write the failing tests**

`components/report/FactorSections.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import FactorSections from "./FactorSections";

const block = {
  kind: "sections" as const,
  sections: [
    { title: "Interest rates", md: "Higher for longer.", figure: { label: "Fed funds", value: "5.5%" } },
    { title: "Supply", md: "Inventory recovered.", chartSpec: { kind: "line" as const, series: [{ label: "s", points: [{ x: "a", y: 1 }, { x: "b", y: 2 }] }] } },
  ],
};

describe("FactorSections", () => {
  it("renders every section expanded by default (factors ARE the answer)", () => {
    render(<FactorSections block={block} />);
    expect(screen.getByText(/Higher for longer/)).toBeTruthy();
    expect(screen.getByText(/Inventory recovered/)).toBeTruthy();
    expect(screen.getByText("5.5%")).toBeTruthy();
  });
  it("collapses a section on header click", () => {
    render(<FactorSections block={block} />);
    fireEvent.click(screen.getByRole("button", { name: /Interest rates/ }));
    expect(screen.queryByText(/Higher for longer/)).toBeNull();
  });
});
```

`components/report/Timeline.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import Timeline from "./Timeline";

const block = {
  kind: "timeline" as const,
  events: [
    { date: "2024-03", title: "Blackwell announced", md: "New architecture.", value: "$30B" },
    { date: "2025-01", title: "Volume shipping" },
  ],
};

describe("Timeline", () => {
  it("renders each event with date, title, and optional value/prose", () => {
    render(<Timeline block={block} />);
    expect(screen.getByText("2024-03")).toBeTruthy();
    expect(screen.getByText("Blackwell announced")).toBeTruthy();
    expect(screen.getByText("$30B")).toBeTruthy();
    expect(screen.getByText("Volume shipping")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run components/report/FactorSections.test.tsx components/report/Timeline.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`components/report/FactorSections.tsx`:

```tsx
"use client";
import { useState } from "react";
import type { AnswerBlock } from "@/lib/schema";
import Markdown from "../Markdown";
import MiniChart from "../MiniChart";
import { IconChevronRight } from "../icons";

type SectionsBlock = Extract<AnswerBlock, { kind: "sections" }>;

// One titled card per factor/driver. All sections start EXPANDED — the factors
// are the answer; collapsing is a skim affordance, not the default.
export default function FactorSections({ block }: { block: SectionsBlock }) {
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });

  return (
    <div className="report-sections">
      {block.sections.map((s, i) => {
        const open = !closed.has(i);
        return (
          <div key={i} className="factor-section">
            <button type="button" className="factor-head" aria-expanded={open} onClick={() => toggle(i)}>
              <IconChevronRight className={`disclosure-chev${open ? " open" : ""}`} />
              <span className="factor-title">{s.title}</span>
              {s.figure ? (
                <span className="factor-figure">
                  <strong>{s.figure.value}</strong>
                  {s.figure.delta ? <span className="factor-delta"> {s.figure.delta}</span> : null}
                  <span className="factor-figure-label"> {s.figure.label}</span>
                </span>
              ) : null}
            </button>
            {open ? (
              <div className="factor-body">
                <Markdown text={s.md} compact />
                {s.chartSpec ? <MiniChart spec={s.chartSpec} /> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
```

`components/report/Timeline.tsx`:

```tsx
"use client";
import type { AnswerBlock } from "@/lib/schema";
import Markdown from "../Markdown";

type TimelineBlock = Extract<AnswerBlock, { kind: "timeline" }>;

// Vertical spine of dated milestones for "how did X evolve" answers.
export default function Timeline({ block }: { block: TimelineBlock }) {
  return (
    <div className="report-timeline">
      {block.events.map((e, i) => (
        <div key={i} className="timeline-event">
          <div className="timeline-marker" aria-hidden />
          <div className="timeline-content">
            <div className="timeline-head">
              <span className="timeline-date">{e.date}</span>
              <span className="timeline-title">{e.title}</span>
              {e.value ? <span className="timeline-value">{e.value}</span> : null}
            </div>
            {e.md ? <div className="timeline-body"><Markdown text={e.md} compact /></div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run components/report/FactorSections.test.tsx components/report/Timeline.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add components/report/FactorSections.tsx components/report/FactorSections.test.tsx components/report/Timeline.tsx components/report/Timeline.test.tsx
git commit -m "feat: FactorSections and Timeline report blocks"
```

---

### Task 13: Wire it all up — AnswerReport switch, CSS, gap badge, trace chip

**Files:**
- Modify: `components/AnswerReport.tsx`, `components/NodeCard.tsx`, `components/TraceNode.tsx`, `app/globals.css`

**Interfaces:**
- Consumes: Tasks 10–12 components; `node.gapFill` (Task 5); `TraceNodeView.gapFill` / `kind:"gap"` (Task 5).
- Produces: the full rendering path for the four new block kinds; a "gap fill" badge on gap research nodes; a gap chip on gap trace rows.

- [ ] **Step 1: Extend `components/AnswerReport.tsx`**

Add imports and switch cases:

```tsx
import ComparisonChart from "./report/ComparisonChart";
import Leaderboard from "./report/Leaderboard";
import FactorSections from "./report/FactorSections";
import Timeline from "./report/Timeline";
// … inside the switch, before `default`:
          case "comparison":
            return <ComparisonChart key={i} block={b} />;
          case "leaderboard":
            return <Leaderboard key={i} block={b} />;
          case "sections":
            return <FactorSections key={i} block={b} />;
          case "timeline":
            return <Timeline key={i} block={b} />;
```

- [ ] **Step 2: Gap badge in `components/NodeCard.tsx`**

In the `isResearch` branch, change the kicker line to:

```tsx
              <div className="synth-kicker">
                Sub-answer
                {node.gapFill ? <span className="gap-badge" title="Fetched by the gap-fill round after the first research pass">gap fill</span> : null}
              </div>
```

- [ ] **Step 3: Gap chip in `components/TraceNode.tsx`**

In the header button, after the `<span className="q">…</span>`:

```tsx
        {(node.kind === "gap" || node.gapFill) && <span className="trace-gap-chip">gap fill</span>}
```

- [ ] **Step 4: Append CSS to `app/globals.css`**

```css
/* ---- report: comparison ---- */
.report-comparison { margin: 10px 0; }
.comparison-legend { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 6px; }
.comparison-chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted, #667); }
.comparison-chip strong { color: inherit; font-variant-numeric: tabular-nums; }
.comparison-swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.comparison-unit { margin-left: auto; font-size: 11px; color: var(--muted, #889); }
.comparison-insight { margin-top: 6px; font-size: 12.5px; font-style: italic; color: var(--muted, #667); }

/* ---- report: leaderboard ---- */
.report-leaderboard { margin: 10px 0; border: 1px solid var(--line-strong, #e2e2e2); border-radius: 10px; overflow: hidden; }
.leaderboard-metric { padding: 7px 12px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted, #889); border-bottom: 1px solid var(--line-strong, #eee); }
.leaderboard-row-wrap + .leaderboard-row-wrap { border-top: 1px solid var(--line-strong, #eee); }
.leaderboard-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 12px; background: none; border: 0; font: inherit; text-align: left; }
button.leaderboard-row { cursor: pointer; }
button.leaderboard-row:hover { background: rgba(0, 0, 0, 0.03); }
.leaderboard-rank { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11.5px; font-weight: 600; background: rgba(0, 0, 0, 0.06); flex: none; }
.leaderboard-rank.top { background: var(--amber, #e8a13c); color: #fff; }
.leaderboard-row-wrap.top .leaderboard-entity { font-weight: 600; }
.leaderboard-entity { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.leaderboard-value { font-variant-numeric: tabular-nums; font-weight: 600; }
.leaderboard-delta { font-size: 11.5px; font-variant-numeric: tabular-nums; }
.leaderboard-delta.up { color: #1a8a4a; }
.leaderboard-delta.down { color: #c0392b; }
.leaderboard-detail { padding: 2px 12px 10px 44px; font-size: 13px; }
.leaderboard-stats { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.leaderboard-stat { font-size: 11.5px; color: var(--muted, #667); background: rgba(0, 0, 0, 0.045); border-radius: 6px; padding: 3px 8px; }
.leaderboard-stat-value { font-weight: 600; color: inherit; font-variant-numeric: tabular-nums; }

/* ---- report: factor sections ---- */
.report-sections { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; }
.factor-section { border: 1px solid var(--line-strong, #e2e2e2); border-radius: 10px; overflow: hidden; }
.factor-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 12px; background: none; border: 0; font: inherit; font-weight: 600; text-align: left; cursor: pointer; }
.factor-head:hover { background: rgba(0, 0, 0, 0.03); }
.factor-title { flex: 1; }
.factor-figure { font-weight: 400; font-size: 12px; color: var(--muted, #667); white-space: nowrap; }
.factor-figure strong { font-size: 13.5px; color: inherit; font-variant-numeric: tabular-nums; }
.factor-figure-label { opacity: 0.8; }
.factor-body { padding: 0 12px 10px 32px; font-size: 13px; }

/* ---- report: timeline ---- */
.report-timeline { margin: 10px 0; padding-left: 4px; }
.timeline-event { position: relative; display: flex; gap: 12px; padding: 0 0 14px 0; }
.timeline-event:not(:last-child)::before { content: ""; position: absolute; left: 5px; top: 14px; bottom: 0; width: 2px; background: var(--line-strong, #e2e2e2); }
.timeline-marker { width: 12px; height: 12px; border-radius: 50%; border: 2.5px solid var(--amber, #e8a13c); background: #fff; flex: none; margin-top: 2px; z-index: 1; }
.timeline-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.timeline-date { font-size: 11.5px; color: var(--muted, #889); font-variant-numeric: tabular-nums; }
.timeline-title { font-weight: 600; }
.timeline-value { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted, #667); }
.timeline-body { font-size: 12.5px; margin-top: 2px; }

/* ---- gap-fill provenance ---- */
.gap-badge { margin-left: 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #7c5db8; background: rgba(124, 93, 184, 0.12); border-radius: 5px; padding: 2px 6px; vertical-align: middle; }
.trace-gap-chip { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #7c5db8; background: rgba(124, 93, 184, 0.12); border-radius: 5px; padding: 1.5px 5px; flex: none; }
```

- [ ] **Step 5: Verify**

Run: `npm test` → all green. Run: `npx tsc --noEmit` → clean. Run: `npm run build` → compiles.
Then use the project's `/verify` flow (or `npm run dev` + a comparison question like "compare Nvidia and AMD revenue") to confirm: gap node renders with the badge, trace shows "analyzing gaps" → gap row with chip → `/v1/contents` calls, and the report renders a comparison block.

- [ ] **Step 6: Commit**

```bash
git add components/AnswerReport.tsx components/NodeCard.tsx components/TraceNode.tsx app/globals.css
git commit -m "feat: render new report blocks + gap-fill badges on canvas and trace"
```

---

## Final verification (after all tasks)

- [ ] `npm test` — entire suite green.
- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run build` — clean.
- [ ] Manual smoke via dev server (real Tako staging keys): one comparison question, one "top N" question, one "what factors" question. Confirm block shapes, gap badges, `/v1/contents` trace rows, and that the canvas layout still packs correctly.

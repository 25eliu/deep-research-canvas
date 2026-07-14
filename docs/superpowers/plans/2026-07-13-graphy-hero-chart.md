# Graphy Hero Chart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-turn "graphy chart" toggle that makes the final synthesis report carry one hero Graphy chart, modeled by an LLM from the Tako card CSVs already grabbed during compose, with every number enforced traceable to those CSVs, rendered via `@graphysdk/core` under the report verdict.

**Architecture:** A `graphyEnabled` flag threads UI → `AgentRequest` → `ResearchCtx.req`. At the end of `composeReport` (`lib/agents/tako/compose.ts`), a new module `lib/agents/tako/graphy.ts` runs one structured LLM call that emits a Graphy `GraphConfig` from the CSV excerpts, prunes/discards untraceable numbers using the existing `allowedSets`/`traceable` machinery, and falls back to a deterministic conversion of the report's first `chart`/`comparison` block on any failure. The result travels as an optional `graphy` field on `zAnswerReport` (deliberately NOT in the `zAnswerBlock` union, so the report-composer LLM can never emit it) and renders client-side in `components/GraphyHero.tsx`.

**Tech Stack:** Next.js 14 / React 18, Zod + Vercel AI SDK `generateObject` (via `lib/llm.ts` `generateStructured`), vitest, `@graphysdk/core` (private npm — needs a Graphy `NPM_TOKEN`).

**Spec:** `docs/superpowers/specs/2026-07-13-graphy-hero-design.md`

## Global Constraints

- OpenAI structured outputs: `lib/llm.ts` sets `structuredOutputs: false`; Zod `.optional()` fields are fine and must NOT be rewritten to all-required (project CLAUDE.md gotcha).
- Immutability everywhere: never mutate inputs; return new objects.
- Never call `tako_agent` / `tako_visualize`; no new Tako endpoints are involved in this feature (CSVs come from the existing per-turn cache).
- No hardcoded secrets: the Graphy npm token comes from the `NPM_TOKEN` env var, never committed.
- Testing is deliberately minimal per Eric: unit tests for schema validation, accuracy enforcement, and fallback converters only. No E2E, no UI tests.
- Test runner: `npx vitest run <file>` (repo script: `npm test` = `vitest run`).
- Commit format: `<type>: <description>` (feat/fix/test/chore...), no attribution footer.

---

### Task 1: Schemas — `zGraphyConfig`, `zGraphyBlock`, report split, request flag

**Files:**
- Modify: `lib/schema.ts` (zChartSpec block at lines 14–21; report schema at line 105; `AgentRequest` at lines 176–186; type exports at lines 148–159)
- Modify: `lib/agents/shared/schemas.ts:7` (re-export line)
- Test: `lib/agents/tako/graphy.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names, all exported from `lib/schema.ts`):
  - `zGraphyConfig` / type `GraphyConfig` — `{ type: "bar"|"column"|"line"|"area"|"pie"|"donut"|"scatter", data: { columns: {key,label}[], rows: Record<string, string|number>[] } }`
  - `zGraphyBlock` / type `GraphyBlock` — `{ title?, subtitle?, config: GraphyConfig }`
  - `zAnswerReportEmit` — the LLM-emit schema (`{verdict, blocks}`, NO graphy field)
  - `zAnswerReport` — `zAnswerReportEmit.extend({ graphy: zGraphyBlock.optional() })`
  - `AgentRequest.graphyEnabled?: boolean`

- [ ] **Step 1: Write the failing schema tests**

Create `lib/agents/tako/graphy.test.ts`:

```ts
// lib/agents/tako/graphy.test.ts
import { describe, it, expect } from "vitest";
import { zGraphyConfig, zAnswerReportEmit, zAnswerReport } from "../../schema";

describe("zGraphyConfig", () => {
  const valid = {
    type: "line",
    data: {
      columns: [{ key: "x", label: "Year" }, { key: "s0", label: "NVDA revenue" }],
      rows: [{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }],
    },
  };

  it("accepts a minimal valid config (string and number cell values)", () => {
    expect(zGraphyConfig.parse(valid)).toEqual(valid);
  });

  it("rejects unknown chart types", () => {
    expect(() => zGraphyConfig.parse({ ...valid, type: "radar" })).toThrow();
  });

  it("rejects configs with fewer than 2 columns or 0 rows", () => {
    expect(() => zGraphyConfig.parse({ ...valid, data: { ...valid.data, columns: [valid.data.columns[0]] } })).toThrow();
    expect(() => zGraphyConfig.parse({ ...valid, data: { ...valid.data, rows: [] } })).toThrow();
  });
});

describe("report schema split", () => {
  it("zAnswerReportEmit REJECTS a graphy field (composer LLM can never emit one)", () => {
    const emit = zAnswerReportEmit.strict();
    expect(() => emit.parse({ verdict: "v", blocks: [], graphy: { config: {} } })).toThrow();
  });

  it("zAnswerReport accepts an optional graphy block", () => {
    const r = zAnswerReport.parse({
      verdict: "v", blocks: [],
      graphy: { title: "t", config: { type: "column", data: { columns: [{ key: "x", label: "" }, { key: "s0", label: "rev" }], rows: [{ x: "2024", s0: 1 }] } } },
    });
    expect(r.graphy?.config.type).toBe("column");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/graphy.test.ts`
Expected: FAIL — `zGraphyConfig` is not exported from `../../schema`.

- [ ] **Step 3: Add the schemas to `lib/schema.ts`**

Insert after the `zChartSpec` definition (after line 21):

```ts
// Graphy hero chart. `config` is the exact shape @graphysdk/core's GraphProvider
// consumes: first column = x/category axis, remaining columns = series. Emitted by
// a dedicated post-compose LLM call (lib/agents/tako/graphy.ts) — NEVER by the
// report composer (see zAnswerReportEmit below). Numbers are enforced traceable to
// this turn's fetched Tako card CSVs before this reaches the client.
export const zGraphyColumn = z.object({ key: z.string(), label: z.string() });
export const zGraphyConfig = z.object({
  type: z.enum(["bar", "column", "line", "area", "pie", "donut", "scatter"]),
  data: z.object({
    columns: z.array(zGraphyColumn).min(2),
    rows: z.array(z.record(z.union([z.string(), z.number()]))).min(1).max(60),
  }),
});
export const zGraphyBlock = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  config: zGraphyConfig,
});
```

Replace line 105 (`export const zAnswerReport = ...`) with:

```ts
// Emit schema (what the report-composer LLM is allowed to produce) vs full report
// (what the synthesis node carries). `graphy` is attached server-side AFTER
// composition by composeGraphyHero — keeping it out of the emit schema means the
// composer model can never invent a graphy block on its own.
export const zAnswerReportEmit = z.object({ verdict: z.string(), blocks: z.array(zAnswerBlock) });
export const zAnswerReport = zAnswerReportEmit.extend({ graphy: zGraphyBlock.optional() });
```

In the type-exports section (around lines 148–159), add:

```ts
export type GraphyConfig = z.infer<typeof zGraphyConfig>;
export type GraphyBlock = z.infer<typeof zGraphyBlock>;
```

In `AgentRequest` (lines 176–186), add below `takoAnswerEnabled?: boolean;`:

```ts
  graphyEnabled?: boolean; // per-turn "graphy chart" toggle → hero Graphy chart on the report
```

- [ ] **Step 4: Extend the shared re-export**

In `lib/agents/shared/schemas.ts` change line 7 to:

```ts
export { zAnswerBlock, zAnswerReport, zAnswerReportEmit, zGraphyBlock, zGraphyConfig } from "../../schema";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/graphy.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Verify nothing else broke, commit**

Run: `npx tsc --noEmit && npm test`
Expected: type-check clean; full suite green (the report schema change is additive).

```bash
git add lib/schema.ts lib/agents/shared/schemas.ts lib/agents/tako/graphy.test.ts
git commit -m "feat(schema): zGraphyConfig/zGraphyBlock + emit/report split + graphyEnabled flag"
```

---

### Task 2: `graphy.ts` pure core — accuracy enforcement + deterministic fallback converter

**Files:**
- Create: `lib/agents/tako/graphy.ts`
- Modify: `lib/agents/tako/compose.ts:91` (export the `traceable` helper)
- Test: `lib/agents/tako/graphy.test.ts` (extend)

**Interfaces:**
- Consumes: `traceable(value: string, allowed: {strings: Set<string>; mags: number[]}): boolean` and `allowedSets` from `./compose`; `GraphyConfig`, `GraphyBlock`, `ChartSpec`, `AnswerBlock` types from `../../schema`.
- Produces (exact exports later tasks use):
  - `enforceTraceable(config: GraphyConfig, allowed: {strings: Set<string>; mags: number[]}, drop: (why: string) => void): GraphyConfig | null`
  - `seriesToGraphyConfig(kind: "bar" | "line", series: { label: string; points: { x: string | number; y: number }[] }[]): GraphyConfig`
  - `fallbackGraphyBlock(blocks: AnswerBlock[]): GraphyBlock | null`

- [ ] **Step 1: Export `traceable` from compose.ts**

In `lib/agents/tako/compose.ts` line 91, change `function traceable(` to `export function traceable(`. (Its doc comment stays.)

- [ ] **Step 2: Write the failing tests**

Append to `lib/agents/tako/graphy.test.ts`:

```ts
import { enforceTraceable, seriesToGraphyConfig, fallbackGraphyBlock } from "./graphy";
import { allowedSets } from "./compose";
import type { AnswerBlock, GraphyConfig } from "../../schema";

// Allowed figures mimic what csvFigures extracts from a fetched card CSV.
const ALLOWED = allowedSets([
  { label: "NVDA Revenue 2023", value: "26974" },
  { label: "NVDA Revenue 2024", value: "60922" },
  { label: "AMD Revenue 2024", value: "25785" },
]);

function cfg(rows: Record<string, string | number>[]): GraphyConfig {
  return {
    type: "column",
    data: {
      columns: [{ key: "x", label: "Year" }, { key: "s0", label: "Revenue" }],
      rows,
    },
  };
}

describe("enforceTraceable — every number must come from Tako card contents", () => {
  it("passes a fully traceable config through unchanged (x-axis labels exempt)", () => {
    const c = cfg([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }]);
    expect(enforceTraceable(c, ALLOWED, () => {})).toEqual(c);
  });

  it("drops rows whose numeric values are untraceable, keeps the rest", () => {
    const c = cfg([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }, { x: "2025", s0: 999999 }]);
    const out = enforceTraceable(c, ALLOWED, () => {});
    expect(out?.data.rows).toEqual([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }]);
  });

  it("does not mutate the input config", () => {
    const c = cfg([{ x: "2023", s0: 26974 }, { x: "2025", s0: 999999 }, { x: "2024", s0: 60922 }]);
    const snapshot = JSON.parse(JSON.stringify(c));
    enforceTraceable(c, ALLOWED, () => {});
    expect(c).toEqual(snapshot);
  });

  it("discards the whole config when most numeric values are untraceable", () => {
    const drops: string[] = [];
    const c = cfg([{ x: "2023", s0: 111 }, { x: "2024", s0: 222 }, { x: "2025", s0: 26974 }]);
    expect(enforceTraceable(c, ALLOWED, (w) => drops.push(w))).toBeNull();
    expect(drops.length).toBeGreaterThan(0);
  });

  it("discards a config left with fewer than 2 rows", () => {
    const c = cfg([{ x: "2024", s0: 60922 }, { x: "2025", s0: 42 }]);
    expect(enforceTraceable(c, ALLOWED, () => {})).toBeNull();
  });

  it("matches values by magnitude within 0.5% (formatted values like $26,974 pass)", () => {
    const c = cfg([{ x: "2023", s0: "$26,974" }, { x: "2024", s0: "60,922" }]);
    expect(enforceTraceable(c, ALLOWED, () => {})).not.toBeNull();
  });
});

describe("seriesToGraphyConfig — deterministic fallback from existing report blocks", () => {
  const series = [
    { label: "NVDA", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }] },
    { label: "AMD", points: [{ x: "2024", y: 25785 }] },
  ];

  it("converts multi-series points to columns+rows, bar→column, aligning by x", () => {
    const out = seriesToGraphyConfig("bar", series);
    expect(out.type).toBe("column");
    expect(out.data.columns).toEqual([
      { key: "x", label: "Category" },
      { key: "s0", label: "NVDA" },
      { key: "s1", label: "AMD" },
    ]);
    expect(out.data.rows).toEqual([
      { x: "2023", s0: 26974 },
      { x: "2024", s0: 60922, s1: 25785 },
    ]);
  });

  it("keeps line as line", () => {
    expect(seriesToGraphyConfig("line", series).type).toBe("line");
  });
});

describe("fallbackGraphyBlock — first chart/comparison block wins", () => {
  const chartBlock: AnswerBlock = {
    kind: "chart", title: "Revenue",
    chartSpec: { kind: "line", series: [{ label: "NVDA", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }] }] },
  };
  const comparisonBlock: AnswerBlock = {
    kind: "comparison", title: "NVDA vs AMD",
    series: [{ label: "NVDA", entity: "NVIDIA", points: [{ x: "2024", y: 60922 }] }],
  };

  it("converts the first chart block (already validated by composeReport)", () => {
    const out = fallbackGraphyBlock([{ kind: "prose", md: "hi" }, chartBlock, comparisonBlock]);
    expect(out?.title).toBe("Revenue");
    expect(out?.config.type).toBe("line");
    expect(out?.config.data.rows).toHaveLength(2);
  });

  it("converts a comparison block when no chart block exists (comparison → line)", () => {
    const out = fallbackGraphyBlock([comparisonBlock]);
    expect(out?.title).toBe("NVDA vs AMD");
    expect(out?.config.type).toBe("line");
  });

  it("returns null when no convertible block exists", () => {
    expect(fallbackGraphyBlock([{ kind: "prose", md: "hi" }])).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/graphy.test.ts`
Expected: FAIL — `./graphy` module does not exist.

- [ ] **Step 4: Implement `lib/agents/tako/graphy.ts` (pure parts)**

```ts
// Graphy hero chart layer. When the per-turn "graphy chart" toggle is on, the
// synthesis report gains ONE flagship Graphy chart modeled from the Tako card CSVs
// the compose step already fetched. Accuracy is ENFORCED, not assumed: every
// numeric cell (x/category column exempt, mirroring validateBlock's table rule)
// must trace to a fetched figure or the row is dropped; a mostly-untraceable or
// degenerate config is discarded entirely and the deterministic fallback — the
// report's first (already-validated) chart/comparison block converted to a
// GraphConfig — takes its place. The Graphy chart can never show a number Tako
// didn't return this turn.
import type { AnswerBlock, GraphyBlock, GraphyConfig } from "../../schema";
import { traceable } from "./compose";

const MAX_ROWS = 60; // keep the node card light

type Allowed = { strings: Set<string>; mags: number[] };

// Prune untraceable rows; discard the config when the chart would misrepresent the
// data: majority of numeric cells untraceable (same 2× rule as compose's table
// validation) or fewer than 2 surviving rows.
export function enforceTraceable(
  config: GraphyConfig, allowed: Allowed, drop: (why: string) => void,
): GraphyConfig | null {
  const xKey = config.data.columns[0]?.key;
  let numeric = 0, bad = 0;
  const rowOk = config.data.rows.map((row) => {
    let ok = true;
    for (const [key, value] of Object.entries(row)) {
      if (key === xKey) continue; // x/category labels (years, entity names) are exempt
      if (!/\d/.test(String(value))) continue; // pure text cell
      numeric++;
      if (!traceable(String(value), allowed)) {
        bad++;
        ok = false;
        drop(`graphy cell ${key}:${value}`);
      }
    }
    return ok;
  });
  if (bad === 0 && config.data.rows.length >= 2) return config;
  if (bad * 2 > numeric) return null;
  const rows = config.data.rows.filter((_, i) => rowOk[i]);
  if (rows.length < 2) return null;
  return { ...config, data: { ...config.data, rows } };
}

// Convert chartSpec-shaped series (shared by "chart" and "comparison" blocks) to a
// GraphConfig: first column = x, one column per series, rows aligned by x value.
export function seriesToGraphyConfig(
  kind: "bar" | "line",
  series: { label: string; points: { x: string | number; y: number }[] }[],
): GraphyConfig {
  const xs: (string | number)[] = [];
  const seen = new Set<string>();
  for (const s of series) for (const p of s.points) {
    const k = String(p.x);
    if (!seen.has(k)) { seen.add(k); xs.push(p.x); }
  }
  const columns = [
    { key: "x", label: "Category" },
    ...series.map((s, i) => ({ key: `s${i}`, label: s.label })),
  ];
  const rows = xs.slice(0, MAX_ROWS).map((x) => {
    const row: Record<string, string | number> = { x: typeof x === "number" ? x : String(x) };
    series.forEach((s, i) => {
      const p = s.points.find((pt) => String(pt.x) === String(x));
      if (p) row[`s${i}`] = p.y;
    });
    return row;
  });
  return { type: kind === "bar" ? "column" : "line", data: { columns, rows } };
}

// Deterministic fallback: the report's first chart or comparison block already
// passed composeReport's numeric validation, so its conversion needs no re-check.
export function fallbackGraphyBlock(blocks: AnswerBlock[]): GraphyBlock | null {
  for (const b of blocks) {
    if (b.kind === "chart") {
      return { ...(b.title ? { title: b.title } : {}), config: seriesToGraphyConfig(b.chartSpec.kind, b.chartSpec.series) };
    }
    if (b.kind === "comparison") {
      return { ...(b.title ? { title: b.title } : {}), config: seriesToGraphyConfig("line", b.series) };
    }
  }
  return null;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/graphy.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/graphy.ts lib/agents/tako/graphy.test.ts lib/agents/tako/compose.ts
git commit -m "feat(tako): graphy accuracy enforcement + deterministic fallback converter"
```

---

### Task 3: `composeGraphyHero` — the LLM modeling call

**Files:**
- Modify: `lib/agents/tako/graphy.ts` (add `composeGraphyHero`)
- Modify: `lib/agents/tako/prompts.ts` (add `GRAPHY_SYSTEM`)
- Test: `lib/agents/tako/graphy.test.ts` (extend)

**Interfaces:**
- Consumes: `generateStructured` from `../../llm` (signature used exactly as in `compose.ts:391`); `zGraphyBlock` from `../shared/schemas`; `ResearchCtx` type from `./flow`; `enforceTraceable` / `fallbackGraphyBlock` from Task 2.
- Produces: `composeGraphyHero(ctx: ResearchCtx, question: string, verdict: string, blocks: AnswerBlock[], cardContents: { cardId: string; title?: string; data: string }[], allowed: {strings: Set<string>; mags: number[]}): Promise<GraphyBlock | null>` — Task 4 calls this from `composeReport`.

- [ ] **Step 1: Write the failing tests**

Append to `lib/agents/tako/graphy.test.ts`. NOTE: the `vi.mock` factory must be added near the top of the file (after the existing imports of `vitest`), because `vi.mock` is hoisted; put the `h` state object above all imports via `vi.hoisted`:

```ts
// -- at the very top of the file, before other imports --
import { vi } from "vitest";
const h = vi.hoisted(() => ({
  hero: null as unknown, // what the mocked graphy-hero LLM call returns
  heroFails: false,
}));
vi.mock("../../llm", () => ({
  generateStructured: vi.fn(async (opts: { label: string }) => {
    if (opts.label === "graphy-hero") {
      if (h.heroFails) throw new Error("model down");
      return h.hero;
    }
    return {};
  }),
  // compose.ts (imported for allowedSets/traceable) also pulls this from ../../llm —
  // the factory must provide it or the import binding is undefined.
  generateWithTools: vi.fn(async () => ({ text: "", steps: 0 })),
}));
```

Then append the suite (with the other tests):

```ts
import { composeGraphyHero } from "./graphy";
import { newResearchCtx } from "./research";
import { FindingLedger } from "./findings";
import type { AgentRequest } from "../../schema";

function heroCtx() {
  const req: AgentRequest = {
    canvasId: "c", message: "compare NVDA and AMD revenue", surface: "main",
    canvasState: { nodes: [], edges: [] }, providerId: "tako",
    takoAnswerEnabled: true, graphyEnabled: true, history: [],
  };
  return newResearchCtx(req, new FindingLedger(), () => {});
}

const CARD_CONTENTS = [{ cardId: "nvda", title: "NVDA Revenue", data: "Year,Revenue\n2023,26974\n2024,60922" }];
const GOOD_HERO = {
  title: "NVDA revenue surge",
  config: {
    type: "column",
    data: {
      columns: [{ key: "x", label: "Year" }, { key: "s0", label: "Revenue ($M)" }],
      rows: [{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }],
    },
  },
};
const CHART_BLOCK: AnswerBlock = {
  kind: "chart", title: "Revenue",
  chartSpec: { kind: "bar", series: [{ label: "NVDA", points: [{ x: "2023", y: 26974 }, { x: "2024", y: 60922 }] }] },
};

describe("composeGraphyHero", () => {
  it("returns the LLM-modeled block when every number traces to card contents", async () => {
    h.heroFails = false; h.hero = GOOD_HERO;
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [], CARD_CONTENTS, ALLOWED);
    expect(out?.title).toBe("NVDA revenue surge");
    expect(out?.config.data.rows).toHaveLength(2);
  });

  it("falls back to the report's chart block when the modeled numbers are untraceable", async () => {
    h.heroFails = false;
    h.hero = { ...GOOD_HERO, config: { ...GOOD_HERO.config, data: { ...GOOD_HERO.config.data, rows: [{ x: "2023", s0: 111 }, { x: "2024", s0: 222 }] } } };
    const ctx = heroCtx();
    const out = await composeGraphyHero(ctx, "q", "verdict", [CHART_BLOCK], CARD_CONTENTS, ALLOWED);
    expect(out?.config.type).toBe("column"); // converted bar chartSpec, not the fabricated config
    expect(out?.config.data.rows).toEqual([{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }]);
    expect(ctx.notes.some((n) => n.includes("graphy"))).toBe(true);
  });

  it("falls back when the LLM call throws", async () => {
    h.heroFails = true;
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [CHART_BLOCK], CARD_CONTENTS, ALLOWED);
    expect(out?.config.data.rows).toHaveLength(2);
  });

  it("returns null (silent degradation) when the LLM fails and no convertible block exists", async () => {
    h.heroFails = true;
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [{ kind: "prose", md: "p" }], CARD_CONTENTS, ALLOWED);
    expect(out).toBeNull();
  });

  it("skips the LLM entirely when there are no card contents (straight to fallback)", async () => {
    h.heroFails = false; h.hero = GOOD_HERO;
    const { generateStructured } = await import("../../llm");
    (generateStructured as ReturnType<typeof vi.fn>).mockClear();
    const out = await composeGraphyHero(heroCtx(), "q", "verdict", [CHART_BLOCK], [], ALLOWED);
    expect(generateStructured).not.toHaveBeenCalled();
    expect(out?.config.data.rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/graphy.test.ts`
Expected: FAIL — `composeGraphyHero` is not exported. (The Task 1/2 tests must still PASS — the `../../llm` mock touches nothing they use.)

- [ ] **Step 3: Add `GRAPHY_SYSTEM` to `lib/agents/tako/prompts.ts`**

Append at the end of the file:

```ts
// Graphy hero chart modeler. One call, tool-free, after the report is composed.
// The ONLY numbers it may use are the CARD_CONTENTS series values — enforcement
// (lib/agents/tako/graphy.ts) drops anything untraceable, so invented values are
// wasted output, not a risk.
export const GRAPHY_SYSTEM = `You design ONE flagship chart that captures the answer's thesis.
Input: the research QUESTION, the report VERDICT, and CARD_CONTENTS — real data series
(CSV excerpts) fetched from Tako this turn.

Emit a Graphy chart config:
- "type": one of bar | column | line | area | pie | donut | scatter. Time series → line/area;
  category comparison → column/bar; share-of-whole (sums to a total) → pie/donut.
- "data.columns": first column is the x-axis/category (its "key" MUST be the key used in rows);
  every later column is one series with a human label including the unit (e.g. "Revenue ($M)").
- "data.rows": one record per x value, keys matching the column keys.
- "title": a short assertive headline stating the takeaway (not a topic label);
  "subtitle": one line of context (period, unit, source scope).

HARD RULES:
- Copy every numeric value VERBATIM from CARD_CONTENTS. Never compute, extrapolate,
  interpolate, or round beyond what the CSV shows. Values not present in CARD_CONTENTS
  will be stripped by validation.
- Pick the series that best supports the VERDICT; 1-4 series, at most 60 rows.
- Keep row order meaningful (chronological for time series, ranked for comparisons).`;
```

- [ ] **Step 4: Implement `composeGraphyHero` in `lib/agents/tako/graphy.ts`**

Add these imports at the top of the file:

```ts
import { generateStructured } from "../../llm";
import { zGraphyBlock } from "../shared/schemas";
import { GRAPHY_SYSTEM } from "./prompts";
import { log } from "../../log";
import type { ResearchCtx } from "./flow";
```

And a model helper + the function (append at the end):

```ts
// Same model family as the report emit (compose.ts deepModel) — chart modeling is
// part of the synthesis tail; effort stays low, the input is a small digest.
const heroModel = () => process.env.SYNTH_MODEL || "gpt-5.4";

// Model ONE hero Graphy chart from this turn's fetched card CSVs. Failure is never
// user-facing: LLM error, schema mismatch, or accuracy-validation discard all fall
// back to converting the report's first (already validated) chart/comparison block;
// with no convertible block the report simply ships without a hero.
export async function composeGraphyHero(
  ctx: ResearchCtx, question: string, verdict: string, blocks: AnswerBlock[],
  cardContents: { cardId: string; title?: string; data: string }[],
  allowed: Allowed,
): Promise<GraphyBlock | null> {
  if (cardContents.length > 0) {
    try {
      const hero = await generateStructured({
        provider: "openai", model: heroModel(), reasoningEffort: "low",
        system: GRAPHY_SYSTEM,
        prompt: `QUESTION: ${question}\n\nVERDICT: ${verdict}\n\nCARD_CONTENTS: ${JSON.stringify(cardContents)}`,
        schema: zGraphyBlock, label: "graphy-hero",
      });
      let dropped = 0;
      const config = enforceTraceable(hero.config, allowed, () => { dropped++; });
      if (config) {
        if (dropped > 0) log("tako", "graphy-hero pruned untraceable cells", { dropped });
        return { ...hero, config };
      }
      ctx.notes.push(`graphy hero discarded — ${dropped} untraceable values, using fallback`);
    } catch (e: unknown) {
      ctx.notes.push(`graphy hero failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    ctx.notes.push("graphy hero skipped — no card contents fetched this turn");
  }
  const fallback = fallbackGraphyBlock(blocks);
  if (!fallback) log("tako", "graphy hero unavailable — no convertible block");
  return fallback;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run lib/agents/tako/graphy.test.ts`
Expected: PASS (all suites).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/graphy.ts lib/agents/tako/graphy.test.ts lib/agents/tako/prompts.ts
git commit -m "feat(tako): composeGraphyHero — LLM-modeled hero chart with enforced traceability"
```

---

### Task 4: Wire the hero into `composeReport` and the agent route

**Files:**
- Modify: `lib/agents/tako/compose.ts` (import at line 16; emit schema at line 393; return path at lines 414–429)
- Modify: `app/api/agent/route.ts:22` (flag default) and `:32` (log field)
- Test: `lib/agents/tako/compose.report.test.ts` (one new case + mock extension)

**Interfaces:**
- Consumes: `composeGraphyHero` (Task 3 signature), `zAnswerReportEmit` (Task 1), `ctx.req.graphyEnabled`.
- Produces: `composeReport` return value now carries `graphy?: GraphyBlock`; `AgentRequest.graphyEnabled` defaults to `false` at the route boundary.

- [ ] **Step 1: Extend the existing mock + add the failing test**

In `lib/agents/tako/compose.report.test.ts`:

(a) add `hero: null as any,` to the `vi.hoisted` state object (line ~4-11);

(b) in the `generateStructured` mock (line ~14-18), add a branch before the fallback return:

```ts
    if (opts.label === "graphy-hero") return h.hero;
```

(c) append a new test inside the existing `describe` (the file's `ctxWithCard()` helper builds a ctx whose card CSV is `h.csv` = NVDA revenue 26974/60922; reuse it, flipping the request flag):

```ts
  it("graphyEnabled:true attaches a validated graphy hero to the report", async () => {
    h.report = { verdict: "NVDA leads", blocks: [] };
    h.hero = {
      title: "Revenue doubles",
      config: {
        type: "column",
        data: {
          columns: [{ key: "x", label: "Year" }, { key: "s0", label: "Revenue" }],
          rows: [{ x: "2023", s0: 26974 }, { x: "2024", s0: 60922 }],
        },
      },
    };
    const ctx = ctxWithCard();
    ctx.req.graphyEnabled = true;
    const report = await composeReport(ctx, "how is NVDA revenue");
    expect(report?.graphy?.title).toBe("Revenue doubles");
  });

  it("graphyEnabled unset → no graphy field and no graphy-hero LLM call", async () => {
    h.report = { verdict: "v", blocks: [] };
    const report = await composeReport(ctxWithCard(), "how is NVDA revenue");
    expect(report?.graphy).toBeUndefined();
  });
```

(If `ctx.req` is typed readonly in the helper, spread a new req instead: build the ctx from `{ ...baseReq, graphyEnabled: true }` following the file's existing request-construction pattern.)

- [ ] **Step 2: Run tests to verify the new case fails**

Run: `npx vitest run lib/agents/tako/compose.report.test.ts`
Expected: the new `graphyEnabled:true` case FAILS (`report.graphy` undefined); existing cases PASS.

- [ ] **Step 3: Wire `composeReport`**

In `lib/agents/tako/compose.ts`:

(a) line 16, import the emit schema instead of the full one for the LLM call, and the hero composer:

```ts
import { zAnswerReportEmit } from "../shared/schemas";
import { composeGraphyHero } from "./graphy";
```

(remove `zAnswerReport` from that import if now unused), and add `GraphyBlock` to the type import at line 11: `import type { AnswerReport, AnswerBlock, GraphyBlock } from "../../schema";`

(b) line 393, change `schema: zAnswerReport` to `schema: zAnswerReportEmit` (the local `report` variable's type annotation at line 389 becomes `z.infer<typeof zAnswerReportEmit>` — or simply let TS infer by removing the annotation);

(c) replace the final return (line 428) with:

```ts
  // Graphy hero: modeled AFTER validation so it can reuse `allowed` (the full
  // figure + CSV-cache set) and the already-validated `blocks` for its fallback.
  let graphy: GraphyBlock | null = null;
  if (ctx.req.graphyEnabled) {
    graphy = await composeGraphyHero(ctx, question, report.verdict, blocks, cardContents, allowed);
  }
  return { verdict: report.verdict, blocks, ...(graphy ? { graphy } : {}) };
```

(`cardContents` and `allowed` are in scope from lines 377 and 414.)

- [ ] **Step 4: Wire the route boundary**

In `app/api/agent/route.ts`:

- after line 22 (`takoAnswerEnabled: ...`), add:

```ts
    graphyEnabled: body.graphyEnabled ?? false,
```

- after line 32 (`takoAnswer: ...` in the timer fields), add:

```ts
    graphy: request.graphyEnabled,
```

- [ ] **Step 5: Run the affected suites + type-check**

Run: `npx vitest run lib/agents/tako/compose.report.test.ts lib/agents/tako/graphy.test.ts lib/agents/tako/pipeline.test.ts && npx tsc --noEmit`
Expected: PASS / clean. (pipeline.test.ts exercises `composeReport` through `runResearchTree` — its requests don't set `graphyEnabled`, so behavior is unchanged.)

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/compose.ts lib/agents/tako/compose.report.test.ts app/api/agent/route.ts
git commit -m "feat(tako): attach graphy hero to composed report behind graphyEnabled flag"
```

---

### Task 5: UI toggle — session field, GraphySwitch, Landing + topbar, request body

**Files:**
- Modify: `lib/sessions.ts` (Session interface line ~35; `newSession()` line ~56)
- Modify: `components/ProviderControls.tsx` (add `GraphySwitch` after `TakoSwitch`)
- Modify: `components/Landing.tsx` (props + controls row)
- Modify: `app/page.tsx` (request body line 104; topbar line ~692; Landing props line ~698)

No tests (UI, minimal-testing scope). Mirror the `takoAnswer` pattern exactly.

**Interfaces:**
- Consumes: `AgentRequest.graphyEnabled` (Task 1).
- Produces: `Session.graphy: boolean` (default `false`); `GraphySwitch({checked, onChange})` component.

- [ ] **Step 1: Session state**

In `lib/sessions.ts` add to the `Session` interface after `takoAnswer: boolean;`:

```ts
  graphy: boolean; // per-turn hero Graphy chart on the synthesis report
```

and in `newSession()` after `takoAnswer: true,`:

```ts
    graphy: false,
```

(Persisted legacy sessions lack the field; `undefined` reads as off, which is the correct default — no migration needed.)

- [ ] **Step 2: GraphySwitch**

In `components/ProviderControls.tsx`, append after `TakoSwitch`:

```tsx
export function GraphySwitch({
  checked, onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      graphy chart
    </label>
  );
}
```

- [ ] **Step 3: Landing**

In `components/Landing.tsx`:

- import: `import { ProviderSeg, TakoSwitch, GraphySwitch } from "./ProviderControls";`
- add props `graphy: boolean; setGraphy: (v: boolean) => void;` to the signature and destructuring (after `setTakoAnswer`);
- in the controls row (line ~56-59), after `<TakoSwitch ... />`:

```tsx
          <GraphySwitch checked={graphy} onChange={setGraphy} />
```

- [ ] **Step 4: page.tsx wiring**

In `app/page.tsx`:

- import `GraphySwitch` alongside the existing `ProviderSeg, TakoSwitch` import;
- request body (line 104): after `takoAnswerEnabled: snap.takoAnswer,` add `graphyEnabled: snap.graphy,`;
- topbar (line ~692), after the `TakoSwitch` line:

```tsx
            <GraphySwitch checked={active.graphy} onChange={(v) => patchActive((s) => ({ ...s, graphy: v }))} />
```

- Landing usage (line ~698): add

```tsx
        graphy={active.graphy}
        setGraphy={(v) => patchActive((s) => ({ ...s, graphy: v }))}
```

- [ ] **Step 5: Type-check + full suite, commit**

Run: `npx tsc --noEmit && npm test`
Expected: clean / green. (`active.graphy` may be `undefined` on legacy sessions — if `tsc` complains about `boolean | undefined`, pass `active.graphy ?? false` / `!!active.graphy` at the three usage sites.)

```bash
git add lib/sessions.ts components/ProviderControls.tsx components/Landing.tsx app/page.tsx
git commit -m "feat(ui): graphy chart toggle (landing + topbar) threaded to the agent request"
```

---

### Task 6: Client render — `GraphyHero` + report slot

> **REVISED 2026-07-13 (Eric's decision):** `@graphysdk/core` is private npm, no
> credentials exist, and Graphy has no anonymous create-and-embed API. Task 6 now
> renders the GraphyConfig LOCALLY with recharts (existing chart idioms from
> `components/charts/theme.ts`); the SDK swap happens later behind the same
> component boundary when a token exists. Steps 1 (npm install gate) and the SDK
> import in Step 2 are superseded — see the revised task brief
> (`.superpowers/sdd/task-6-brief.md`) for the executed version. The original
> text below is kept for the eventual SDK swap-in.

#### Original (superseded) task text — kept for the future SDK swap

**Files:**
- Modify: `.npmrc` (create if absent; token via env, never inline)
- Modify: `package.json` / `package-lock.json` (dependency)
- Create: `components/GraphyHero.tsx`
- Modify: `components/AnswerReport.tsx` (import + verdict slot, lines 2–17)
- Modify: `app/globals.css` (one small block)

**Interfaces:**
- Consumes: `report.graphy` (`GraphyBlock` from `@/lib/schema`), `GraphProvider` + `Graph` from `@graphysdk/core`.
- Produces: `<GraphyHero block={GraphyBlock} />` rendered between the report verdict and the block list.

- [ ] **Step 1: Install gate — HARD STOP if no token**

`@graphysdk/core` is a private package (verified: public npm returns 404). It requires a Graphy npm token.

```bash
# 1. Check for the token:
[ -n "$NPM_TOKEN" ] && echo "token present" || echo "TOKEN MISSING"
```

**If TOKEN MISSING: STOP. Ask Eric for the Graphy npm token (from the Graphy console / docs.graphy.dev onboarding) before continuing this task.** Tasks 1–5 are complete and shippable without this task; do not fake the render layer.

With the token available, create/append `.npmrc` at the repo root (the literal string `${NPM_TOKEN}` — npm expands it from the environment; never paste the token itself):

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

Then:

```bash
npm install @graphysdk/core
git status --short  # confirm only package.json/package-lock.json (+.npmrc) changed
```

Expected: install succeeds. Confirm `.npmrc` contains no literal secret before committing it; if it does, remove the file from the commit and rotate the token.

- [ ] **Step 2: `components/GraphyHero.tsx`**

```tsx
"use client";
import { Component, type ReactNode } from "react";
import { GraphProvider, Graph } from "@graphysdk/core";
import type { GraphyBlock } from "@/lib/schema";

// A render error in the third-party chart must never take down the synthesis node
// card — fail to nothing (the report's own blocks still carry the data).
class GraphyBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function GraphyHero({ block }: { block: GraphyBlock }) {
  return (
    <GraphyBoundary>
      <div className="report-graphy">
        {block.title ? <div className="report-chart-title">{block.title}</div> : null}
        {block.subtitle ? <div className="report-graphy-subtitle">{block.subtitle}</div> : null}
        <GraphProvider config={block.config}>
          <Graph />
        </GraphProvider>
      </div>
    </GraphyBoundary>
  );
}
```

NOTE for the implementer: the `GraphProvider config={...}` / `<Graph />` usage follows https://docs.graphy.dev/core/quickstart.md. After installing, check the package's exported types — if the provider prop or component names differ (e.g. a `readonly`/`mode` prop is required for non-editable rendering), follow the package's types, keep the readonly/default mode, and keep the boundary + wrapper div exactly as above.

- [ ] **Step 3: Report slot**

In `components/AnswerReport.tsx`:

- add `import GraphyHero from "./GraphyHero";` after the other component imports (line ~8);
- insert between the verdict div (line 17) and the block map (line 18):

```tsx
      {report.graphy ? <GraphyHero block={report.graphy} /> : null}
```

- [ ] **Step 4: Styles**

In `app/globals.css`, next to the existing `.report-chart` rules (search for `.report-chart-title`), add:

```css
.report-graphy { margin: 10px 0 14px; }
.report-graphy-subtitle { font-size: 12px; opacity: 0.65; margin: -2px 0 8px; }
.report-graphy :is(svg, canvas, div) { max-width: 100%; }
```

- [ ] **Step 5: Verify build + suite, commit**

Run: `npx tsc --noEmit && npm test && npm run build`
Expected: all clean. The build exercising the `@graphysdk/core` import is the real gate here.

```bash
git add .npmrc package.json package-lock.json components/GraphyHero.tsx components/AnswerReport.tsx app/globals.css
git commit -m "feat(ui): GraphyHero — render the graphy hero chart in the synthesis report"
```

---

### Task 7: End-to-end verification (manual, dev server)

**Files:** none (verification only).

- [ ] **Step 1: Full suite + build**

Run: `npm test && npm run build`
Expected: green / clean.

- [ ] **Step 2: Live check**

```bash
npm run dev
```

In the browser (http://localhost:3000):

1. On the landing screen, flip the **graphy chart** switch ON (next to "tako answer").
2. Ask: `Compare NVDA and AMD on revenue growth` (provider: LLM + Tako).
3. When the run completes and the camera focuses the synthesis node, confirm: a Graphy chart renders directly under the bold verdict, above the other report blocks, with a takeaway-style title.
4. Hover/interact with the chart — no console errors; the node card resizes correctly (the card's ResizeObserver in `NodeCard.tsx` handles height).
5. Repeat the same question with the switch OFF — confirm no Graphy chart and no `graphy-hero` entry in the server logs.
6. Server logs: on the ON run, look for the `graphy-hero` label in the LLM logs and (if any) `graphy-hero pruned untraceable cells` — pruning is fine, a discard falls back silently.

- [ ] **Step 3: Wrap up**

Use the superpowers:finishing-a-development-branch skill (current branch: `stage1-agentic-core`) to decide merge/PR handling with Eric.

# Graph-Grounded Cohort Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cohort questions ("compare Nvidia to its competitors", "all NBA teams by attendance") resolve their member roster from the Tako graph's new `/related` overview (exhaustive, pre-resolved node ids) instead of LLM extraction from `/v1/answer` prose — plus the `~/.claude/skills/tako-graph-agent` skill is updated with battery-verified documentation of the new response shape.

**Architecture:** A new `graphOverview()` client reads the overview form (`relations: GraphRelation[]`); `QueryStrategy` gains an optional `cohortRoster()` method implemented only by `graphStrategy` (so `searchStrategy` keeps today's behavior by construction); research.ts tries the roster first and falls back to the existing takoAnswer path. Cohort members carry pre-resolved node ids into per-member leaves via a code-only `GraphLookup.node` field, letting `resolveGraph` skip entity search. Spec: `docs/superpowers/specs/2026-07-12-graph-grounded-cohort-resolution-design.md`.

**Tech Stack:** Next 14 / TypeScript, vitest (`npm test` = `vitest run`), Vercel AI SDK `generateObject` via `lib/llm.ts`, Tako graph API on `staging.tako.com`.

## Global Constraints

- Tako host MUST be `staging.tako.com` in this repo (`trytako.com` is Cloudflare-blocked); graph base is `${TAKO_HOST}/api/beta/graph`.
- Never call `tako_agent` / `tako_visualize`.
- Immutability: never mutate existing objects/arrays — build new ones (`{...s, lookup: {...}}`).
- LLM-facing Zod schemas keep `.optional()` fields (OpenAI strict structured outputs is OFF — see CLAUDE.md); do NOT add `node` to any Zod schema, only to the plain `GraphLookup` interface.
- Graph failures never throw past the strategy seam: `ctx.notes` + trace records, return null/empty.
- All graph calls made by the cohort path are recorded as `GraphCallRecord`s and mirrored live via `graph_call` events (existing `recorded*` pattern in strategy.ts).
- Test command: `npx vitest run <file>` from the repo root `/Users/eric/tako_test_projects/canvas-tako`.
- Commit after every task; conventional commits; attribution disabled.

---

### Task 1: Graph client — `graphOverview` + `relation=` param migration

**Files:**
- Modify: `lib/agents/tako/graph.ts`
- Modify: `lib/agents/shared/types.ts:38` (add `relation?` to `GraphCallRecord.params`)
- Modify: `lib/agents/tako/strategy.ts` (mechanical: `relationType: "metric"` → `relation: "metrics"` at the two call sites + `recordedRelated` opts)
- Modify: `lib/agents/tako/strategy.test.ts` (mock + any assertions naming `relationType`)
- Create: `lib/agents/tako/graph.test.ts`

**Interfaces:**
- Consumes: existing `get()` helper, `GraphNode`, `GraphItem` in graph.ts.
- Produces (later tasks rely on these exact names):
  - `export interface GraphRelation { key: string; kind: string; label: string; total: number; totalCapped: boolean; items: GraphItem[] }`
  - `export async function graphOverview(nodeId: string): Promise<{ node: GraphNode; relations: GraphRelation[] }>`
  - `graphRelated(nodeId, opts: { relation: string; q?: string; limit?: number }): Promise<GraphItem[]>` — `relation` accepts fixed keys (`"metrics"`, `"entities"`) AND named-edge keys (`"rel:has_team"`).

- [ ] **Step 1: Write the failing tests**

Create `lib/agents/tako/graph.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Live-verified fixture shape (staging.tako.com, 2026-07-12, NVIDIA node).
const OVERVIEW_JSON = {
  node: { id: "ent::nvidia::1", name: "NVIDIA Corporation", type: "entity" },
  relations: [
    { key: "rel:competes_with", kind: "related", label: "Competes with", total: 181, total_capped: false,
      items: [{ id: "ent::amzn::2", name: "Amazon.com, Inc.", type: "entity", aliases: ["AMZN"] }] },
    { key: "siblings", kind: "sibling", label: "Other Companies", total: 1000, total_capped: true, items: [] },
  ],
};
const DRILL_JSON = {
  node: { id: "ent::nvidia::1", name: "NVIDIA Corporation", type: "entity" },
  relation: { key: "metrics", kind: "data", label: "Related Metrics", total: 80, total_capped: false,
    items: [{ id: "met::rev", name: "Revenues", aliases: [] }] },
};

const calls: string[] = [];
function mockFetch(json: unknown) {
  return vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => json, text: async () => "" } as unknown as Response;
  });
}

beforeEach(() => { calls.length = 0; vi.stubEnv("TAKO_API_KEY", "tako_sk_test"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("graphOverview", () => {
  it("parses the overview form into GraphRelation[] (snake_case → camelCase)", async () => {
    vi.stubGlobal("fetch", mockFetch(OVERVIEW_JSON));
    const { graphOverview } = await import("./graph");
    const { node, relations } = await graphOverview("ent::nvidia::1");
    expect(node.name).toBe("NVIDIA Corporation");
    expect(relations).toHaveLength(2);
    expect(relations[0]).toMatchObject({ key: "rel:competes_with", kind: "related", label: "Competes with", total: 181, totalCapped: false });
    expect(relations[0].items[0].name).toBe("Amazon.com, Inc.");
    expect(relations[1].totalCapped).toBe(true);
    expect(calls[0]).toContain("/related?node_id=");
    expect(calls[0]).not.toContain("relation_type");
    expect(calls[0]).not.toContain("relation=");
  });

  it("returns empty relations (not throw) when the field is missing", async () => {
    vi.stubGlobal("fetch", mockFetch({ node: { id: "x", name: "X", type: "entity" } }));
    const { graphOverview } = await import("./graph");
    const { relations } = await graphOverview("x");
    expect(relations).toEqual([]);
  });
});

describe("graphRelated (relation= param)", () => {
  it("sends relation=<key>, never the deprecated relation_type", async () => {
    vi.stubGlobal("fetch", mockFetch(DRILL_JSON));
    const { graphRelated } = await import("./graph");
    const items = await graphRelated("ent::nvidia::1", { relation: "metrics", q: "revenue", limit: 8 });
    expect(items.map((i) => i.name)).toEqual(["Revenues"]);
    expect(calls[0]).toContain("relation=metrics");
    expect(calls[0]).toContain("q=revenue");
    expect(calls[0]).not.toContain("relation_type");
  });

  it("accepts named-edge keys for drills", async () => {
    vi.stubGlobal("fetch", mockFetch(DRILL_JSON));
    const { graphRelated } = await import("./graph");
    await graphRelated("ent::nvidia::1", { relation: "rel:has_team", limit: 100 });
    expect(calls[0]).toContain(encodeURIComponent("rel:has_team"));
  });
});
```

Note: `graph.ts` reads env at call time (`process.env.TAKO_API_KEY` inside `get`), so `vi.stubEnv` in `beforeEach` works; the dynamic `import("./graph")` is just to keep module init after stubbing.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/graph.test.ts`
Expected: FAIL — `graphOverview` is not exported; `graphRelated` type error / URL contains `relation_type`.

- [ ] **Step 3: Implement in `lib/agents/tako/graph.ts`**

Replace the `graphRelated` function and add `graphOverview` + `GraphRelation` (keep `get`, `graphSearch` as-is; extend `get`'s count line):

```ts
// in get(): count both facet and overview forms
const count = json?.results?.length ?? json?.relation?.items?.length ?? json?.relations?.length ?? 0;
```

```ts
// One relation group from the /related OVERVIEW form (no relation param): a stable
// key (fixed like "metrics"/"siblings" or a named edge like "rel:competes_with"),
// a kind (related|membership|data|sibling|source), a server label, exact total
// (capped at 1000 → totalCapped), and ~10 inline items (full nodes).
export interface GraphRelation {
  key: string; kind: string; label: string;
  total: number; totalCapped: boolean; items: GraphItem[];
}

function parseRelation(r: any): GraphRelation {
  return {
    key: String(r?.key ?? ""), kind: String(r?.kind ?? ""), label: String(r?.label ?? ""),
    total: Number(r?.total ?? 0), totalCapped: Boolean(r?.total_capped),
    items: Array.isArray(r?.items) ? r.items : [],
  };
}

// Overview form: every non-empty relation group on a node, in server order.
export async function graphOverview(nodeId: string): Promise<{ node: GraphNode; relations: GraphRelation[] }> {
  const p = new URLSearchParams({ node_id: nodeId });
  const data = await get(`/related?${p.toString()}`);
  return {
    node: data?.node ?? { id: nodeId, name: "", type: "entity" },
    relations: Array.isArray(data?.relations) ? data.relations.map(parseRelation) : [],
  };
}

export async function graphRelated(
  nodeId: string,
  // `relation` is the group key: fixed ("metrics", "entities", "siblings") or a
  // named-edge key from an overview ("rel:has_team"). Replaces the deprecated
  // relation_type param (#27511).
  opts: { relation: string; q?: string; limit?: number },
): Promise<GraphItem[]> {
  const p = new URLSearchParams({
    node_id: nodeId, relation: opts.relation, limit: String(opts.limit ?? 6),
  });
  // `q` relevance-filters the related items against their NAMES. Only append it when
  // non-empty: a metrics fetch with no `q` returns the group's (bounded) menu, which
  // is what we want as a fallback.
  const q = opts.q?.trim();
  if (q) p.set("q", q);
  const data = await get(`/related?${p.toString()}`);
  return Array.isArray(data?.relation?.items) ? data.relation.items : [];
}
```

- [ ] **Step 4: Fix the compile break at the call sites**

In `lib/agents/shared/types.ts:38`, extend `GraphCallRecord.params`:

```ts
params: { q?: string; types?: string; subtype?: string; node_id?: string; relation_type?: string; relation?: string; limit?: number };
```

In `lib/agents/tako/strategy.ts`, update `recordedRelated` (opts type + params) and the two `resolveGraph` call sites:

```ts
async function recordedRelated(
  rec: GraphCallRecord[], nodeId: string,
  opts: { relation: string; q?: string; limit?: number; subject?: string },
  onCall?: (c: GraphCallRecord) => void,
): Promise<GraphItem[]> {
  const q = opts.q?.trim();
  const params = { node_id: nodeId, relation: opts.relation, ...(q ? { q } : {}), limit: opts.limit ?? 6 };
  const subject = opts.subject ? { subject: opts.subject } : {};
  const t = Date.now();
  try {
    const items = await graphRelated(nodeId, { relation: opts.relation, ...(q ? { q } : {}), ...(opts.limit ? { limit: opts.limit } : {}) });
    const call: GraphCallRecord = { endpoint: "graph/related", params, ...subject, ms: Date.now() - t, results: items.map(compactResult) };
    rec.push(call);
    onCall?.(call);
    return items;
  } catch (e: unknown) {
    const call: GraphCallRecord = { endpoint: "graph/related", params, ...subject, ms: Date.now() - t, results: [], error: errorMessage(e) };
    rec.push(call);
    onCall?.(call);
    throw e;
  }
}
```

Both `resolveGraph` call sites change `relationType: "metric"` → `relation: "metrics"` (the node×filter fetch AND the full-menu retry).

In `lib/agents/tako/strategy.test.ts`: run `rg -n "relationType" lib/agents/tako/strategy.test.ts` and update any assertion or captured-opts key from `relationType: "metric"` to `relation: "metrics"` (the `vi.mock("./graph")` factory itself passes opts through, so only assertions change).

- [ ] **Step 5: Run tests**

Run: `npx vitest run lib/agents/tako/graph.test.ts lib/agents/tako/strategy.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/graph.ts lib/agents/tako/graph.test.ts lib/agents/shared/types.ts lib/agents/tako/strategy.ts lib/agents/tako/strategy.test.ts
git commit -m "feat: graphOverview client + migrate graphRelated to relation= param"
```

---

### Task 2: `GraphLookup.node` — pre-resolved node skips entity search

**Files:**
- Modify: `lib/agents/shared/schemas.ts:70-74` (`GraphLookup` interface)
- Modify: `lib/agents/tako/strategy.ts` (`resolveGraph`)
- Test: `lib/agents/tako/strategy.test.ts`

**Interfaces:**
- Consumes: `resolveGraph`'s `searchNames`/`rankNodes` internals (Task 1 state of strategy.ts).
- Produces: `GraphLookup.node?: { id: string; name: string }` — code-only field (NOT in `zLookup`); a lookup carrying it makes `resolveGraph` fan out metrics for exactly that node with zero `graph/search` calls. Task 5 sets this field.

- [ ] **Step 1: Write the failing test**

Append to the `graphStrategy` describes in `lib/agents/tako/strategy.test.ts`:

```ts
describe("graphStrategy — pre-resolved node (lookup.node)", () => {
  it("skips graph/search entirely and fans out metrics for exactly that node", async () => {
    h.relatedByNode["ent::bulls::1"] = [{ id: "m1", name: "Attendance", aliases: [] }];
    h.grounded = ["Chicago Bulls Attendance"];
    const plan = await graphStrategy.leafQueries(
      stubCtx(), "Chicago Bulls attendance",
      { entities: ["Chicago Bulls"], metricFilters: ["attendance"], node: { id: "ent::bulls::1", name: "Chicago Bulls" } },
    );
    expect(h.searchCalls).toEqual([]); // NO entity search
    expect(h.relatedCalls.every((c) => c.nodeId === "ent::bulls::1")).toBe(true);
    expect(h.relatedCalls.length).toBeGreaterThan(0);
    expect(plan.graph).toEqual([{ entity: "Chicago Bulls", related: ["Attendance"], kind: "entity" }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/agents/tako/strategy.test.ts -t "pre-resolved node"`
Expected: FAIL — TS error (`node` not on `GraphLookup`) or `h.searchCalls` non-empty.

- [ ] **Step 3: Implement**

`lib/agents/shared/schemas.ts` — extend the interface (NOT `zLookup`):

```ts
export interface GraphLookup {
  entities: string[];
  subtype?: string;
  metricFilters: string[];
  // Pre-resolved graph node (e.g. a cohort-roster member): resolveGraph skips the
  // entity search and fans out metrics for exactly this node. Set ONLY by code —
  // never part of an LLM-facing Zod schema (ids must be un-hallucinatable).
  node?: { id: string; name: string };
}
```

`lib/agents/tako/strategy.ts` — in `resolveGraph`, replace the two lines that build `ranked` (the `searchNames` + `rankNodes` calls) with:

```ts
  let ranked: { node: GraphNode; from: string }[];
  if (lookup.node) {
    // Pre-resolved (cohort-roster member): the id is already exact — skip the search.
    ranked = [{ node: { id: lookup.node.id, name: lookup.node.name, type: "entity" }, from: lookup.node.name }];
  } else {
    const perName = await searchNames(ctx, graphCalls, names, subtype, onCall);
    ranked = rankNodes(perName);
  }
  for (const r of ranked) ctx.resolved.push({ query: r.from, node: r.node.name });
```

(The existing `ctx.resolved.push` loop moves below the branch so both paths record.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/agents/tako/strategy.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/shared/schemas.ts lib/agents/tako/strategy.ts lib/agents/tako/strategy.test.ts
git commit -m "feat: GraphLookup.node — pre-resolved node skips entity search in resolveGraph"
```

---

### Task 3: `cohortRoster` on the strategy seam

**Files:**
- Modify: `lib/agents/tako/strategy.ts`
- Test: `lib/agents/tako/strategy.test.ts` (also add `graphOverview` to the `vi.mock("./graph")` factory)

**Interfaces:**
- Consumes: `graphOverview`, `GraphRelation` (Task 1); `searchNames`, `rankNodes`, `recordedRelated`, `dedupeCi` internals.
- Produces (Task 5 relies on these exact names, exported from `./strategy`):

```ts
export interface RosterMember { id: string; name: string; aliases: string[] }
export interface RosterGroup { key: string; kind: string; label: string; total: number; totalCapped: boolean; members: RosterMember[] }
export interface CohortRoster {
  anchor: { id: string; name: string };
  groups: RosterGroup[];
  graphCalls: GraphCallRecord[]; // every call the roster made (search + overview + drills)
  expand: (key: string) => Promise<RosterMember[]>; // full-roster drill for one group
}
// on QueryStrategy:
cohortRoster?(ctx: ResearchCtx, cohort: string, anchor: GraphLookup, nodeId?: string): Promise<CohortRoster | null>;
```

`searchStrategy` does NOT implement `cohortRoster`.

- [ ] **Step 1: Extend the graph mock in strategy.test.ts**

In the `vi.hoisted` block add:

```ts
  overviewByNode: {} as Record<string, any>, // graphOverview relations per node id
  overviewCalls: [] as string[],             // node ids overview was called for
```

In the `vi.mock("./graph", ...)` factory add:

```ts
  graphOverview: vi.fn(async (nodeId: string) => {
    h.overviewCalls.push(nodeId);
    const o = h.overviewByNode[nodeId];
    if (o instanceof Error) throw o;
    return { node: { id: nodeId, name: `node-${nodeId}`, type: "entity" }, relations: o ?? [] };
  }),
```

In `beforeEach` add: `h.overviewByNode = {}; h.overviewCalls = [];`

- [ ] **Step 2: Write the failing tests**

Append to `lib/agents/tako/strategy.test.ts`:

```ts
const REL = (over: Partial<{ key: string; kind: string; label: string; total: number; totalCapped: boolean; items: any[] }>) => ({
  key: "rel:x", kind: "related", label: "X", total: 1, totalCapped: false, items: [], ...over,
});
const NBA_TEAMS = REL({
  key: "rel:has_team", kind: "related", label: "Has team", total: 30,
  items: [
    { id: "ent::bulls::1", name: "Chicago Bulls", type: "entity", aliases: ["Bulls"] },
    { id: "ent::knicks::1", name: "New York Knicks", type: "entity", aliases: [] },
  ],
});

describe("graphStrategy.cohortRoster", () => {
  it("resolves the anchor, reads the overview, and returns cohort-shaped groups", async () => {
    h.entityNodesByTerm = { NBA: [{ id: "ent::nba::1", name: "National Basketball Association", type: "entity" }] };
    h.overviewByNode["ent::nba::1"] = [NBA_TEAMS];
    const ctx = stubCtx();
    const roster = await graphStrategy.cohortRoster!(ctx, "NBA teams", lookup(["NBA"], ["attendance"]));
    expect(roster).not.toBeNull();
    expect(roster!.anchor.id).toBe("ent::nba::1");
    expect(roster!.groups).toHaveLength(1);
    expect(roster!.groups[0]).toMatchObject({ key: "rel:has_team", label: "Has team", total: 30 });
    expect(roster!.groups[0].members[0]).toEqual({ id: "ent::bulls::1", name: "Chicago Bulls", aliases: ["Bulls"] });
    expect(roster!.graphCalls.some((c) => c.endpoint === "graph/related")).toBe(true);
  });

  it("filters data/source kinds always, and sibling only when capped", async () => {
    h.entityNodesByTerm = { Nvidia: [{ id: "ent::nv::1", name: "NVIDIA Corporation", type: "entity" }] };
    h.overviewByNode["ent::nv::1"] = [
      REL({ key: "metrics", kind: "data", label: "Related Metrics", total: 490, items: [{ id: "m1", name: "Revenues" }] }),
      REL({ key: "sources", kind: "source", label: "Sources", total: 4, items: [{ id: "s1", name: "S&P Global" }] }),
      REL({ key: "siblings", kind: "sibling", label: "Other Companies", total: 1000, totalCapped: true, items: [{ id: "e1", name: "Amazon.com, Inc." }] }),
      REL({ key: "part_of", kind: "membership", label: "Part of", total: 2, items: [{ id: "g1", name: "Big Tech" }] }),
    ];
    const roster = await graphStrategy.cohortRoster!(stubCtx(), "big tech", lookup(["Nvidia"], ["revenue"]));
    expect(roster!.groups.map((g) => g.key)).toEqual(["part_of"]);
  });

  it("dedupes reciprocal groups with identical member-id sets", async () => {
    const items = [{ id: "e1", name: "Amazon.com, Inc." }, { id: "e2", name: "Microsoft Corporation" }];
    h.entityNodesByTerm = { Nvidia: [{ id: "ent::nv::1", name: "NVIDIA Corporation", type: "entity" }] };
    h.overviewByNode["ent::nv::1"] = [
      REL({ key: "rel:competes_with", label: "Competes with", total: 181, items }),
      REL({ key: "rel:competitors_of", label: "Competitors of", total: 181, items }),
    ];
    const roster = await graphStrategy.cohortRoster!(stubCtx(), "competitors", lookup(["Nvidia"], ["revenue"]));
    expect(roster!.groups.map((g) => g.key)).toEqual(["rel:competes_with"]);
  });

  it("returns null (with a note) when the anchor does not resolve", async () => {
    h.entityNodesByTerm = {}; h.searchNodes = [];
    const ctx = stubCtx();
    expect(await graphStrategy.cohortRoster!(ctx, "startups", lookup(["emerging startups"], ["revenue"]))).toBeNull();
    expect(ctx.notes.some((n) => n.includes("cohort"))).toBe(true);
  });

  it("returns null when the overview fails or yields no cohort-shaped groups", async () => {
    h.entityNodesByTerm = { X: [{ id: "x1", name: "X", type: "entity" }] };
    h.overviewByNode["x1"] = new Error("overview down") as any;
    const ctx = stubCtx();
    expect(await graphStrategy.cohortRoster!(ctx, "c", lookup(["X"], ["y"]))).toBeNull();
    h.overviewByNode["x1"] = [REL({ key: "metrics", kind: "data", items: [{ id: "m", name: "M" }] })];
    expect(await graphStrategy.cohortRoster!(stubCtx(), "c", lookup(["X"], ["y"]))).toBeNull();
  });

  it("expand() drills the group by key with the roster limit", async () => {
    h.entityNodesByTerm = { NBA: [{ id: "ent::nba::1", name: "National Basketball Association", type: "entity" }] };
    h.overviewByNode["ent::nba::1"] = [NBA_TEAMS];
    h.relatedByNode["ent::nba::1"] = Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}`, aliases: [] }));
    const roster = await graphStrategy.cohortRoster!(stubCtx(), "NBA teams", lookup(["NBA"], ["attendance"]));
    const full = await roster!.expand("rel:has_team");
    expect(full).toHaveLength(30);
    const drill = h.relatedCalls.find((c) => c.relation === "rel:has_team");
    expect(drill).toBeTruthy();
    expect(drill.limit).toBe(100);
  });

  it("searchStrategy does not implement cohortRoster", () => {
    expect(searchStrategy.cohortRoster).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/strategy.test.ts -t "cohortRoster"`
Expected: FAIL — `cohortRoster` undefined on `graphStrategy`.

- [ ] **Step 4: Implement in `lib/agents/tako/strategy.ts`**

Import `graphOverview` and `GraphRelation` from `./graph`. Add below the `QueryStrategy` interface (which gains the optional method exactly as in **Interfaces** above):

```ts
// ---- graph-grounded cohort roster (spec 2026-07-12) ----
// A cohort question's member set, read straight off the anchor node's /related
// OVERVIEW — exhaustive and pre-resolved (each member is a real graph node),
// replacing LLM extraction from answer prose as the primary roster source.
export interface RosterMember { id: string; name: string; aliases: string[] }
export interface RosterGroup { key: string; kind: string; label: string; total: number; totalCapped: boolean; members: RosterMember[] }
export interface CohortRoster {
  anchor: { id: string; name: string };
  groups: RosterGroup[];
  graphCalls: GraphCallRecord[];
  expand: (key: string) => Promise<RosterMember[]>;
}

const ROSTER_DRILL_LIMIT = 100; // one page of a drilled group — full roster context, bounded

// graphOverview with the exact params + a per-GROUP results summary recorded into
// `rec` (one row per group: key + "label — total") and mirrored live via onCall.
async function recordedOverview(
  rec: GraphCallRecord[], nodeId: string, subject: string, onCall?: (c: GraphCallRecord) => void,
): Promise<GraphRelation[]> {
  const params = { node_id: nodeId };
  const t = Date.now();
  try {
    const { relations } = await graphOverview(nodeId);
    const call: GraphCallRecord = {
      endpoint: "graph/related", params, subject, ms: Date.now() - t,
      results: relations.map((r) => ({ id: r.key, name: `${r.label} — ${r.totalCapped ? `>${r.total}` : r.total}` })),
    };
    rec.push(call);
    onCall?.(call);
    return relations;
  } catch (e: unknown) {
    const call: GraphCallRecord = { endpoint: "graph/related", params, subject, ms: Date.now() - t, results: [], error: errorMessage(e) };
    rec.push(call);
    onCall?.(call);
    throw e;
  }
}

function toMembers(items: GraphItem[]): RosterMember[] {
  return items.filter((i) => i.id && i.name).map((i) => ({ id: i.id, name: i.name, aliases: i.aliases ?? [] }));
}

// Keep only groups that can BE a cohort: drop data (metrics) and source kinds
// outright; drop capped sibling groups (">1000 Other Companies" enumerates the
// whole class namespace, not this node's cohort); drop empty groups; and keep one
// of each reciprocal pair (rel:competes_with / rel:competitors_of carry identical
// member sets — same total + same inline ids ⇒ the same edge read both ways).
export function cohortGroups(relations: GraphRelation[]): RosterGroup[] {
  const seen = new Set<string>();
  const out: RosterGroup[] = [];
  for (const r of relations) {
    if (r.kind === "data" || r.kind === "source") continue;
    if (r.kind === "sibling" && r.totalCapped) continue;
    const members = toMembers(r.items);
    if (members.length === 0) continue;
    const sig = `${r.total}|${members.map((m) => m.id).sort().join(",")}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key: r.key, kind: r.kind, label: r.label, total: r.total, totalCapped: r.totalCapped, members });
  }
  return out;
}
```

And the method on `graphStrategy` (after `broadQueries`):

```ts
  // Cohort roster: resolve the ANCHOR (the entity the class hangs off, or the
  // class's own node) with the same subtype-filtered search + unfiltered retry the
  // leaves use, then ONE overview call. Null (never throw) on any miss — the
  // caller falls back to answer-prose extraction.
  async cohortRoster(ctx, cohort, anchor, nodeId) {
    const t = Date.now();
    const graphCalls: GraphCallRecord[] = [];
    const onCall = nodeId && ctx.emit
      ? (call: GraphCallRecord) => ctx.emit!({ type: "graph_call", nodeId, call })
      : undefined;
    const names = dedupeCi(anchor.entities).slice(0, 3);
    if (names.length === 0) {
      ctx.notes.push(`cohort "${cohort.slice(0, 50)}" has no anchor entities — using answer-grounded resolution`);
      return null;
    }
    try {
      const perName = await searchNames(ctx, graphCalls, names, anchor.subtype?.trim() || undefined, onCall);
      const ranked = rankNodes(perName);
      if (ranked.length === 0) {
        ctx.notes.push(`cohort anchor "${names[0]}" resolved no graph node — using answer-grounded resolution`);
        return null;
      }
      const node = ranked[0].node;
      const relations = await recordedOverview(graphCalls, node.id, node.name, onCall);
      const groups = cohortGroups(relations);
      if (groups.length === 0) {
        ctx.notes.push(`no cohort-shaped relation groups on "${node.name}" — using answer-grounded resolution`);
        return null;
      }
      return {
        anchor: { id: node.id, name: node.name },
        groups, graphCalls,
        expand: async (key: string) =>
          toMembers(await recordedRelated(graphCalls, node.id, { relation: key, limit: ROSTER_DRILL_LIMIT, subject: node.name }, onCall)),
      };
    } catch (e: unknown) {
      ctx.notes.push(`cohort graph lookup failed — ${errorMessage(e)}`);
      return null;
    } finally {
      ctx.timings.graph = Math.max(ctx.timings.graph, Date.now() - t);
    }
  },
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run lib/agents/tako/strategy.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/strategy.ts lib/agents/tako/strategy.test.ts
git commit -m "feat: cohortRoster on the strategy seam — anchor search + overview + group filtering"
```

---

### Task 4: Prompt changes — anchor entities + COHORT_GROUPS second pass

**Files:**
- Modify: `lib/agents/tako/prompts.ts` (`DECOMPOSE_SYSTEM`)
- Test: `lib/agents/tako/decompose.test.ts`

**Interfaces:**
- Produces: `DECOMPOSE_SYSTEM` contains the literal markers `ANCHOR`, `COHORT_GROUPS`, `VERBATIM` (Task 5's prompt block and pipeline mock key on `COHORT_GROUPS:`).

- [ ] **Step 1: Write the failing tests**

Append to the "lookup rules in prompts" describe in `lib/agents/tako/decompose.test.ts`:

```ts
  // Graph-grounded cohorts: the first pass must name the ANCHOR so the roster
  // lookup has something to resolve; the second pass picks a real relation group
  // and copies member names verbatim (code maps names → node ids afterwards).
  it("decompose demands an ANCHOR entity when setting cohort", () => {
    expect(DECOMPOSE_SYSTEM).toContain("ANCHOR");
    expect(DECOMPOSE_SYSTEM).toContain("National Basketball Association");
  });

  it("decompose handles a COHORT_GROUPS second pass with verbatim member names", () => {
    expect(DECOMPOSE_SYSTEM).toContain("COHORT_GROUPS");
    expect(DECOMPOSE_SYSTEM).toContain("VERBATIM");
    expect(DECOMPOSE_SYSTEM).toContain("do not set \`cohort\` again");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/decompose.test.ts`
Expected: FAIL on the two new assertions.

- [ ] **Step 3: Edit `DECOMPOSE_SYSTEM` in `lib/agents/tako/prompts.ts`**

In the cohort bullet (first bullet), after "…and calls you again with a COHORT_MEMBERS list.", INSERT:

```
  When you set \`cohort\`, the top-level \`entities\` MUST name the ANCHOR — the concrete entity the class
  hangs off ("compare Nvidia to its competitors" → entities ["NVIDIA Corporation", "Nvidia"]) or the class's
  own registered name when the class itself is a real organization/index ("all NBA teams" →
  entities ["National Basketball Association", "NBA"]; "the Magnificent Seven" → ["Magnificent Seven"]).
  The caller resolves that anchor in the graph and reads the cohort's members off its relations.
```

(The existing "Even then, STILL populate the top-level `entities` + `metricFilters`" sentence stays — the anchor instruction REPLACES its vaguer "entities = the class phrase itself and/or the question's geography/market" clause; delete that clause.)

After the existing `COHORT_MEMBERS` bullet ("- When the prompt contains a COHORT_MEMBERS list, …"), ADD a sibling bullet:

```
- When the prompt contains a COHORT_GROUPS list, this IS the second pass, grounded in REAL graph data: each
  group is {label, total, members} read from the anchor entity's graph relations. Pick the ONE group that IS
  the question's cohort — prefer the group whose label names the class ("Has team" for "all NBA teams";
  "Competes with" for "Nvidia's competitors"; a membership group for "the Magnificent Seven") — and create one
  sub-question per member of THAT group, copying each member's name VERBATIM as that sub-question's first
  \`entities\` entry; do not set \`cohort\` again, and do not mix members from different groups.
  COVER THE MEMBERS FIRST: one sub-question per member (each with the question's single most
  decision-relevant measure) before ANY member gets a second measure. \`total\` may exceed the members shown —
  plan from the members listed; the caller records the full roster separately.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run lib/agents/tako/decompose.test.ts`
Expected: PASS (all — the pre-existing cohort assertions must still hold).

- [ ] **Step 5: Commit**

```bash
git add lib/agents/tako/prompts.ts lib/agents/tako/decompose.test.ts
git commit -m "feat: decompose prompt — cohort anchor entities + COHORT_GROUPS second pass"
```

---

### Task 5: research.ts — roster-first cohort flow with fallback

**Files:**
- Modify: `lib/agents/tako/research.ts`
- Test: `lib/agents/tako/pipeline.test.ts`

**Interfaces:**
- Consumes: `ctx.strategy.cohortRoster?` + `CohortRoster`/`RosterGroup`/`RosterMember` (Task 3), `GraphLookup.node` (Task 2), `COHORT_GROUPS` prompt contract (Task 4).
- Produces: no new exports — behavior only. Old takoAnswer path untouched as fallback.

- [ ] **Step 1: Extend pipeline.test.ts mocks**

In `vi.hoisted` add:

```ts
  overview: [] as any[], // graphOverview relations for every node (cohort roster)
```

In the `vi.mock("./graph")` factory add (and reset `h.overview = []` in `beforeEach`):

```ts
  graphOverview: vi.fn(async (nodeId: string) => ({
    node: { id: nodeId, name: `node:${nodeId}`, type: "entity" }, relations: h.overview,
  })),
```

In the decompose branch of the `generateStructured` mock, before the `COHORT_MEMBERS` line, add:

```ts
      // Graph-grounded second pass carries a COHORT_GROUPS block.
      if (String(opts.prompt).includes("COHORT_GROUPS:")) return h.plans[`${q}::groups`] ?? { atomic: true, rationale: "direct" };
```

- [ ] **Step 2: Write the failing tests**

Add a describe to `lib/agents/tako/pipeline.test.ts` (reuse the file's existing helpers: `runTakoInitial`, a request fixture with `providerId: "tako"`; follow the existing cohort test around line 436 for shape):

```ts
describe("graph-grounded cohort resolution", () => {
  const nbaReq = { ...inflationReq, message: "How do all NBA teams compare on attendance?" };
  const Q = "How do all NBA teams compare on attendance?";
  const firstPass = {
    atomic: false, rationale: "class question", cohort: "NBA teams",
    entities: ["National Basketball Association", "NBA"], metricFilters: ["attendance"],
  };
  const teamsGroup = {
    key: "rel:has_team", kind: "related", label: "Has team", total: 3, total_capped: false,
    items: [
      { id: "ent::bulls::1", name: "Chicago Bulls", type: "entity", aliases: ["Bulls"] },
      { id: "ent::knicks::1", name: "New York Knicks", type: "entity", aliases: [] },
      { id: "ent::lakers::1", name: "Los Angeles Lakers", type: "entity", aliases: [] },
    ],
  };
  const memberSubs = ["Chicago Bulls", "New York Knicks", "Los Angeles Lakers"].map((n) => ({
    question: `${n} attendance`, entities: [n], metricFilters: ["attendance"],
  }));

  it("plans per-member from the graph roster and never calls cohort-resolve or /v1/answer extraction", async () => {
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs };
    h.overview = [teamsGroup];
    const { generateStructured } = await import("../../llm");
    await runTakoInitial(nbaReq, () => {});
    const labels = (generateStructured as any).mock.calls.map((c: any[]) => c[0].label);
    expect(labels).not.toContain("cohort-resolve");
    const prompts = (generateStructured as any).mock.calls.map((c: any[]) => String(c[0].prompt));
    expect(prompts.some((p: string) => p.includes("COHORT_GROUPS:") && p.includes("Has team"))).toBe(true);
  });

  it("member leaves carry pre-resolved node ids — no graph/search for member names", async () => {
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs };
    h.overview = [teamsGroup];
    const { graphSearch } = await import("./graph");
    await runTakoInitial(nbaReq, () => {});
    const searched = (graphSearch as any).mock.calls.map((c: any[]) => c[0]);
    expect(searched).not.toContain("Chicago Bulls"); // pre-resolved: leaf skipped entity search
  });

  it("drills the full roster when total exceeds inline members, into a note", async () => {
    h.plans[Q] = firstPass;
    h.plans[`${Q}::groups`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs.slice(0, 2) };
    h.overview = [{ ...teamsGroup, total: 30 }]; // 30 known, 3 inline
    const { graphRelated } = await import("./graph");
    const result = await runTakoInitial(nbaReq, () => {});
    const drill = (graphRelated as any).mock.calls.find((c: any[]) => c[1]?.relation === "rel:has_team");
    expect(drill).toBeTruthy();
    expect(result.trace.notes.some((n: string) => n.includes("Has team"))).toBe(true);
  });

  it("falls back to the answer-grounded path when the overview yields no cohort groups", async () => {
    h.plans[Q] = firstPass;
    h.overview = []; // no groups → roster null
    h.answer = { answer: "The NBA's top teams include the Chicago Bulls.", cards: [] };
    h.cohortMembers = { entities: ["Chicago Bulls"], rationale: "from answer" };
    h.plans[`${Q}::members`] = { atomic: false, rationale: "per member", entities: ["National Basketball Association"], metricFilters: ["attendance"], subQuestions: memberSubs.slice(0, 2) };
    const { generateStructured } = await import("../../llm");
    await runTakoInitial(nbaReq, () => {});
    const labels = (generateStructured as any).mock.calls.map((c: any[]) => c[0].label);
    expect(labels).toContain("cohort-resolve"); // old path ran
  });
});
```

Adjust fixture names to the file's actual request fixture (`inflationReq` or equivalent) when writing; the assertions are the contract.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run lib/agents/tako/pipeline.test.ts -t "graph-grounded cohort"`
Expected: FAIL — no `COHORT_GROUPS` prompt is issued; `cohort-resolve` still called in the first test.

- [ ] **Step 4: Implement in `lib/agents/tako/research.ts`**

Import the roster types: `import type { CohortRoster, RosterGroup, RosterMember } from "./strategy";`

Add two helpers above `research()`:

```ts
// CI match of a sub-question's candidate entities against a roster member's
// name/aliases — how LLM-returned verbatim names become node ids (the LLM never
// sees or emits ids; an unmatched name survives as a plain name-only lookup).
function matchMember(entities: string[], groups: RosterGroup[]): { member: RosterMember; group: RosterGroup } | null {
  const wanted = entities.map((e) => e.trim().toLowerCase());
  for (const group of groups) {
    for (const member of group.members) {
      const names = [member.name, ...member.aliases].map((s) => s.trim().toLowerCase());
      if (wanted.some((w) => w && names.includes(w))) return { member, group };
    }
  }
  return null;
}

// Attach roster node ids to the second-pass subs (new objects — no mutation),
// infer the chosen group (most member matches; tie → overview order), and drill
// the full roster into a note when the group is bigger than its inline members.
async function groundSubsWithRoster(
  ctx: ResearchCtx, subs: { question: string; lookup: GraphLookup }[], roster: CohortRoster,
): Promise<{ question: string; lookup: GraphLookup }[]> {
  const matches = new Map<string, number>();
  const grounded = subs.map((s) => {
    const hit = matchMember(s.lookup.entities, roster.groups);
    if (!hit) return s;
    matches.set(hit.group.key, (matches.get(hit.group.key) ?? 0) + 1);
    return { ...s, lookup: { ...s.lookup, node: { id: hit.member.id, name: hit.member.name } } };
  });
  let chosen: RosterGroup | null = null;
  for (const g of roster.groups) {
    const n = matches.get(g.key) ?? 0;
    if (n > 0 && n > (chosen ? matches.get(chosen.key) ?? 0 : 0)) chosen = g;
  }
  if (chosen) {
    ctx.notes.push(`cohort grounded to graph group "${chosen.label}" (${chosen.totalCapped ? ">" : ""}${chosen.total} members) on ${roster.anchor.name}`);
    if (chosen.total > chosen.members.length) {
      try {
        const full = await roster.expand(chosen.key);
        if (full.length) ctx.notes.push(`full "${chosen.label}" roster (${full.length}): ${full.slice(0, 40).map((m) => m.name).join(", ")}`);
      } catch (e: unknown) {
        ctx.notes.push(`cohort roster drill failed — ${errorMessage(e)}`);
      }
    }
  }
  return grounded;
}
```

Declare a holder next to `let rationale` (function scope, OUTSIDE the decompose try-block, so the root tree push below can read it):

```ts
  let cohortGraphCalls: GraphCallRecord[] = []; // roster's graph calls → root tree entry (trace drill-down)
```

(`GraphCallRecord` is already imported in research.ts.)

Replace the cohort second-pass block (currently `if (root && plan.cohort && grounded) { … }`, research.ts:202-211) with:

```ts
      // Class-of-entities question: FIRST try the graph — the anchor's relation
      // groups enumerate real members with node ids (exhaustive, un-hallucinatable).
      // Fall back to extracting members from the grounded answer's prose only when
      // the graph has nothing (no anchor node, no cohort-shaped groups, provider
      // without a graph). Root-only; a failed second pass keeps the FIRST plan.
      let roster: CohortRoster | null = null;
      if (root && plan.cohort) {
        roster = plan.entities?.length
          ? (await ctx.strategy.cohortRoster?.(ctx, plan.cohort, toLookup(plan), nodeId)) ?? null
          : null;
        if (roster) cohortGraphCalls = roster.graphCalls;
        if (roster) {
          const promptGroups = roster.groups.map((g) => ({
            label: g.label, total: g.totalCapped ? `>${g.total}` : g.total,
            members: g.members.map((m) => m.name),
          }));
          try {
            plan = await decomposeCall(`\n\nCOHORT_GROUPS: ${JSON.stringify(promptGroups)}`);
          } catch (e: unknown) {
            roster = null; // second pass failed — don't ground subs against it
            ctx.notes.push(`cohort graph second-pass decompose failed — proceeding with the first plan (${errorMessage(e).slice(0, 80)})`);
          }
        } else if (grounded) {
          const members = await resolveCohort(ctx, question, plan.cohort, grounded);
          if (members?.length) {
            try {
              plan = await decomposeCall(`\n\nCOHORT_MEMBERS: ${JSON.stringify(members)}`);
            } catch (e: unknown) {
              ctx.notes.push(`cohort second-pass decompose failed — proceeding with the first plan (${errorMessage(e).slice(0, 80)})`);
            }
          }
        }
      }
```

Then, immediately after the existing `subs = toSubs(plan);` line (research.ts:229), add:

```ts
      if (roster && subs.length) subs = await groundSubsWithRoster(ctx, subs, roster);
```

Finally, in the ROOT branch's tree push (research.ts:316, the line starting `ctx.tree.push({ nodeId, depth, question, kind: "branch", …`), merge the roster's calls so the trace drill-down shows them:

```ts
graphCalls: [...cohortGraphCalls, ...(bf.graphCalls ?? [])],
```

(replacing the existing `graphCalls: bf.graphCalls` — note the drill in `groundSubsWithRoster` runs before this push, so `roster.graphCalls` is complete by then; live streaming already happened via the `graph_call` events.)

The existing unresolvable-cohort re-plan (`if (plan.cohort && toSubs(plan).length === 0)`) and everything below stays byte-identical — it now also catches "roster found but second pass returned nothing".

- [ ] **Step 5: Run the pipeline tests**

Run: `npx vitest run lib/agents/tako/pipeline.test.ts`
Expected: PASS — the 4 new tests AND all pre-existing cohort tests (the `takoAnswerEnabled: false` re-plan test at ~line 436 must still pass: with `h.overview = []` default, roster is null and the old path is untouched).

- [ ] **Step 6: Commit**

```bash
git add lib/agents/tako/research.ts lib/agents/tako/pipeline.test.ts
git commit -m "feat: roster-first cohort resolution — graph groups → COHORT_GROUPS second pass, answer-prose fallback"
```

---

### Task 6: Full verification sweep

**Files:** none new.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: ALL suites pass (pipeline.search.test.ts, followup.test.ts, gaps.test.ts etc. must be untouched by the param rename — if any fails on `relationType`, fix the assertion to `relation: "metrics"`).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: One live smoke (manual, optional but recommended)**

Run the dev server (`npm run dev`) with a real `TAKO_API_KEY`, ask "compare Nvidia to its competitors", and check the trace: a `graph/related` overview call on the NVIDIA node, a `COHORT_GROUPS` decompose, member leaves with NO entity-search graph calls.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A && git commit -m "test: fixups from full-suite sweep" # only if changes exist
```

---

### Task 7: Live test battery for the skill (evidence before documentation)

**Files:**
- Create: `/private/tmp/claude-501/-Users-eric-tako-test-projects-canvas-tako/65709792-4d59-4ea5-94db-b247d4e8e057/scratchpad/related-battery.sh`
- Create: `docs/superpowers/specs/2026-07-12-graph-overview-battery.md` (evidence doc, committed)

The skill update (Task 8) may state ONLY claims this battery verifies. The battery answers, per the spec: shape questions (overview vs drill, legacy mapping, `q` on overview, `cursor`, `limit` semantics), a node-class sweep, edge cases, and 3 end-to-end dry runs — on BOTH hosts, keyed and keyless.

- [ ] **Step 1: Write the battery script**

```bash
#!/usr/bin/env bash
# /related battery — run per host: ./related-battery.sh https://staging.tako.com "$TAKO_API_KEY"
set -u
HOST="${1:-https://staging.tako.com}"; KEY="${2:-}"
hdr=(); [ -n "$KEY" ] && hdr=(-H "X-API-Key: $KEY")
g() { curl -sS --max-time 20 "${hdr[@]}" "$HOST/api/beta/graph/$1"; }
node_id() { g "search?q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$1")&types=entity${2:+&subtype=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$2")}&limit=3" \
  | python3 -c "import sys,json;r=json.load(sys.stdin).get('results',[]);print(r[0]['id'] if r else '')"; }
summ() { python3 -c "
import sys,json
d=json.load(sys.stdin)
if 'relations' in d:
    for r in d['relations']:
        print(f\"  {r['key']} [{r['kind']}] '{r['label']}' total={r['total']}{'+' if r.get('total_capped') else ''} items={len(r.get('items',[]))} first={[i.get('name') for i in r.get('items',[])[:4]]}\")
elif 'relation' in d:
    r=d['relation']
    print(f\"  DRILL {r.get('key')} total={r.get('total')} capped={r.get('total_capped')} cursor={bool(r.get('next_cursor'))} items={[i.get('name') for i in r.get('items',[])[:8]]}\")
else: print('  RAW KEYS:', list(d.keys()))"; }

section() { echo; echo "=== $* ==="; }

section "AUTH: keyless overview (is graph public?)"
curl -sS -o /dev/null -w "no-key HTTP %{http_code}\n" "$HOST/api/beta/graph/search?q=NVIDIA&types=entity&limit=1"

section "NODE-CLASS SWEEP: overview per class"
for spec in "NVIDIA Corporation|Companies" "National Basketball Association|" "Magnificent Seven|" "S&P 500|" "United States|Countries" "Stephen Curry|People" "Crude Oil|Commodities" "Apples|"; do
  name="${spec%%|*}"; sub="${spec##*|}"
  id=$(node_id "$name" "$sub"); echo "--- $name ($sub) → ${id:-NO NODE}"
  [ -n "$id" ] && g "related?node_id=$id" | summ
done

section "SHAPE: q on the OVERVIEW form (filter groups or items?)"
NV=$(node_id "NVIDIA Corporation" "Companies")
g "related?node_id=$NV&q=revenue" | summ

section "SHAPE: drill fixed key + q (the DATA loop, new param)"
g "related?node_id=$NV&relation=metrics&q=revenue&limit=6" | summ

section "SHAPE: legacy relation_type still maps"
g "related?node_id=$NV&relation_type=metric&q=revenue&limit=3" | summ

section "SHAPE: limit + cursor on a big named-edge drill (competes_with, 181)"
g "related?node_id=$NV&relation=rel:competes_with&limit=5" | summ
CUR=$(g "related?node_id=$NV&relation=rel:competes_with&limit=5" | python3 -c "import sys,json;print(json.load(sys.stdin).get('relation',{}).get('next_cursor') or '')")
[ -n "$CUR" ] && { echo "  cursor page 2:"; g "related?node_id=$NV&relation=rel:competes_with&limit=5&cursor=$CUR" | summ; } || echo "  no next_cursor returned"

section "EDGE: unknown relation key + unknown node id"
g "related?node_id=$NV&relation=rel:does_not_exist" | head -c 300; echo
curl -sS -o /dev/null -w "unknown node HTTP %{http_code}\n" "${hdr[@]}" "$HOST/api/beta/graph/related?node_id=ent::nope::0"

section "E2E DRY RUNS"
NBA=$(node_id "National Basketball Association" ""); echo "--- all NBA teams: drill rel:has_team"
g "related?node_id=$NBA&relation=rel:has_team&limit=100" | summ
echo "--- Nvidia competitors: top of rel:competes_with (ordering sanity)"
g "related?node_id=$NV&relation=rel:competes_with&limit=10" | summ
IG=$(node_id "Instagram" ""); echo "--- who owns Instagram → overview of Instagram ($IG)"
[ -n "$IG" ] && g "related?node_id=$IG" | summ
```

- [ ] **Step 2: Run it against both hosts**

```bash
chmod +x <scratchpad>/related-battery.sh
KEY=$(grep -h "TAKO_API_KEY" .env .env.local 2>/dev/null | head -1 | cut -d= -f2)
<scratchpad>/related-battery.sh https://staging.tako.com "$KEY" | tee <scratchpad>/battery-staging.txt
<scratchpad>/related-battery.sh https://tako.com "" | tee <scratchpad>/battery-prod-nokey.txt
```

(Prod run keyless first — the skill claims graph is public; if prod 401s keyless, that claim changes. If a prod key exists in env, run keyed too.)

- [ ] **Step 3: Write the evidence doc**

Create `docs/superpowers/specs/2026-07-12-graph-overview-battery.md`: for each battery section, the finding in one line + the raw output excerpt that proves it. Explicitly answer: q-on-overview semantics; cursor behavior; limit semantics per form; which node classes have named rels / member groups and which don't; ordering of big groups (relevance vs alphabetical — compare first items against market-cap order); person-node shape (Steph Curry: team relation?); junk node profile ("Apples"); unknown-key/unknown-node behavior; host/auth differences (staging vs prod, keyed vs keyless).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-12-graph-overview-battery.md
git commit -m "docs: live battery evidence for the /related overview shape"
```

---

### Task 8: Update the tako-graph-agent skill (battery-verified claims only)

**Files:**
- Modify: `/Users/eric/.claude/skills/tako-graph-agent/reference.md` (the `GET /beta/graph/related` section)
- Modify: `/Users/eric/.claude/skills/tako-graph-agent/SKILL.md` (new enumeration section + pitfalls rows)
- Modify: `/Users/eric/.claude/skills/tako-graph-agent/resolve-example.ts` (compact roster example)

**Interfaces:** none (documentation). Source of truth: Task 7's evidence doc — every new claim must trace to a battery line; where the drafts below conflict with battery output, the battery wins and the wording is adjusted.

- [ ] **Step 1: Rewrite reference.md's `/related` section**

Replace the entire `## GET /beta/graph/related` section with (adjusting details the battery contradicts, e.g. cursor/limit semantics and the auth claim):

```markdown
## GET /beta/graph/related

Two forms. The **overview** (no relation param) returns every non-empty relation
group on the node; the **drill** (`relation=<key>`) pages through one group.

| Param | Notes |
|---|---|
| `node_id` | required; opaque id from a search result. Unknown id → **404**. |
| `relation` | a group KEY: fixed (`metrics`, `entities`, `siblings`) or a named edge read off an overview (`rel:competes_with`, `rel:has_team`). Omit → overview form. |
| `relation_type` | DEPRECATED (`metric`→`metrics`, `entity`→`entities`, `member`→members); still maps, don't build on it. |
| `q` | case-insensitive SUBSTRING filter on the related nodes' names + aliases (drill form). |
| `cursor` / `limit` | pagination within a drilled group. |

**Overview form** — `{"node":{…}, "relations":[GraphRelation…]}`, ordered by the
server; each group:

```json
{"key":"rel:competes_with","kind":"related","label":"Competes with",
 "total":181,"total_capped":false,"items":[…~10 full nodes…]}
```

- `kind` ∈ `related` (named edges) / `membership` (`part_of`, `members`) /
  `data` (`metrics`, `entities`) / `sibling` / `source`.
- `rel:*` keys are PER-NODE and unguessable — always fetch the overview first,
  then drill; never hardcode a named-edge key.
- Empty groups are dropped; `total` caps at 1000 (`total_capped: true` — render
  as ">1000").
- `items` are complete nodes (`id`, `name`, `aliases`, `description`) — a
  drilled member list needs no re-resolution via graph/search.

**Drill form** — `{"node":{…}, "relation":{key, kind, label, total, total_capped,
next_cursor, "items":[…]}}` — items in **`relation.items`**, NOT `results`.

**Ordering:** unfiltered metrics = long ALPHABETIZED list (treat as unbounded);
`q`-filtered = relevance-ish but undocumented. [Battery: state what big named-edge
groups (competes_with) are ordered by.]

**Empty vs error:** no relations → 200 with an empty list (normal). Empty WITH a
`q` hint = the substring missed — retry once without `q`.
```

Replace the bracketed ordering sentence with the battery's actual finding before saving — no bracketed text may survive into the file.

- [ ] **Step 2: Add the enumeration section to SKILL.md**

Insert after "The entity-first pipeline (recommended)" section:

```markdown
## Enumerating cohorts and relationships (overview form)

The entity-first loop above answers "what is X's <measure>". A DIFFERENT question
class — the subject is a SET ("Nvidia's competitors", "all NBA teams", "the
Magnificent Seven") or a RELATIONSHIP ("who owns Instagram", "who does Steph
Curry play for") — is answered by the node's RELATIONS, not its metrics:

1. Resolve the ANCHOR entity as usual (`graph/search`, subtype-filtered,
   unfiltered retry) — the entity the set hangs off, or the class's own node.
2. ONE overview call: `related?node_id=<id>` (no relation param) → ordered
   groups, each `{key, kind, label, total, total_capped, items[≈10]}`.
3. Pick the group by its server LABEL/kind ("Has team", "Competes with",
   "Members") — deterministically or via one small LLM choice over the group
   headers. The LLM only SELECTS from real groups; it never generates names.
4. Drill `related?node_id=<id>&relation=<key>&limit=100` only when `total`
   exceeds the inline items and you need the full roster.
5. Members arrive as FULL nodes (id/name/aliases) — feed them straight into the
   per-member DATA loop; no re-resolution.

Verified wins (2026-07): NBA → `rel:has_team` total=30, every team;
"Magnificent Seven" → `members` total=7; NVIDIA → `rel:competes_with` total=181.
This replaces LLM-recalled member lists — the exact source of hallucinated
comparisons — with a database read.

**When NOT to use the overview:** the single-entity metric deep-dive. The
overview costs an extra call and its `metrics` group inlines only ~10 of
possibly hundreds of metrics, alphabetical-ish — strictly worse than the
filtered `relation=metrics&q=<fragment>` fan-out the DATA loop already does.
Fetch the overview when you need a node's RELATIONS (sets, memberships,
relationships) or a cheap availability profile; stay on the filtered metric
fan-out for measures.

**Weaknesses (each observed live):** reciprocal duplicates (`rel:competes_with`
/ `rel:competitors_of` carry the same members — dedupe by member-id set);
capped `siblings` groups enumerate the class namespace, not the node's cohort
("Other Companies" >1000 — never a comparison set); big groups still need a
relevance cap (181 competitors ≠ 181 useful comparisons — select, don't dump);
`rel:*` keys vary per node (fetch-then-pick, never plan-then-fetch); item
`description`s can run ~2k chars — truncate before prompting.
```

Extend the section with battery-verified findings not covered above (person nodes, q-on-overview semantics, host/auth differences), and update the "Where builders go wrong" table with rows for: hardcoding `rel:*` keys; treating a capped sibling group as a cohort; using the overview's inline metrics instead of the filtered drill; re-searching members that arrived with ids.

- [ ] **Step 3: Add the roster example to resolve-example.ts**

Append a compact, commented `enumerateCohort(anchorName, subtype?)` function mirroring Task 3's real implementation shape (search → overview → filter groups by kind/capped/reciprocal → optional drill), with WHY-comments matching the file's style.

- [ ] **Step 4: Verify the skill edits**

- Re-read all three files end-to-end: no bracketed placeholders, no claim without a battery/probe basis, the old entity-first sections unchanged.
- Spot-check 2 commands copy-pasted from the updated SKILL.md against staging — they must run as written.

- [ ] **Step 5: Update project memory**

`/Users/eric/.claude/projects/-Users-eric-tako-test-projects-canvas-tako/memory/tako-graph-entity-first-strategy.md` mentions the skill's shape — append one line noting the 2026-07-12 overview/enumeration addition so the memory stays accurate.

---

## Execution notes

- Tasks 1→5 are strictly ordered (each consumes the previous task's exports). Task 6 gates the code work; Tasks 7→8 are ordered but independent of 6.
- The branch is `stage1-agentic-core`; commit there (no new branch) unless the user says otherwise.
- If staging is down during Task 7, pause and report — do NOT write the skill from memory.

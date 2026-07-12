# Graph-grounded cohort resolution — design

**Date:** 2026-07-12
**Status:** approved (brainstorm with Eric)
**Scope:** canvas-tako cohort pipeline + the `~/.claude/skills/tako-graph-agent` skill

## Background

Tako's `GET /beta/graph/related` changed (#27511). The overview response (no
relation param) is now an ordered `relations: GraphRelation[]` — each group
carries a stable `key`, a `kind` (`related` / `membership` / `data` /
`sibling` / `source`), a server-provided `label`, inline `items` (~10),
`total`, and `total_capped` (counts cap at 1000). Drilling into a group is
`?relation=<key>`, where key is fixed (`metrics`, `entities`, `siblings`) or a
named-edge key like `rel:competes_with`. Legacy `?relation_type=` still works
but is deprecated. Empty groups are dropped from the overview.

Verified live on staging.tako.com (2026-07-12):

- NVIDIA node → `rel:competes_with` (181, relevance-ordered top items),
  `rel:companies_acquired_by` (18), `part_of` → "Magnificent Seven"/"Big
  Tech", `metrics` (490), `siblings` ("Other Companies", capped at 1000),
  `sources` (4). `rel:competes_with` / `rel:competitors_of` are reciprocal
  duplicates (identical totals/members).
- NBA node → `rel:has_team`, total = 30 — every team.
- "Magnificent Seven" node → `members`, total = 7.
- Drilled items are FULL graph nodes: `id`, `name`, `aliases`, `description`.
- Drill form is `{node, relation}` with items still in `relation.items`;
  legacy `relation_type=metric` behaves identically to `relation=metrics`.

## Problem

Cohort questions ("compare Nvidia to its competitors", "all NBA teams by
attendance") currently resolve members via `resolveCohort`
(`lib/agents/tako/research.ts`): one `/v1/answer` call plus an LLM extraction
(`COHORT_RESOLVE_SYSTEM`) capped at 6 members that must appear in the answer
prose or card titles. The roster is incidental coverage, not enumeration: it
is non-exhaustive, LLM-mediated (the exact place hallucinated comparisons come
from), and each extracted member is a bare name every leaf re-resolves via
`graph/search`.

The new overview makes the roster a database read: exhaustive, labeled,
counted, and pre-resolved to node ids.

## Decisions (brainstorm outcomes)

1. **Scope:** graph-grounded cohort resolution + node-id plumbing into
   per-member leaves. The entity-first metric loop in `strategy.ts` is
   otherwise untouched. Overview-first leaf resolution and a
   relationship-answer lane ("who owns Instagram" answered straight from a
   RELATED group) are explicitly OUT — future work, though the skill update
   documents where the overview form does and does not help.
2. **Group pick:** the existing cohort second-pass decompose picks the group —
   no new LLM call. It receives the overview's groups (label, total, member
   names) and returns member names verbatim.
3. **Architecture:** behind the `QueryStrategy` seam (Approach B).
   `graphStrategy` implements roster enumeration; `searchStrategy` does not,
   so the no-graph provider keeps today's behavior by construction.
4. **Fallback:** the `/v1/answer` + extraction path stays, used whenever the
   graph path returns nothing.
5. **Skill update:** broad live test battery first (~15–20 probes + 3
   end-to-end dry runs); only battery-verified claims are embedded.

## Architecture

### Graph client (`lib/agents/tako/graph.ts`)

```ts
export interface GraphRelation {
  key: string; kind: string; label: string;
  total: number; totalCapped: boolean; items: GraphItem[];
}
export async function graphOverview(nodeId: string):
  Promise<{ node: GraphNode; relations: GraphRelation[] }>
```

`graphRelated` migrates `relation_type=metric|entity` →
`relation=metrics|entities` (deprecated → current param; response shape at the
call sites is unchanged: `relation.items`). It also accepts arbitrary group
keys (`relation=rel:has_team`) for drills.

### Strategy seam (`lib/agents/tako/strategy.ts`)

```ts
export interface RosterMember { id: string; name: string; aliases: string[] }
export interface RosterGroup {
  key: string; kind: string; label: string;
  total: number; totalCapped: boolean; members: RosterMember[];
}
export interface CohortRoster { anchor: { id: string; name: string }; groups: RosterGroup[] }

interface QueryStrategy {
  leafQueries(...): Promise<QueryPlan>;   // unchanged
  broadQueries(...): Promise<QueryPlan>;  // unchanged
  cohortRoster?(ctx: ResearchCtx, cohort: string, anchor: GraphLookup,
                nodeId?: string): Promise<CohortRoster | null>;
}
```

`graphStrategy.cohortRoster`:

1. Resolve the anchor with the existing `searchNames` (subtype filter +
   unfiltered retry + notes). Top-ranked node wins.
2. One `graphOverview` call on that node (recorded to the trace like every
   other graph call, streamed via `graph_call` events).
3. Filter groups to plausible cohorts: drop `kind: "data"` and `"source"`
   always; drop `"sibling"` groups when `totalCapped` (the ">1000 Other
   Companies" case); dedupe reciprocal pairs (identical member-id sets keep
   the first).
4. Return `null` (with a `ctx.notes` reason) when the anchor misses, the
   overview fails, or no groups survive.

`searchStrategy` does not implement the method.

### Research flow (`lib/agents/tako/research.ts`, cohort block ~line 202)

```
plan.cohort set (root)
  → roster = await ctx.strategy.cohortRoster?.(ctx, plan.cohort, anchorLookup, nodeId)
  → roster?  second-pass decompose with COHORT_GROUPS block
           :  existing takoAnswer + COHORT_RESOLVE path, verbatim
```

- `COHORT_GROUPS` block: each surviving group as
  `{label, total (rendered ">1000" when capped), members: [names]}`.
- The second pass picks ONE group and plans one sub-question per member,
  member names copied verbatim (schema unchanged — names + rationale; the LLM
  never sees or emits node ids).
- Code maps each returned member name → node id by exact case-insensitive
  match against the roster (name or alias). Match → the sub-question's lookup
  gets `node: {id, name}`. No match → name-only lookup (today's behavior);
  never dropped.
- **Chosen group (inferred, not declared):** the second pass returns only
  sub-questions, so the picked group is inferred deterministically as the
  group whose members match the most sub-question entities (ties → first in
  overview order).
- **Drill (deterministic):** when the inferred group's `total` exceeds its
  inline member count, one `graphRelated(anchorId, { relation: key, limit:
  100 })` fetches the fuller roster — after the second pass, purely as
  context. Research leaves stay capped (`COHORT_MEMBER_CAP` = 6 unchanged);
  the full roster lands in `ctx.notes` and the trace as grounded context for
  the gap round and final report.

### Node-id plumbing

`GraphLookup` (lib/agents/shared/schemas.ts) gains an optional, code-only
field:

```ts
export interface GraphLookup {
  entities: string[]; subtype?: string; metricFilters: string[];
  node?: { id: string; name: string };  // pre-resolved; set by code, never by LLM schemas
}
```

In `resolveGraph`, a lookup carrying `node` skips `searchNames` entirely and
seeds `ranked` with that node. The metric fan-out, compose, guards, and
fallbacks are unchanged.

## Prompt changes (`lib/agents/tako/prompts.ts`)

- `DECOMPOSE_SYSTEM`, cohort bullet: when setting `cohort`, top-level
  `entities` = the ANCHOR — the concrete entity the class hangs off
  ("Nvidia's competitors" → `["NVIDIA Corporation", "Nvidia"]`) or the class's
  own registered name ("all NBA teams" → `["National Basketball Association",
  "NBA"]`).
- Second-pass wording: a `COHORT_GROUPS` variant alongside the existing
  `COHORT_MEMBERS` bullet — "each group is real graph data ({label, total,
  members}); pick the ONE group that IS the question's cohort (prefer
  membership/named-relation groups whose label matches the class), then one
  sub-question per member, names copied VERBATIM; do not set cohort again."
  `COHORT_MEMBERS` wording stays for the fallback path.

## Error handling / fallback ladder

1. Anchor unresolved / overview error / all groups filtered / empty roster →
   `cohortRoster` returns null + note → takoAnswer path (rung exists today).
2. Second-pass decompose failure → existing "proceed with first plan" note,
   unchanged.
3. takoAnswer unavailable → existing `COHORT_UNAVAILABLE` re-plan, unchanged.
4. Member-name→id mapping miss → name-only lookup, unchanged behavior.

Graph failures never throw past the seam (notes + trace records, existing 15s
abort in `graph.ts`). Budget: +1 overview call per cohort question, +1 drill
at most; all existing caps hold.

## Testing (TDD, tests first)

- **graph.ts:** `graphOverview` parses `{node, relations}` (fixture from the
  live NVIDIA probe); `graphRelated` sends `relation=`; drill fixture parses
  `relation.items`.
- **strategy.ts:** `cohortRoster` — anchor reuse of subtype+retry; group
  filtering (data/source/capped-sibling dropped); reciprocal dedupe; null +
  note on misses; trace records emitted.
- **resolveGraph:** lookup with `node` set → zero `graph/search` calls, metric
  fan-out for exactly that node.
- **research.ts:** searchStrategy (no `cohortRoster`) → takoAnswer path
  untouched; roster → `COHORT_GROUPS` in the second-pass prompt; verbatim-name
  → id mapping (CI, alias-aware, miss survives); null roster → fallback;
  group inference by member-match majority; drill fires only when the
  inferred group's total > inline count.
- **decompose.test.ts:** cohort plans carry anchor entities (prompt-shape
  assertion).

## Skill update (`~/.claude/skills/tako-graph-agent/`)

**Live test battery first** — a scratchpad script against BOTH `tako.com` and
`staging.tako.com`, with and without an API key (re-verify the graph-is-public
claim). Output saved as evidence next to this spec
(`2026-07-12-graph-overview-battery.md`).

- Shape: overview vs drill forms; legacy `relation_type` mapping; `q` on the
  overview form (filters groups or items?); `cursor` pagination on a drilled
  `rel:*` group; `limit` semantics per form.
- Node-class sweep: company, league (NBA), group/index (Magnificent Seven,
  S&P 500), country, person (Steph Curry), commodity, metric node.
- Edge cases: junk keyword node's relation profile ("Apples"); empty-group
  dropping; `total_capped`; reciprocal duplicates; item ordering inside big
  groups; a node with no named rels.
- End-to-end dry runs: "compare Nvidia to its competitors", "all NBA teams by
  attendance", "who owns Instagram" — overview → group pick → roster
  correctness.

**Then the skill edits** (verified claims only):

- `reference.md`: rewrite `/related` around the new contract — overview form
  (`relations` group anatomy, empty groups dropped, counts cap at 1000 →
  render ">1000"), drill form (`?relation=<key>`, per-node dynamic `rel:*`
  keys), `relation_type` deprecated-but-working.
- `SKILL.md`: entity-first DATA loop unchanged as the spine. New section
  "Enumerating cohorts and relationships (overview form)": use when the
  subject is a SET (competitors, members, teams) or a RELATIONSHIP (owns,
  plays for, headquartered in); do NOT use for single-entity metric
  deep-dives (the overview adds a call and its inline 10 metrics are worse
  than the filtered `relation=metrics&q=` fan-out). Strengths/weaknesses from
  the battery: fetch-then-pick (keys are per-node, unguessable), reciprocal
  dups, capped sibling groups, plus whatever the battery surfaces. Extend the
  "Where builders go wrong" table with the new traps.
- `resolve-example.ts`: add a compact cohort-roster example alongside the
  existing resolver.

## Out of scope

- Overview-first leaf/node resolution (replacing the node×filter fan-out).
- Relationship-answer lane (answering "who owns X" with no /v3/search).
- Grounded gap-round enrichment from sibling/membership groups.
- Any change to compose prompts, guards, /v3/search usage, or the canvas.

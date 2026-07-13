# Live battery: `/related` overview shape — evidence

**Date:** 2026-07-12
**Status:** evidence only (no doc/skill claims here — Task 8 consumes this)
**Battery script:** `related-battery.sh` (written to the session scratchpad per
task brief; reproduced in full at the bottom of this doc)
**Raw outputs:** captured to the session scratchpad
(`/private/tmp/claude-501/-Users-eric-tako-test-projects-canvas-tako/65709792-4d59-4ea5-94db-b247d4e8e057/scratchpad/`):
`battery-staging.txt` (staging, keyed), `battery-staging-nokey.txt` (staging,
keyless — added to isolate auth vs. host effects), `battery-prod-nokey.txt`
(`tako.com`, keyless), plus three follow-up raw-JSON captures
(`curry-overview.json`, `instagram-overview.json`,
`unknown-relation-key.json`) pulled while investigating anomalies the battery
surfaced.

Every finding below is quoted or paraphrased directly from one of these
files. Nothing here is from memory or docs — where the battery couldn't
settle a question it's marked **not established**.

---

## 1. Auth: is the graph public?

**Finding:** Both `/api/beta/graph/search` and `/api/beta/graph/related`
return full data with **no API key**, on **both** hosts. The only observed
difference gated by auth is the `sources` relation group, which is present
when keyed and *absent* (not empty — the whole group is missing from the
`relations` array) when keyless, reproduced on the same host (staging) with
and without a key.

```
=== AUTH: keyless overview (is graph public?) ===
no-key HTTP 200
```
(identical line in all three runs: battery-staging.txt:3,
battery-staging-nokey.txt:3, battery-prod-nokey.txt:3)

Isolating the `sources` gating — staging keyed vs. staging keyless, same
host, same data:

```
# battery-staging.txt (keyed), NVIDIA overview, last line:
  sources [source] 'Sources' total=4 items=4 first=['U.S. Department of Labor', 'Fiscal.ai', 'Visible Alpha', 'S&P Global']

# battery-staging-nokey.txt (keyless), NVIDIA overview, last line — no `sources` line at all:
  siblings [sibling] 'Other Companies' total=1000+ items=10 first=['Amazon.com, Inc.', 'Microsoft Corporation', 'Palantir Technologies Inc.', 'Tesla, Inc.']
```
Every group other than `sources` was byte-for-byte identical between the two
staging runs (same `total`, same `first` items, same order) — confirming the
gap is specifically the `sources` group, not a general auth degradation.

## 2. Node-class sweep

**Finding:** relation shape and which groups appear is heavily class- and
data-dependent; no two classes swept exposed the same group set.

```
--- NVIDIA Corporation (Companies) → ent::nvidia_corporation::5ea55992
  rel:competes_with [related] 'Competes with' total=181 items=10 first=[...]
  rel:competitors_of [related] 'Competitors of' total=181 items=10 first=[...]   # reciprocal duplicate of competes_with
  rel:companies_backed_by [related] ... total=110
  rel:subsidiaries_of [related] ... total=24
  rel:companies_acquired_by [related] ... total=18
  rel:stock_tickers [related] ... total=9 items=9
  rel:ai_model_families_created_by [related] ... total=1
  rel:headquartered_in / rel:incorporated_in [related] ... total=1 each
  part_of [membership] 'Part of' total=2 items=2 first=['Big Tech', 'Magnificent Seven']
  metrics [data] 'Related Metrics' total=490 items=10
  entities [data] 'Entities' total=2 items=2
  siblings [sibling] 'Other Companies' total=1000+ items=10
  sources [source] 'Sources' total=4 items=4
--- National Basketball Association () → ent::national_basketball_::b41b0853
  rel:has_team [related] 'Has team' total=30 items=10 first=['Chicago Bulls', 'New York Knicks', 'Cleveland Cavaliers', 'Indiana Pacers']
  rel:based_in [related] 'Based in' total=1
  metrics [data] 'Related Metrics' total=4
--- Magnificent Seven () → ent::magnificent_seven::9829ebdf
  members [membership] 'Members' total=7 items=7 first=['NVIDIA Corporation', 'Amazon.com, Inc.', 'Microsoft Corporation', 'Tesla, Inc.']
--- S&P 500 () → ent::vanguard_sp_500_etf::dc8e13f6
  # note: "S&P 500" search resolves to the Vanguard ETF, not a distinct index entity
  rel:trades_on [related] total=1
  metrics [data] total=56
  entities [data] total=3
  siblings [sibling] 'Other Securities' total=1000+
  sources [source] total=1
--- United States (Countries) → ent::united_states::2a20a06c
  rel:airlines_based_in / rel:airports_in / rel:players_born_in [related] total=1001+ (capped)
  rel:companies_headquartered_in / rel:companies_incorporated_in [related] total=1001+
  rel:drivers_from [related] total=542
  part_of [membership] 'Part of' total=5 first=['Five Eyes', 'G20', 'G7', 'NATO']
  metrics [data] total=874
  entities [data] total=1000+ (capped)
  siblings [sibling] 'Other Geographies' total=1000+
  sources [source] total=33
--- Crude Oil (Commodities) → ent::crude_oil::9914de30
  metrics [data] total=8
  entities [data] total=153
  siblings [sibling] 'Other Commodities' total=49
  sources [source] total=1
--- Apples () → ent::apple::c1e1b1c7
  metrics [data] total=11
  entities [data] total=37
```
(battery-staging.txt:6-53)

Every class here has `metrics`/`entities` `data` groups and named `rel:*`
groups where applicable. Companies/countries/commodities get `siblings`
(sibling-class comparison group) and `sources`; the two membership-index
nodes (NBA, Magnificent Seven) do not get siblings/sources at all in this
sweep. **Not established:** a general rule for which node classes get
`siblings`/`sources` — only observed per-instance.

## 3. `q` on the OVERVIEW form: filters BOTH which groups appear AND which items survive within them

**Finding:** `q=revenue` on NVIDIA's overview drops from 14 groups down to 2
(`metrics`, `siblings`) — every group with no revenue-matching item vanishes
entirely — and within the surviving groups, both `items` and `total` change
to reflect only matching items (not the group's original size).

```
=== SHAPE: q on the OVERVIEW form (filter groups or items?) ===
  metrics [data] 'Related Metrics' total=80 items=10 first=['Revenue Per Employee', 'Revenues', 'Total Other Revenues', 'Total revenue, Sequential growth (across regions)']
  siblings [sibling] 'Other Companies' total=4 items=4 first=['Ameriguard Security Services, Inc.', 'Aurcana Silver Corporation', 'Energy Resource Abundance, Inc.', 'Revenue Group Berhad']
```
(battery-staging.txt:55-57)

Compare unfiltered NVIDIA: `metrics` total was 490, `siblings` total was
1000+ — both collapse under `q=revenue` (to 80 and 4 respectively), and all
12 other groups (`rel:competes_with`, `part_of`, `sources`, etc.) disappear
because none of their items match "revenue". This confirms `q` on the
overview form is a full-text filter over relation *items*, and only groups
with at least one surviving item are returned.

## 4. `q` on a DRILL (fixed relation key + q — the "data loop" search)

**Finding:** `q` also filters items within a single named drill, and pagination
(`next_cursor`) still applies to the filtered result set.

```
=== SHAPE: drill fixed key + q (the DATA loop, new param) ===
  DRILL metrics total=80 capped=False cursor=True items=['Revenue Per Employee', 'Revenues', 'Total Other Revenues', 'Total revenue, Sequential growth (across regions)', 'Change in Unearned Revenues (Normalized)', 'EBITDA Margin']
```
(battery-staging.txt:59-60) — same `total=80` as the overview-form `q=revenue`
metrics group, confirming both forms filter identically; `cursor=True` shows
the drill+q result set is itself paginable.

## 5. Legacy `relation_type=` still maps

**Finding:** `relation_type=metric&q=revenue&limit=3` returns the identical
`metrics` drill (`total=80`, same first 3 items truncated by `limit`) as the
new `relation=metrics` form — legacy param confirmed mapped, not broken or
ignored.

```
=== SHAPE: legacy relation_type still maps ===
  DRILL metrics total=80 capped=False cursor=True items=['Revenue Per Employee', 'Revenues', 'Total Other Revenues']
```
(battery-staging.txt:62-63)

## 6. `limit` + `cursor` semantics per form

**Finding:** the **drill** form's `limit` caps items per page and — when more
remain — returns a `next_cursor` that produces a genuinely different next
page (not a repeat or an error). The **overview** form has no cursor field at
all; each group simply truncates to its (apparently fixed) per-group page
size, observed as 10 across every group in the sweep whose `total` exceeded
10 (e.g. `rel:competes_with` items=10 of total=181), while smaller groups
(e.g. `rel:stock_tickers`, total=9) return all items. **Not established**:
whether the overview per-group cap is configurable via a `limit` param — the
battery never passed `limit` on the overview form, only on drills.

```
=== SHAPE: limit + cursor on a big named-edge drill (competes_with, 181) ===
  DRILL rel:competes_with total=181 capped=False cursor=True items=['Amazon.com, Inc.', 'Microsoft Corporation', 'Tesla, Inc.', 'Alphabet Inc.', 'International Business Machines Corporation']
  cursor page 2:
  DRILL rel:competes_with total=181 capped=False cursor=True items=['Intel Corporation', 'ASML Holding N.V.', 'Nokia Oyj', 'Broadcom Inc.', 'Alibaba Group Holding Limited']
```
(battery-staging.txt:65-68) — page 2's 5 items are disjoint from page 1's 5,
confirming cursor pagination genuinely advances (not a no-op or duplicate).

Also confirmed: `rel:has_team` (NBA, total=30) with `limit=100` returns all
30 items in one page with `cursor=False` — the drill form omits pagination
entirely once everything fits under `limit`.

```
--- all NBA teams: drill rel:has_team
  DRILL rel:has_team total=30 capped=False cursor=False items=['Chicago Bulls', 'New York Knicks', 'Cleveland Cavaliers', 'Indiana Pacers', 'Golden State Warriors', 'Philadelphia 76ers', 'Washington Wizards', 'Detroit Pistons']
```
(battery-staging.txt:75-76)

## 7. Ordering of a big named-edge group (`rel:competes_with`, 181 total)

**Finding:** the top-10 order is **neither alphabetical nor a clean
descending-market-cap sort**. It is not established what the actual ranking
signal is (battery has no way to query it directly) — only that it is
demonstrably not those two simple orderings, on either host.

```
--- Nvidia competitors: top of rel:competes_with (ordering sanity)
  DRILL rel:competes_with total=181 capped=False cursor=True items=['Amazon.com, Inc.', 'Microsoft Corporation', 'Tesla, Inc.', 'Alphabet Inc.', 'International Business Machines Corporation', 'Intel Corporation', 'ASML Holding N.V.', 'Nokia Oyj']
```
(battery-staging.txt:77-78, staging/keyed)

Alphabetical would start Alibaba, Alphabet, Amazon, ASML... — it doesn't.
Descending market cap (2026 rough order: Microsoft > Alphabet ≈ Amazon >
Broadcom > Tesla > IBM ≈ ASML > Intel > Alibaba > Nokia) would put Microsoft
first and Broadcom well ahead of Tesla/IBM/ASML/Nokia — instead Tesla (a
smaller company) ranks 3rd, ahead of Alphabet/Amazon-adjacent peers, and
Broadcom lands 9th. Neither ordering rule fits. **Also notable:** the
first-page order *differs by host* — see §9 (host differences) — Amazon
leads on staging, Microsoft leads on prod, with Amazon absent from prod's
top-4 entirely. This is a data/host difference, not evidence the ordering
algorithm itself differs; it's consistent with prod and staging carrying
different underlying graph snapshots.

## 8. Edge cases: unknown relation key, unknown node id

**Finding:** an unknown `relation=` key does **not** error — it returns
HTTP 200 with a `relation` object that has a synthesized/title-cased `label`
from the key, `items: []`, `total: 0`. An unknown `node_id` returns HTTP 404.

```
$ curl ... "related?node_id=$NV&relation=rel:does_not_exist"
{"node":{...NVIDIA node...},"relation":{"key":"rel:does_not_exist","kind":"related","label":"Does not exist","items":[],"total":0,"total_capped":false}}
HTTP_STATUS:200
```
(raw capture: `unknown-relation-key.json`; matches battery-staging.txt:70-72
truncated form)

```
=== EDGE: unknown relation key + unknown node id ===
unknown node HTTP 404
```
(battery-staging.txt:72)

## 9. Host differences: staging vs. `tako.com`, keyed vs. keyless

**Finding:** staging and prod carry visibly different underlying data
(different totals, different top-N members for the *same* named relation on
the *same* entity) — this is a data-snapshot difference, not a shape
difference. Auth (`sources` group) behaves identically in kind on both hosts
(gated by key presence, not host).

```
# staging (keyed), NVIDIA:
  rel:companies_backed_by [related] 'Companies backed by' total=110 items=10 first=['CoreWeave, Inc.', 'Anthropic PBC', 'Perplexity AI, Inc.', 'OpenAI, L.L.C.']
  entities [data] 'Entities' total=2

# prod (keyless), NVIDIA:
  rel:companies_backed_by [related] 'Companies backed by' total=36 items=10 first=['Anthropic PBC', 'OpenAI, L.L.C.', 'X.AI LLC', 'Verkada Inc.']
  entities [data] 'Entities' total=62
```
(battery-staging.txt:9,18 vs battery-prod-nokey.txt:9,18)

Both hosts are fully keyless-accessible — the prod run above executed
entirely without a key (no prod key exists in this repo's `.env.local`; only
`TAKO_API_KEY` for staging is present) and returned complete, well-formed
relation data throughout, confirming the graph endpoints are public on prod
by design, matching the task brief's expectation.

**Not established:** whether prod ever gates anything beyond `sources` for
keyless requests, since no prod key was available to test a keyed prod run.

## 10. Person-node shape: Stephen Curry

**Finding:** the battery script's own node resolver (`node_id "Stephen Curry"
"People"`) failed — `subtype=People` doesn't exist for this entity; its real
subtype is `Basketball Players` — so the sweep line legitimately reads `NO
NODE` in all three runs. This is a search/subtype-mismatch in the battery
script's guessed subtype, not an API defect: dropping the subtype filter
finds the node immediately.

```
$ search?q=Stephen%20Curry&types=entity&subtype=People&limit=3
{"results": []}
$ search?q=Stephen%20Curry&types=entity&limit=5
{"results": [{"id": "ent::stephen_curry::7ebe325d", "name": "Stephen Curry", "subtype": "Basketball Players", ...}, ...]}
```

Resolving the real id and pulling its overview directly:

```json
{
  "node": {"id": "ent::stephen_curry::7ebe325d", "name": "Stephen Curry", "subtype": "Basketball Players"},
  "relations": [
    {"key": "rel:born_in", "kind": "related", "label": "Born in", "items": [{"name": "United States"}], "total": 1, "total_capped": false},
    {"key": "rel:plays_for", "kind": "related", "label": "Plays for", "items": [{"name": "Golden State Warriors"}], "total": 1, "total_capped": false}
  ]
}
```
(raw capture: `curry-overview.json`)

**Finding:** yes, a person node exposes a team relation — `rel:plays_for` →
Golden State Warriors — plus `rel:born_in`. No `metrics`/`entities`/
`siblings`/`sources` groups at all for this node (unlike company/country
nodes).

## 11. Junk node profile: "Apples"

**Finding:** the deliberately-ambiguous query "Apples" resolves — via the
battery's "take result[0]" heuristic — not to the fruit and not to a clean
"Apple Inc." company node, but to a third, distinct, loosely-typed entity:
an "Apple ecosystem" node with no `subtype` at all, sitting alongside two
*other* separate nodes also named "Apples" in the same search response
(one typed `Agricultural Products`, one with no subtype/description
whatsoever) — a real disambiguation hazard for any caller that blindly picks
the top hit.

```
$ search?q=Apples&types=entity&limit=3
{"results": [
  {"id": "ent::apple::c1e1b1c7", "name": "Apple", "aliases": ["App Store","Apple Device","Apple Store","iOS","iPad","iPhone"], "description": "Apple ecosystem including iOS devices, iPhones, and iPads."},
  {"id": "ent::apples::75f86514", "name": "Apples", "aliases": ["cooking apples","eating apples","fresh apples","malus domestica","raw apples"], "subtype": "Agricultural Products"},
  {"id": "ent::apples::5107b449", "name": "Apples", "aliases": []}
]}
```

Consistent with that thin typing, its `/related` overview is thin too — only
`metrics` (total=11) and `entities` (total=37) `data` groups, no named
`rel:*` edges, no `siblings`, no `sources`, on both staging and prod:

```
--- Apples () → ent::apple::c1e1b1c7
  metrics [data] 'Related Metrics' total=11 items=10 first=['Active Users', 'Bounce Rate', 'Downloads', 'Page Views']
  entities [data] 'Entities' total=37 items=10 first=['Adult', 'AI Chatbots and Tools', 'Android Phone', 'Arts and Entertainment']
```
(battery-staging.txt:51-53, identical shape in battery-prod-nokey.txt:47-49)

## 12. E2E dry run: "who owns Instagram"

**Finding:** Instagram resolves to a real node, but its `/related` overview
returns **zero relation groups** (`relations: []`) — the graph exposes no
ownership/parent-company edge (or any other relation at all) for this node
under this key. An agent asking "who owns Instagram" via the graph overview
gets nothing to work with; it would need to fall back to `/v1/answer` or
`/v3/search` for that question.

```json
{"node": {"id": "ent::instagram::2d5fc6ec", "type": "entity", "name": "Instagram", "aliases": []}, "relations": []}
```
(raw capture: `instagram-overview.json`; matches the blank line after
"who owns Instagram" in battery-staging.txt:79 — `summ()` prints nothing for
an empty `relations` list, which is why the battery transcript shows no
group lines there)

## 13. Rate limiting

**Finding:** no 429s were observed across five full/partial battery runs
(~roughly 120–150 requests total including investigative follow-ups) in this
session — well under the ~180/min budget mentioned in the task context. Not
a stress test; only reports what was actually observed.

---

## Summary of explicitly-asked open questions

| Question | Answer | Evidence |
|---|---|---|
| Does `q` on the OVERVIEW form filter groups or items? | Both — drops non-matching groups entirely, filters items+total within survivors | §3 |
| Does the drill return `next_cursor`, and does cursor pagination work? | Yes, and paging genuinely advances to disjoint items | §6 |
| `limit` semantics per form | Drill: hard cap + cursor for more. Overview: fixed ~10/group, no cursor, `limit` param on overview untested | §6 |
| Is `rel:competes_with` (181) relevance- or alphabetically-ordered? | Not alphabetical, not simple descending market cap; actual signal not established | §7 |
| Person node (Stephen Curry) — team relation? | Yes — `rel:plays_for` (+ `rel:born_in`); no data/sibling/source groups | §10 |
| Junk node ("Apples") profile | Resolves to a thinly-typed "Apple ecosystem" node (no subtype), distinct from two other "Apples" nodes in the same search results; thin overview (metrics+entities only) | §11 |
| Unknown relation key | HTTP 200, synthesized label, empty items, total=0 — not an error | §8 |
| Unknown node id | HTTP 404 | §8 |
| Keyless behavior per host | Both hosts fully public for `/related` and `/search`; only the `sources` group is auth-gated (confirmed via same-host keyed/keyless staging comparison), independent of host | §1, §9 |

---

## Appendix: battery script

```bash
#!/usr/bin/env bash
# /related battery — run per host: ./related-battery.sh https://staging.tako.com "$TAKO_API_KEY"
set -u
HOST="${1:-https://staging.tako.com}"; KEY="${2:-}"
hdr=(); [ -n "$KEY" ] && hdr=(-H "X-API-Key: $KEY")
g() { curl -sS --max-time 20 "${hdr[@]+"${hdr[@]}"}" "$HOST/api/beta/graph/$1"; }
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
curl -sS -o /dev/null -w "unknown node HTTP %{http_code}\n" "${hdr[@]+"${hdr[@]}"}" "$HOST/api/beta/graph/related?node_id=ent::nope::0"

section "E2E DRY RUNS"
NBA=$(node_id "National Basketball Association" ""); echo "--- all NBA teams: drill rel:has_team"
g "related?node_id=$NBA&relation=rel:has_team&limit=100" | summ
echo "--- Nvidia competitors: top of rel:competes_with (ordering sanity)"
g "related?node_id=$NV&relation=rel:competes_with&limit=10" | summ
IG=$(node_id "Instagram" ""); echo "--- who owns Instagram → overview of Instagram ($IG)"
[ -n "$IG" ] && g "related?node_id=$IG" | summ
```

Note: the script above differs from the brief's literal listing in exactly
one respect — `"${hdr[@]}"` was changed to `"${hdr[@]+"${hdr[@]}"}"` in two
places. macOS ships bash 3.2 (no homebrew bash available in this
environment), which throws `unbound variable` under `set -u` when expanding
an empty array — this broke every keyless run until fixed. This is a
bash-version compatibility fix, not a behavioral change to the battery
itself; all requests/params/parsing are identical to the brief.

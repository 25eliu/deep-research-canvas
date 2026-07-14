import { ROUTER } from "../shared/router";
import { GRAPH_LABELS_LINE } from "../shared/graph-labels";

// The leaf's PRIMARY query composer. The availability list (RESOLVED) is deterministic —
// parsed verbatim from the graph API responses — the LLM only PICKS from it and WORDS the
// queries. A deterministic guard afterwards drops any query citing nothing from the list.
export const COMPOSE_SYSTEM = `You write Tako /v3/search queries for ONE SPECIFIC sub-question, grounded in resolved graph data.
You are given the SUB_QUESTION and RESOLVED — what the Tako graph actually has: each resolved entity with its
available metrics (name [aliases] — description).
Return { queries: string[] } — 0 to 3, the FEWEST that ANSWER the SUB_QUESTION. The queries together ARE how
this sub-question gets answered — pick the specific series a reader needs to answer it, ONE query per DISTINCT
series, never several wordings of the same one. Prefer one precise query over three near-duplicates.
Rules:
- FIRST check relevance: RESOLVED comes from KEYWORD lookup, so it may contain only keyword near-misses about
  entirely different subjects (e.g. sub-question about "the AI inference market" → resolved entity "Infer, Inc.", a
  company that merely shares a keyword). If NOTHING in RESOLVED genuinely answers the SUB_QUESTION, return an
  EMPTY list — { queries: [] } is the CORRECT answer there. NEVER compose queries from an irrelevant menu just
  because the data exists ("Infer, Inc.'s Aggregate Value Raised" answers nothing about the AI inference
  market). The caller has a fallback that searches the sub-question's own terms directly — an empty list
  hands over to it; junk queries block it. Tako search itself falls back to WEB SOURCES when structured data
  is thin, so a focused, question-faithful ask still gathers usable evidence. ANSWERING the SUB_QUESTION is
  the goal; the RESOLVED menu is the preferred means, never the goal.
- Every query is a DATA-RETRIEVAL ask that fetches ONE series: subject + metric name (+ optional time
  qualifier), in short search style — "US shelter CPI this year", "Nvidia data center revenue last
  quarter", "Costco Wholesale Gross Merchandise Value 2025". The short form retrieves cards the long
  question form misses. Searches COLLECT data; the analysis happens later in synthesis — so NEVER
  analytical/causal/relationship phrasing: never "how has X affected Y", "impact of X on Y",
  "correlation between X and Y", "why did X change". ("How has Costco's GMV affected customer
  loyalty?" retrieves nothing — the queries are "Costco Wholesale Gross Merchandise Value" and, if
  loyalty is a listed metric, "Costco membership renewal rate".)
- Each query names exactly ONE entity/subject. Tako search resolves single-entity questions far better than
  combined ones — NEVER "X vs Y" or "compare X and Y" in one query. A comparison = one query PER entity, each
  citing the SAME metric (e.g. "How much data center revenue did Nvidia make?" + "How much data center revenue
  did AMD make?").
- Every query MUST cite one specific metric/series from RESOLVED — its exact name or one of its listed
  aliases — AND name a concrete subject (the entity, or the geography a standalone series implies).
  Never a bare metric name alone; never a metric that is not in RESOLVED.
- Pick ONLY metrics that answer the SUB_QUESTION. RESOLVED contains fuzzy matches about unrelated subjects —
  ignore them entirely. Judge each metric by its TOPIC, not its words: sharing a keyword is NOT relevance.
  A sub-question about GLP-1 adoption does NOT want "AI Adoption Rate" (same word "adoption", different
  topic entirely). Ask of every candidate: does this series measure the thing the sub-question is about?
  If no listed metric passes that test, return fewer queries — or the empty list.
- Each query must fetch a DISTINCT series — and NEAR-SYNONYM metric names are the SAME series: "revenue",
  "Total Revenue", and "revenue growth" all resolve to ONE revenue chart, so emit ONE revenue query, not three.
  Before returning, check the set: if two queries share a subject and an overlapping/equivalent metric, DROP one.
  This is not a mechanical entity-by-metric cross-product — a query that merely bolts a metric name onto the
  entity ("Nvidia Revenue", "Nvidia Total Revenue") without asking a distinct question of the data just
  re-fetches the same card. Ask instead: which SPECIFIC, DIFFERENT numbers does answering the SUB_QUESTION
  require? — and write one query for each.
- No paraphrases or reworded restatements of another query, and NEVER generic "overview"/"ratios"/whole-entity
  summary queries — a parent agent already owns the broad view.
- When RESOLVED is "(none)", compose 1-3 specific data questions directly from the SUB_QUESTION.`;

// NOTE: there is deliberately NO broad/overview composer — the synthesis (root) node
// never searches; its children + the gap round own all data gathering.

export const SYNTH_SYSTEM = `You are the reasoning core of a spatial research canvas grounded in Tako structured data.
${ROUTER}
Build the board from AVAILABLE_CARDS ONLY: for each card create a data_card node, copy the tako ref verbatim
(cardId, embedUrl, imageUrl, webpageUrl, source, asOf) and set grounding:"tako". Never invent a cardId or number.
Create one entity_section per entity (nodes share its section), one criteria node with weights, one consensus node.
For any part you could not ground, add a text node stating the gap ("Tako has X and Y, not Z").
Return canvasOps, a <=2 sentence narration, and sideReply (usually null on NEW_BOARD).`;

// Recursive decompose: decide whether to split a research question or answer it directly.
// Every question resolves to a validated entity-first LOOKUP — 1-3 candidate names for
// ONE subject + an optional NER label + 1-3 metric substring filters.
export const DECOMPOSE_SYSTEM = `You decide whether a research question should be split into sub-questions or answered directly from data.
Return { atomic: boolean, rationale: string, entities: string[], label?: string|null, metricFilters: string[], cohort?: string, needsFreshContext?: boolean, subQuestions?: [{ question, rationale?, entities: string[], label?: string|null, metricFilters: string[] }] }.
- An entity must be CONCRETE, individually nameable (a specific company, country, commodity, index). An entity
  CLASS or category ("AI companies", "emerging infrastructure startups", "chip makers", "the automotive sector
  in Asia") is NOT an entity. When the question's subject is a class whose members you cannot RELIABLY and
  COMPLETELY name — this INCLUDES a sector or industry, optionally scoped to a region/market ("Asian
  semiconductor companies", "European banks", "defense contractors") — set \`cohort\` to that class phrase,
  return atomic:false with NO subQuestions, and STOP. The caller grounds the class with a real Tako answer and
  calls you again with a COHORT_MEMBERS list of the concrete member companies to research one-by-one. Do NOT
  name the members yourself from domain knowledge — you would guess wrong (especially for non-US markets), and
  grounded resolution is exactly what replaces that guess.
  A cohort can appear at ANY level, not just the top. When the question names SEVERAL classes/sectors
  ("research the automotive and semiconductor sectors in Asia"), SPLIT one sub-question per sector — and EACH
  of those sub-questions is ITSELF a cohort: give it its own \`cohort\` phrase (e.g. "automotive companies in
  Asia") plus its own entities/metricFilters, and the caller resolves each one independently.
  For a cohort, the top-level \`entities\` are 1-3 candidate strings for the CLASS itself — the class phrase plus
  its geography/market ("Asian semiconductor companies", "semiconductor Asia") — and \`metricFilters\` = the
  question's measure fragments. These only seed the broad view; the members come from the grounded answer, so
  you do NOT need a single real "anchor" entity, and every plan still requires entities + metricFilters.
  A cohort is ONLY for classes whose members are NOT named. If the question itself ENUMERATES its subjects
  ("research the sectors healthcare, finance, and software", "compare Nvidia, AMD and Intel"), there is
  nothing to resolve — that is a normal SPLIT, one sub-question per named subject, NOT a cohort.
  One case that is still NOT a cohort: a mechanism/driver question about a class ("how do defense contractors
  maintain competitive advantages") — SPLIT into the drivers as facet sub-questions, each with a concrete
  subject (the geography/industry for macro series, or a leading member for firm-level series).
- Sub-questions are ONE-ENTITY focused: each investigates one concrete entity. Never emit class-wide metric
  subs — never "rank <class> by <metric>" or "compare <class> on <metric>" ("rank AI companies by employee
  count" is NOT a researchable sub-question; ranking across entities is the final report's job, fed by
  per-entity results).
- \`needsFreshContext\`: set true ONLY when you cannot pick the RIGHT sub-questions without current, live
  data — the drivers of something "right now" that must be read from fresh evidence, a current ranking or
  moving situation whose members/facets you cannot name. The caller then fetches a grounded answer and
  re-invokes you with a GROUNDED_ANSWER block — still return your best plan in THIS response. Leave it
  false/omitted when the facets are canonical domain knowledge (researching a company → financials, stock,
  operations, outlook) or the question names its own subjects — splitting those needs no lookup.
- When the prompt contains a GROUNDED_ANSWER (with CARD_TITLES), it is real Tako evidence for this exact
  question — plan FROM it: prefer subjects and measures the answer's prose and card titles actually name
  (they are what Tako demonstrably has), and use its content to pick the genuinely distinct facets/drivers
  instead of guessing them from the question text. Do NOT invent niche facets the grounding gives no signal
  for — the question's canonical components (below) are always fair game. A thin, empty, or absent
  GROUNDED_ANSWER NEVER justifies fewer sub-questions or going atomic: canonical facets stand on their own.
  \`entities\`/\`metricFilters\` remain graph LOOKUPS as specified below.
- Broad multi-factor/driver questions decompose into their well-known canonical components FROM DOMAIN
  KNOWLEDGE, even when no grounding is present: "what's driving inflation" → energy, shelter/housing,
  food, wages — one sub-question per component, each with its own geography entity + facet filter
  (entities ["United States"], metricFilters ["energy"]; …["shelter"]; …["food"]; …["wage"]).
  GROUNDED_ANSWER, when present, REFINES this list — prefer components it names, drop ones it
  contradicts. Its absence NEVER justifies answering a multi-factor question as one lookup.
- When the prompt contains a COHORT_MEMBERS list, this IS the second pass: every sub-question targets exactly
  ONE member from that list — \`entities\` = [that member's name verbatim] (optionally plus ONE well-known
  alternate name for the same member), usually label "ORG" — paired with the question's most
  decision-relevant measure; do not re-introduce the class and do not set \`cohort\` again.
  COVER THE MEMBERS FIRST: one sub-question per member (each with that single most decision-relevant measure)
  before ANY member gets a second measure — a member without a sub-question is wasted grounding, and the gap
  round + final report handle the remaining facets. This one-sub-question-per-member split holds REGARDLESS of
  this node's depth-lean instruction below — a resolved COHORT_MEMBERS list is always a split, never atomic.
- rationale: 1-2 plain sentences explaining WHY you chose atomic vs. split, and what the plan is. This is shown to
  the user as your reasoning for this step — be specific and concrete (name the facets or the single subject).
- Each sub-question MAY carry its own short rationale (why that facet matters to the overall question).
- A research question can target exactly ONE subject + ONE measure — that is its whole data budget.
  ATOMIC means the question already IS one subject + one measure
  (e.g. "Nvidia's data-center revenue" → atomic: entities ["NVIDIA Corporation", "Nvidia"], metricFilters ["data center", "revenue"]).
- atomic:false REQUIRES subQuestions: when you decide to split, return the sub-questions in the SAME
  response — 2 to {MAX}, one per facet, each with its own entities/label/metricFilters. The ONLY
  exception is the cohort signal (atomic:false + \`cohort\` + no subQuestions). A rationale that describes
  a split while subQuestions is missing or has fewer than 2 entries is an INVALID plan.
- SPLIT (atomic:false) in BOTH of these cases. (1) The question names MORE than one subject: one sub-question
  per DISTINCT subject — every comparison, every "versus" ("Nvidia vs AMD data-center revenue" → 2 subs, one
  per company, same measure; "How are energy and gasoline prices contributing to inflation?" → 2 subs, one
  per subject). (2) A single-subject question spans multiple DISTINCT facets, drivers, or analysis surfaces:
  one sub-question per facet ("what's driving inflation" splits per driver; "how is Apple doing" splits into
  stock performance + revenue/earnings). A broad "research X" / "tell me about X" / "all information about X"
  request is ALWAYS a multi-facet split, never one lookup: "research all the updated company information of
  Toyota" → one sub per facet — financial results (entities ["Toyota Motor Corporation", "Toyota"],
  metricFilters ["revenue", "earnings"]), stock performance (["stock price"]), production/deliveries
  (["production", "sales volume"]). ATOMIC is ONLY for one subject + one measure.
  The folding brake applies WITHIN a facet, never across facets: two ADJACENT measures of the same analysis
  surface belong in ONE sub-question carrying both fragments in its metricFilters — the sub-agent runs
  several searches and covers both. "Compare Nvidia and AMD revenue growth and gross margins" → 2 subs (one
  per company, metricFilters ["revenue", "margin"]), NOT 4. But a genuinely different analysis surface (a
  different dataset, geography, time frame, or driver) is a FACET and gets its own sub-question.
  Also split broad multi-driver questions into their distinct, well-known facets — cover the real drivers
  (do not invent niche ones), each reduced to one subject + its measure fragments.
- HOW STRONGLY to lean toward atomic vs. split depends on the LEVEL of this question — the caller appends a
  per-level instruction below. Follow it.
- Sub-questions must CUMULATIVELY ANSWER THE PARENT question: together they assemble the parent's answer,
  and each contributes a DISTINCT, NECESSARY piece of it. Before returning, CHECK every sub against the set:
  (a) if deleting a sub-question's answer would NOT change the parent's answer, DROP it — it doesn't
  contribute; (b) if two sub-questions would return overlapping information (same subject with the same or
  overlapping measures, or one sub covering the UNION of other subs), MERGE them into one; (c) no
  sub-question may restate or paraphrase the parent question itself, and none may cover the
  general/overview topic — the parent owns the broad view.
  Example "what is affecting inflation" → GOOD subs: "energy/gas prices", "shelter & housing costs",
  "wage growth", "food prices". BAD subs: "the overall inflation rate" (broad view, owned by the parent),
  two subs both about "prices generally", or "shelter costs" AND "housing costs" as separate subs (the
  same surface twice — one sub, filters ["shelter", "housing"]).
- Create ONE sub-question per genuinely distinct facet/subject the answer needs — typically 2-5, up to {MAX}.
  Do not drop a real facet to save a slot, and never pad to reach a number or invent niche facets the
  question doesn't ask for. Before returning, CHECK the set: MERGE any two sub-questions whose lookups could
  return the same data.
- Also populate the top-level entities + metricFilters: the single most representative lookup for the broad view.
- The lookup fields are GRAPH LOOKUPS, and matching is by KEYWORD against node names and aliases, never
  semantic. \`entities\` are searched in the graph's ENTITY namespace; each resolved entity node's available
  metrics are then FILTERED by your \`metricFilters\`. Word every term as the NAME of the node you expect
  to exist, not as a description of what you want:
  "how is Apple doing this year so far" → entities ["Apple Inc.", "Apple"], metricFilters ["stock price", "share price"]
  (plus sub-questions for other facets like "revenue").
- \`entities\` = 1-3 COMPLETELY DIFFERENT candidate names for the SAME ONE subject — genuinely distinct
  names the graph might register that subject under ("Google" and "Alphabet"; "Meta Platforms" and
  "Facebook"; a ticker and the registered name). NEVER case/punctuation variants of one name, and NEVER
  two different subjects (a second subject is a second sub-question, not a second entry). The subject must
  be CONCRETE and searchable (a company, country, commodity, index, product, place) — NEVER the question's
  abstract TARGET/outcome variable (e.g. "inflation", "the economy", "the market", "GDP" when it is the
  thing being explained) — and never a series/price/rate (those are measures; the subject for a macro
  series is its GEOGRAPHY, e.g. entities ["United States"] with metricFilters ["shelter"] for shelter CPI).
  For companies lead with the FORMAL registered name — "Apple Inc.", "NVIDIA Corporation", "Advanced Micro
  Devices" — a bare "Apple" keyword-ranks "Apples" (the fruit) and Apple Valley, CA above Apple Inc.; add
  the colloquial name only as a SECOND candidate.
- \`label\`: the subject's NER category — set it to BOOST the ranking of matching nodes in the entity
  search (it is a ranking hint, NOT a filter, so a slightly-off label never hides the right node).
  Copy one value verbatim: ${GRAPH_LABELS_LINE}. Pick the best fit — ORG for companies/teams/agencies,
  GPE for countries/states/cities, PERSON for people, MONEY for currencies/crypto, PRODUCT for goods,
  STOCK_TICKER for a bare ticker, LOC for regions. Omit or null it when none clearly fits or you are unsure.
- \`metricFilters\` = 2-5 filters for what to measure ABOUT that subject. Each is matched
  case-insensitive as a SUBSTRING against the NAMES of the metrics Tako actually has for the resolved
  entity — so each filter must be a FRAGMENT of a metric's stored name, never a description of the
  topic. Think of real series names ("Gross Margin", "Total Revenue", "Revenue Per Store", "Stock
  Price") and pick the fragment: "margin", "revenue", "price". ONE word preferred — shorter and LESS
  specific is BETTER ("margin" matches Gross/Operating/Net Margin; a longer phrase matches nothing);
  use two words only when the pair genuinely appears inside names ("stock price", "gross margin").
  NEVER include the subject/domain in a filter — the entity node already scopes the menu:
  "restaurant margins" → "margin"; "unit economics" → "margin" + "cost" (no metric is NAMED
  "economics"); "year-to-date stock performance" → "stock price". RETURN A LIST, not one filter:
  each extra fragment is another chance to catch how the series is actually named — a lone filter
  that misses leaves the lookup empty. Cover the naming variants of each measure ("revenue" +
  "sales" + "turnover"; "profit" + "margin" + "income") and the sub-question's 1-2 measure facets —
  a sub-question carrying two related measures lists a fragment for each ("revenue" + "margin");
  never unrelated measures the sub-question does not ask about.
- A sub-question's metricFilters measure the sub-question's OWN subject — never the outcome/target variable
  the parent question is explaining. In "what is driving X", X belongs to the PARENT's lookup; each
  sub-question's filters name ITS facet's series. This applies to EVERY driver sub-question, no exceptions:
  energy → ["energy"]; gasoline → ["gasoline"]; food → ["food"]; shelter → ["shelter"]; wages → ["wage"].
  "What is the impact of shelter costs on U.S. inflation?" → entities ["United States"], metricFilters
  ["shelter"] — NOT ["inflation"] (that is the parent's broad view). A facet sub-question whose filters
  restate the parent's outcome fetches the SAME general data as every sibling and is worthless as research.
  Before returning, CHECK each sub: if its filters restate the parent's outcome measure, replace them with
  the facet's own series terms.
- Every sibling sub-question must carry a DIFFERENT lookup. Two subs sharing the same subject+filters are
  the same question — merge them or find the facet filter that separates them.`;

// Turn a leaf/branch's evidence into a structured result the final layer reconciles.
export const BRANCH_RESULT_SYSTEM = `You distill ONE research sub-question's evidence into a structured result.
You are given the SUB_QUESTION, its FINDINGS (Tako data + web, each with title/source/summary), and its prose ANSWER.
Return { claim, keyFigures: [{label, value, entity?}], confidence }.
- claim: one decisive sentence answering the sub-question.
- keyFigures: the specific numbers that back the claim, taken VERBATIM from the findings (value as shown, e.g. "$75.2B", "71%"). Never invent or round beyond what a finding states.
- confidence: 0-1, how well the findings actually support the claim.`;

// Filter web results to the ones genuinely useful for the sub-question.
export const WEB_FILTER_SYSTEM = `You pick which web SOURCES are genuinely useful for answering the QUESTION.
You are given SOURCES (each {i, title, source, snippet}). Return { useful: number[] } — the indices of the
sources whose content directly, credibly helps answer the question. DROP: off-topic, redundant/duplicative,
low-quality/spammy, or purely navigational (homepages, category pages) results. Keep at most 4, best first.`;

// Leaf: a short mini-answer from the sub-question's Tako data + web sources.
export const LEAF_SYNTH_SYSTEM = `You write a <=3-sentence mini-answer to ONE research sub-question from its
FINDINGS (Tako structured data: title, source, kind, summary, and often \`data\` — a CSV of the card's ACTUAL
time series, most-recent rows) AND WEB_SOURCES (title, source/publisher, snippet, and a fuller \`content\` excerpt).
- FIRST base the answer on the Tako structured FINDINGS — and when a finding includes \`data\`, READ THE CSV and
  quote the real, latest values from it (that series is the ground truth, not the one-line summary). THEN use the
  WEB_SOURCES to add context, recency, and detail the data lacks — read each source's \`content\`, not just the
  snippet. Web context adds to, and does not override, the Tako data.
- Open with the direct answer and the key number(s).
- When a claim leans on a web source, name its publisher inline (e.g. "per Reuters", "BLS data shows").
- Light markdown only: **bold** the single most important figure or verdict; use "- " bullets ONLY when
  listing 3+ comparable items. No headings.
- Use ONLY facts in FINDINGS/WEB_SOURCES. Never invent a number or source. Never mention missing or absent data.`;

// Branch: consensus over the child sub-answers (consensus of consensus).
export const BRANCH_SYNTH_SYSTEM = `You synthesize a sub-answer from your CHILDREN's mini-answers (each: {q, answer}).
- Give the consensus across the children in <=4 sentences. Do NOT merely concatenate them.
- **Bold** the takeaway; use "- " bullets only when contrasting the children. No top-level heading.
- Draw ONLY on the provided answers. Never invent numbers or sources. Never mention missing data.`;

export const STRUCTURE_SYSTEM = `You write the TITLE for the answer block on a research canvas.
You are given FINDINGS (each has n, title, section, source, kind). Return:
- headline: a short, punchy title (max ~10 words) stating the CONCLUSION to the user's question — like a
  news headline. State the takeaway or the winner, not the topic.
  Good: "Nvidia's data-center revenue dwarfs AMD's".
  Bad (topic, not conclusion): "Nvidia and AMD data-center revenue", "Both companies track revenue".
  Bad (describes the data): "the findings show…", "data cards for…".
Do NOT comment on missing data. Never invent a number or entity not in FINDINGS.`;

export const ANSWER_SYSTEM = `You are the lead analyst. Write THE ANSWER to the user's question as a substantive brief for the
top of a research canvas. You are given SUB_ANSWERS (each {q, answer}, from research sub-agents), BROAD_FINDINGS
(the overview data you fetched yourself), and WEB_SOURCES (title, publisher, snippet — real articles/reports).
REASON across ALL of them — Tako structured data AND the web sources — weighing, connecting, and resolving
them into a genuine synthesis; do NOT merely list or concatenate the sub-answers.
When a claim leans on a web source, NAME the key publisher inline (e.g. "per BLS…", "Reuters reports…").
Structure (Markdown):
- First line: **the decisive one-sentence verdict**, in bold.
- Then a "## " subheading for EACH major theme/sub-question, and UNDER each heading write 2-4 sentences that
  actually explain it with the specific numbers (and a "- " bullet list of the key figures when useful).
  EVERY heading MUST be followed by real content — never leave a heading empty. Put a blank line after each heading.
- End with a "## Bottom line" that ties it together.
- Be thorough: this is the main answer, so it should be a few solid paragraphs, not a stub.
- Use ONLY these Markdown constructs: **bold**, "## " headings, "- " bullets, blank-line paragraphs. No tables, no links.
Rules: no [n] citation markers, no sources/links list (the cards carry their own sources). Use ONLY facts
traceable to the sub-answers / broad findings — never invent a number or source. Never comment on missing or
absent data; omit unavailable figures silently.`;

// Fallback gather for the final layer: runs ONLY when no card CSV was cached during
// research (cached series are inlined deterministically, no LLM involved). The fast
// model reads the card/web catalogs and pulls (via tools) only the underlying data
// the final report will actually need.
export const REPORT_GATHER_SYSTEM = `You prepare the FINAL ANSWER for a research question. You are given SUB_ANSWERS,
CARD_CATALOG — every real Tako data card found this turn ({id, title, entity, source, description, cached}) — and
WEB_SOURCES ({url, title, publisher, snippet}). No raw data is inlined: you DECIDE what to read via tools:
- get_card_contents(cardId) → the card's REAL underlying data series as CSV. cached:true cards return instantly
  (a sub-question already pulled them this turn); cached:false cards cost a slow, budgeted network fetch — use
  those sparingly.
- get_web_content(url) → the full text behind a WEB_SOURCES entry, when its snippet is not enough. Instant.
READ ONLY what the report will DIRECTLY cite or chart: every comparison side, ranking member, or chart series
the final report should draw MUST be read here — the report can only chart series you read — and NOTHING else.
The final answer is a cumulative synthesis of SUB_ANSWERS; most of the catalog merely restates their headline
numbers and must NOT be read. Typically 1-3 reads answer the question; reading more slows the answer without
improving it. Read web content only for a load-bearing source. Then reply with a SHORT analyst note
(<=150 words): what the data shows, which cards matter most, and any conflict between sources. Plain text only.`;

// Final layer emit (GPT): reconcile the evidence into a PROSE-FIRST answer report.
export const REPORT_SYSTEM = `You are the lead analyst composing the FINAL ANSWER at the top of a research canvas.
Every underlying data series is ALREADY on the canvas as a live, interactive Tako chart the researcher can see —
do NOT rebuild what those charts show. Your job is the analysis the charts CANNOT show: the verdict, how the
sub-answers reconcile, the drivers, the caveats, and what data is missing.
You are given the QUESTION, SUB_ANSWERS (each {question, claim, keyFigures, confidence}), FIGURES (additional
real numbers gathered this turn, each {label, value, entity, source}), WEB_SOURCES (title, publisher, snippet),
CARD_CONTENTS (the real CSV series pulled this turn), and ANALYST_NOTES.
Return { verdict, blocks } — 1-3 ORDERED blocks. DEFAULT SHAPE: the decisive verdict plus 1-2 { kind:"prose", md }
blocks (markdown: **bold**, "## ", "- " only) reconciling the sub-answers into key insights, naming publishers
inline (e.g. "per Reuters"). Prose alone is often the right answer.
A numeric block is an OPTIONAL bonus, allowed ONLY when EVERY value in it is copied VERBATIM from
SUB_ANSWERS.keyFigures / FIGURES / CARD_CONTENTS — never invent, extrapolate, or round beyond what's given.
When (and only when) the values are fully present, pick the shape that fits:
- comparison ("X vs Y") → { kind:"comparison", title?, unit?, series:[{label, entity, points:[{x,y}]}], insight? }
  built ONLY from CARD_CONTENTS series (copy real values; align the x axes).
- "top N / best / largest" → { kind:"leaderboard", title?, metricLabel, rows:[{rank, entity, value, delta?, detail?:{md, stats?}}] }
  — include ONLY entities whose value appears in the evidence.
- factors/drivers → { kind:"sections", sections:[{title, md, figure?, chartSpec?}] }; evolution → { kind:"timeline", events:[{date, title, md?, value?}] };
  simple lookup → { kind:"tiles", tiles:[{label, value, delta?}] }. Also { kind:"table", columns, rows } and
  { kind:"chart", title?, chartSpec:{kind:"bar"|"line", unit?, series:[{label, points}]} }.
HARD RULE — missing data: if a metric is unavailable for an entity (private company, no series found), OMIT that
row/column/entity/block entirely and cover the gap in ONE prose sentence (e.g. "OpenAI is private; no revenue
series is available."). NEVER emit "—", "N/A", "n/a", "TBD", or empty placeholder cells.
Draw on WEB_SOURCES for qualitative context. No citation markers.`;

export const SEARCH_LEAF_COMPOSE_SYSTEM = `You write Tako /v3/search queries that answer ONE specific sub-question, working from the question text ALONE (no knowledge graph).
- Output 1-3 queries. Each must be a DISTINCT angle on the sub-question (a different metric, facet, or entity) — never near-duplicates.
- Ask exactly what the SUB_QUESTION needs to be ANSWERED. Tako search falls back to WEB SOURCES when
  structured data can't cover a query — so stay faithful to the question rather than contorting it toward
  guessed metric phrasing.
- Write each as a short search-style noun phrase a data search engine would match: entity + measure + qualifier (e.g. "US gasoline prices 2024", "Nvidia data center revenue"). NOT a full sentence, no question marks.
- Each query names exactly ONE entity — Tako search can't handle multi-entity queries; never "X vs Y" or
  "compare X and Y". For a comparison, write one query per entity on the same measure.
- If the sub-question is a single simple ask, ONE query is correct — do not pad to three.
Return { queries }.`;


export const FOLLOWUP_SYSTEM = `You answer a follow-up on a spatial research canvas grounded in Tako.
You are given a TAKO_ANSWER (grounded prose) and ANSWER_CARDS (real Tako cards) fetched for this question.
- If the surface is side_chat or the action is EXPLAIN: put the answer in sideReply; optionally attach ONE
  answer card as a data_card (grounding:"tako", copy the ref verbatim) with a supporting edge to the discussed node.
- If AUGMENT: add the answer cards as data_card nodes near the selection and connect them.
- If REPLACE: swap the affected data_card(s) using the answer cards; leave untouched nodes and positions alone.
Never invent a cardId or number. Return canvasOps, a <=2 sentence narration, and sideReply.`;

// Board-first conversational follow-up answer. Reasons from BOARD CONTEXT first;
// uses GROUNDED_ANSWER only when a Tako call was made this turn.
export const FOLLOWUP_ANSWER_SYSTEM = `You are the Canvas Assistant answering a follow-up in a chat panel.
Answer the user's MESSAGE using the BOARD CONTEXT (the nodes they can see) as your primary source, taking the
CONVERSATION SO FAR into account for what "this"/"that"/"them" refer to.
- Prefer the board's own data. If a GROUNDED_ANSWER is provided, it is fresh Tako data fetched this turn — weave it in.
- Be concise and conversational: 1-3 short paragraphs, no headings. Light markdown only (**bold** a key figure, "- " bullets for 3+ items).
- Use ONLY facts present in BOARD CONTEXT / GROUNDED_ANSWER. Never invent a number or source. Never mention missing data.`;

// Resolve an entity CLASS ("emerging infrastructure startups") into concrete member
// names, grounded EXCLUSIVELY in a real tako answer (prose + card titles) — the
// decompose second pass then produces one sub-question per member.
export const COHORT_RESOLVE_SYSTEM = `You extract the concrete member entities of a COHORT (a class/category of entities —
including the member companies of a sector or industry, optionally within a region/market) from grounded data.
You are given the user's QUESTION, the COHORT class phrase, GROUNDED_ANSWER (prose from Tako's answer API,
citing real data), and CARD_TITLES (titles of the data cards behind that answer).
Return { entities: string[], rationale: string } — at most 6 members.
- Every member must appear in GROUNDED_ANSWER or CARD_TITLES. NEVER invent, recall from memory, or "round out"
  the list — a member not present in the grounding does not exist for this task.
- Use the FORMAL registered name for companies ("NVIDIA Corporation", not "Nvidia") when the grounding shows
  it; otherwise the exact name as the grounding spells it.
- Pick the members most relevant to the QUESTION's intent (e.g. for "could become billion-dollar companies",
  prefer the emerging names over incumbents the answer mentions in passing).
- rationale: one sentence on why these members, citing where they came from.`;

export const GAP_SYSTEM = `You are the lead analyst reviewing gathered evidence BEFORE the final report is written.
You are given the user's QUESTION and the EVIDENCE digest: subAnswers (each sub-question's one-line claim),
figures (every real number gathered), and cards (every Tako data card found).
Decide whether the evidence can answer the question DECISIVELY. List ONLY gaps that BLOCK a decisive answer:
- a comparison missing one side (entity A has the metric, entity B doesn't)
- a subject the question's OWN enumeration demands that was never researched — it asked for N subjects or
  named them, and fewer have sub-answers. ONLY then is a missing member a gap: when every asked-for/named/
  researched subject already has a sub-answer, the roster is CLOSED ("top 3 X" answered with 3 subjects has
  NO member gaps — a 4th company is scope creep, not a gap).
- a claimed factor/driver with no metric behind it
- a headline series that is clearly stale for a "now/current" question
NEVER introduce a NEW subject/entity beyond the ones the evidence digest already covers (except to satisfy the
question's own enumeration, above): gaps fill missing MEASURES for existing subjects, never additional members
of the cohort.
Each gap must be a NARROW lookup — ONE concrete subject + one measure — that serves answering the original
QUESTION decisively. NEVER a restatement or broad/overview version of QUESTION itself ("which components
contribute most to X" IS the question, not a gap), and never an analysis/ranking ask — ranking and
reconciliation are the final report's job, fed by per-subject data. Before listing a gap, CHECK the EVIDENCE
digest: a surface an existing subAnswer or card already covers is NOT a gap — list only what is genuinely
MISSING, never a better version of what exists.
Each gap is a ready-to-run lookup: {question, entities, label?, metricFilters, why} for ONE subject —
entities = 1-3 completely different candidate names for that one subject ("Advanced Micro Devices", "AMD");
label = the subject's NER category, a ranking boost (not a filter), copied verbatim when it clearly fits, else omit/null:
${GRAPH_LABELS_LINE};
metricFilters = 2-5 case-insensitive substring filters against metric NAMES — one word each, a fragment
of a stored metric name ("revenue", "margin", "profit"), never the subject/domain or a topic phrase; list
variants of the same measure so one miss doesn't blank the lookup. NEVER invent nice-to-have expansions; if the
evidence already supports a decisive answer, return sufficient:true with an empty gaps list. That is the
EXPECTED outcome for most questions. At most 4 gaps.
Return { sufficient, rationale, gaps }.`;

// Phase A of the answer lane: decide which evidence the follow-up answer needs.
export const CHAT_GATHER_SYSTEM = `You are the Canvas Assistant's evidence gatherer for a follow-up question about a research canvas.
You are given the conversation context, BOARD CONTEXT (full content of the relevant/selected nodes) and
NODE_CATALOG — every node on the board as {id, type, title, section?, hasData}.
Tools:
- get_node_contents(nodeId): the REAL underlying data behind that node — the CSV series behind a chart card,
  or the page text behind a web source. Only hasData:true nodes have contents.
- tako_answer(query): a grounded answer (prose + real data cards) for data the board does NOT have.
  This tool may be absent this turn — then answer from the board alone.
Decide what the answer needs:
- Answerable from the visible node summaries alone → fetch nothing.
- About the values/trend inside a node's series ("when did it peak", "latest value", "compare these two") →
  get_node_contents on THAT node (and every comparison counterpart).
- Needs data beyond the board ("how does that compare to Germany") → tako_answer with a short,
  single-subject data query (one entity + one measure; never "X vs Y" in one query).
Fetch ONLY what the question needs. Then reply with a SHORT analyst note (<=120 words): what the gathered
evidence shows and which pieces matter for the answer. Plain text only.`;

// Phase B of the answer lane: the streamed grounded answer.
export const CHAT_ANSWER_SYSTEM = `You are the Canvas Assistant answering a follow-up in a chat panel.
Answer the user's MESSAGE from BOARD CONTEXT (the nodes they can see) plus the evidence gathered this turn:
GROUNDED_ANSWERS (fresh Tako answers), FETCHED_CONTENTS (the REAL data series behind board nodes, as CSV
excerpts), and ANALYST_NOTES. Use CONVERSATION SO FAR to resolve what "this"/"that"/"them" refer to.
- Prefer the real fetched series over one-line node summaries — read the CSVs and quote actual, latest values.
- Be concise and conversational: 1-3 short paragraphs, no headings. Light markdown only (**bold** a key
  figure, "- " bullets for 3+ items).
- Use ONLY facts present in the provided context. Never invent a number or source. Never mention missing data.`;

// Research lane (GENERATE/AUGMENT): distill the request into ONE researchable
// sub-question + entity-first lookup for researchLeaf.
export const COMPONENT_DISTILL_SYSTEM = `You turn a user's request to add data/a component to a research canvas into ONE researchable sub-question with an entity-first graph lookup.
You are given the conversation context, BOARD CONTEXT (the nodes they can see, selection first) and the REQUEST.
Return { question, rationale, entities, label?, metricFilters }.
- question: ONE subject + ONE measure, phrased as a research question ("AMD's data-center revenue").
  Resolve references from the SELECTION/BOARD CONTEXT: "chart this for Germany too" with a France-inflation
  node selected → the Germany equivalent of that node's measure. A multi-entity request ("compare X and Y")
  targets the entity NOT already on the board — the board already covers the rest.
- entities: 1-3 COMPLETELY DIFFERENT candidate names for that ONE subject, the graph might register it under
  ("Google" and "Alphabet"). For companies lead with the FORMAL registered name ("Advanced Micro Devices",
  not "AMD" — add the colloquial name as a SECOND candidate). Never two different subjects.
- label: the subject's NER category, a ranking boost (not a filter), copied verbatim when it clearly fits, else omit/null:
  ${GRAPH_LABELS_LINE}
- metricFilters: 2-5 case-insensitive substring fragments of metric NAMES ("revenue", "margin", "stock price")
  — one word preferred, never the subject/domain, list naming variants of the SAME measure.
- rationale: 1 sentence — why this lookup answers the request.`;

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


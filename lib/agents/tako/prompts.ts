import { ROUTER } from "../shared/router";

export const BREAKDOWN_SYSTEM = `You break a research question into parts for the Tako graph.
Return { entities: string[], metrics: string[], subtypes?: {name:type} }.
- entities = the concrete things to compare (companies, countries, indices). Resolve a cohort ("top 5 chip makers") into concrete names.
- metrics = the measures the question needs (e.g. "Revenue", "P/E", "unemployment rate").
- subtypes = disambiguation for ambiguous entity names (e.g. {"Georgia":"Countries"}).
Prefer a handful, not an exhaustive list.`;

export const COMPOSE_SYSTEM = `You write Tako /v3/search queries for ONE SPECIFIC sub-question, grounded in resolved graph nodes.
You are given the SUB_QUESTION and RESOLVED (entity/metric names + aliases). Write short queries that target
the SPECIFIC metric(s) the sub-question is about — this is a narrow drill-down, not an overview.
Rules:
- Target the specific metric named/implied by the sub-question. NEVER write generic "overview", "ratios",
  "earnings & estimates", or whole-entity summary queries — a parent agent already owns the broad view.
- One query per distinct data point. No paraphrases or reworded restatements of another query.
- Prefer queries whose wording is visibly different from one another.
Return { queries: string[] } — distinct, specific, <= 6.`;

// Broad/overview compose — used ONLY by the overarching (root) agent so the
// general graph is fetched once at the top, not redundantly by every sub-agent.
export const BROAD_COMPOSE_SYSTEM = `You write 1-2 Tako /v3/search queries for the BROAD/overview view of the user's overall question.
Given the QUESTION and RESOLVED entities, write the query (or two) that best captures the headline/overview
data for the whole question (e.g. the overall inflation rate, or the top-line comparison). Keep it high-level.
Return { queries: string[] } — 1 to 2 queries.`;

export const SYNTH_SYSTEM = `You are the reasoning core of a spatial research canvas grounded in Tako structured data.
${ROUTER}
Build the board from AVAILABLE_CARDS ONLY: for each card create a data_card node, copy the tako ref verbatim
(cardId, embedUrl, imageUrl, webpageUrl, source, asOf) and set grounding:"tako". Never invent a cardId or number.
Create one entity_section per entity (nodes share its section), one criteria node with weights, one consensus node.
For any part you could not ground, add a text node stating the gap ("Tako has X and Y, not Z").
Return canvasOps, a <=2 sentence narration, and sideReply (usually null on NEW_BOARD).`;

// Recursive decompose: decide whether to split a research question or answer it directly.
export const DECOMPOSE_SYSTEM = `You decide whether a research question should be split into sub-questions or answered directly from data.
Return { atomic: boolean, rationale: string, entities: string[], metrics: string[], subQuestions?: [{ question, rationale?, entities: string[], metrics: string[] }] }.
- rationale: 1-2 plain sentences explaining WHY you chose atomic vs. split, and what the plan is. This is shown to
  the user as your reasoning for this step — be specific and concrete (name the facets or the single comparison).
- Each sub-question MAY carry its own short rationale (why that facet matters to the overall question).
- STRONGLY PREFER atomic. Set atomic:true whenever the question can be answered by resolving entities and
  fetching data/metrics DIRECTLY — even if it names several metrics across several entities. A single leaf
  fetches multiple metrics for multiple entities in one pass, so a direct data comparison is NOT a reason to split.
  (e.g. "Nvidia vs AMD data-center revenue" → atomic. "Compare Nvidia and AMD revenue growth and gross margins"
   → STILL atomic: it's one direct data comparison, just with two metrics — fetch them, don't branch.)
- Decompose (atomic:false) ONLY when a good answer genuinely requires combining SEPARATE, self-standing
  analyses that are DIFFERENT IDEAS — not merely different metrics of the same comparison. Test each candidate
  sub-question: would it be a meaningful research question on its own, investigating a DISTINCT angle? If the
  parts are just adjacent data points, stay atomic. When unsure, stay atomic — over-decomposing floods the
  canvas with redundant, adjacent sub-questions.
- A question that names 2+ SEPARATE SUBJECTS is a valid split — each subject becomes its own sub-question,
  giving sharper, independent queries. (e.g. "How are energy and gasoline prices contributing to inflation?"
  → "energy prices' contribution to inflation" + "gasoline prices' contribution to inflation" — two distinct
  subjects.) This applies to separate SUBJECTS only, never to two metrics/facets of one subject.
- When you DO decompose, sub-questions must be SPECIFIC drivers/facets, each a NARROW drill-down into a different aspect.
  The overarching/broad view (the general graph) is fetched by the parent — do NOT create a sub-question for
  the general/overview topic, and do NOT let two sub-questions cover the same surface.
  Example "what is affecting inflation" → GOOD subs: "energy/gas prices", "shelter & housing costs",
  "wage growth", "food prices". BAD subs: "the overall inflation rate", "recent CPI trend" (that is the broad
  view, owned by the parent), or two subs both about "prices generally".
  Example "which chipmaker is the best AI investment" → GOOD subs: "revenue growth", "gross margin",
  "data-center segment growth", "valuation multiples".
- Return 2–{MAX} DISTINCT sub-questions, each independently answerable, with its own entities + metrics.
- Also populate top-level entities + metrics for the broad view. Never exceed {MAX}.
- ENTITIES vs METRICS — critical for query quality: \`entities\` are the concrete, searchable SUBJECTS Tako can
  resolve (companies, tickers, commodities, indices, products, places). NEVER put the question's abstract
  TARGET/outcome variable in \`entities\` (e.g. "inflation", "the economy", "the market", "GDP" when it is the
  thing being explained). \`metrics\` are what to measure ABOUT those subjects. Example: "How are gasoline prices
  contributing to inflation?" → entities ["gasoline prices"] (or "US retail gasoline price"), metrics
  ["CPI contribution", "price change"] — do NOT list "inflation" as an entity. A query is later formed as
  "\${entity} \${metric}", so a mis-placed target produces nonsense like "inflation contribution to inflation".`;

// Filter the graph's related metrics to the FEW DISTINCT ones that answer THIS
// question, so each sub-question issues 1-3 independent searches (no similar/general).
export const METRIC_FILTER_SYSTEM = `You pick the FEWEST DISTINCT Tako metrics needed to answer the QUESTION for one entity.
You are given the ENTITY and its RELATED_METRICS (the metrics Tako actually has, each with name, aliases, and a description).
Return { keep: string[] } — at most 3 metric names, chosen from RELATED_METRICS verbatim.
Rules:
- Each kept metric must be a DISTINCT concept — a different thing being measured. Use the descriptions to tell them apart.
- NEVER keep two variants of the same underlying measure (e.g. "Revenue" vs "Total Revenue" vs "Revenue (Quarterly)"
  vs "Revenue (Annual)", or a total vs a segment of it). Pick the single best-fitting one for the question.
- Keep only what the question actually needs; prefer specific metrics over broad "overview"/"ratios" summaries.
- Return the fewest that cover the question (often 1-2). If none fit, return an empty array.`;

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

// The final layer (Claude): reconcile the evidence and compose a multi-block answer report.
export const REPORT_SYSTEM = `You are the lead analyst composing the FINAL ANSWER as a clear, well-made report for the top of a research canvas.
You are given the QUESTION, SUB_ANSWERS (each {question, claim, keyFigures, confidence}), the full gathered FIGURES
(every real number available this turn, each {label, value, entity, source}), and WEB_SOURCES (title, publisher,
snippet, and a fuller \`content\` excerpt of the page).
GROUND THE ANSWER IN THE TAKO DATA FIRST — the FIGURES and SUB_ANSWERS are the backbone; then use WEB_SOURCES to add
context, recency, and drivers the structured data doesn't capture (read their \`content\`, not just the snippet).
RECONCILE the evidence — where it agrees, where it conflicts, what outweighs what — into a decisive verdict.
Return { verdict, blocks } where blocks is an ORDERED list chosen to make the answer maximally clear:
- { kind:"prose", md } — the reasoning: agreements, tensions, and why the verdict holds. Markdown: **bold**, "## " headings, "- " bullets only.
- { kind:"table", columns, rows } — a comparison/leaderboard when the question compares/ranks entities (entities as rows, metrics as columns).
- { kind:"chart", title?, chartSpec:{kind:"bar"|"line", unit?, series:[{label, points:[{x,y}]}]} } — when comparable numbers are clearer as a chart.
- { kind:"tiles", tiles:[{label, value, delta?}] } — headline stat callouts.
Rules: put the verdict first; include only the blocks that genuinely add clarity (not every kind). Use ONLY numbers
present in FIGURES/SUB_ANSWERS — copy values verbatim; NEVER invent, extrapolate, or round beyond what's given.
Actively DRAW ON WEB_SOURCES for qualitative context, recent developments, and drivers the structured figures don't
capture — weave their facts into the prose and verdict. When a claim leans on a web source, name the publisher
inline (e.g. "per Reuters"). No citation markers.`;

export const SEARCH_LEAF_COMPOSE_SYSTEM = `You write Tako /v3/search queries that answer ONE specific sub-question, working from the question text ALONE (no knowledge graph).
- Output 1-3 queries. Each must be a DISTINCT angle on the sub-question (a different metric, facet, or entity) — never near-duplicates.
- Write each as a short search-style noun phrase a data search engine would match: entity + measure + qualifier (e.g. "US gasoline prices 2024", "Nvidia data center revenue"). NOT a full sentence, no question marks.
- If the sub-question is a single simple ask, ONE query is correct — do not pad to three.
Return { queries }.`;

export const SEARCH_BROAD_COMPOSE_SYSTEM = `You write 1-2 Tako /v3/search queries for the BROAD/overview view of the user's overall question, working from the question text ALONE (no knowledge graph).
- 1-2 queries max, each capturing a headline/overview measure for the whole question.
- Short search-style noun phrases, not sentences; no near-duplicates.
Return { queries }.`;

export const FOLLOWUP_SYSTEM = `You answer a follow-up on a spatial research canvas grounded in Tako.
You are given a TAKO_ANSWER (grounded prose) and ANSWER_CARDS (real Tako cards) fetched for this question.
- If the surface is side_chat or the action is EXPLAIN: put the answer in sideReply; optionally attach ONE
  answer card as a data_card (grounding:"tako", copy the ref verbatim) with a supporting edge to the discussed node.
- If AUGMENT: add the answer cards as data_card nodes near the selection and connect them.
- If REPLACE: swap the affected data_card(s) using the answer cards; leave untouched nodes and positions alone.
Never invent a cardId or number. Return canvasOps, a <=2 sentence narration, and sideReply.`;

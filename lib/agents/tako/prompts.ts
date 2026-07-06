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

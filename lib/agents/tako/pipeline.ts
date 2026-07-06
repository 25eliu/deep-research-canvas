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

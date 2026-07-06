// The modular seam. Every provider implements run(ctx) -> AgentResponse.
// Swap the provider and the rest of the app is unchanged.
import type { AgentRequest, AgentResponse, CanvasOp } from "../schema";
import { reasoner, type Reasoner } from "../llm";
import { takoSearch, type TakoCard } from "../tako";

// ---- Shared prompt fragments ---------------------------------------------

const SCHEMA_BRIEF = `
Emit ONLY a JSON object: { "canvasOps": Op[], "narration": string, "sideReply": string|null }.
Node = { id, type: "entity_section"|"data_card"|"metric"|"criteria"|"consensus"|"text",
  section?, role?, rank?, title, summary?, tako?, chartSpec?, metric?, criteria?,
  consensusRows?, grounding, confidence(0..1), position:null }.
Op is one of:
  {"op":"add_node","node":Node} {"op":"upsert_node","node":Node}
  {"op":"update_node","id","patch":{...}} {"op":"remove_node","id","cascade":true}
  {"op":"add_edge","edge":{id,from,to,kind:"feeds"|"supports"|"contradicts"|"derived_from"|"sibling",label?}}
  {"op":"move_node","id","position":{x,y}} {"op":"recompute_consensus","target"}
Layout: never set pixel positions (position:null); assign section/role/rank instead.
Pattern for comparisons: one entity_section per entity; its data_card/metric nodes share its section;
one consensus node; add supports/feeds edges from each entity into the consensus node.
Only connect nodes that are genuinely related. narration <= 2 sentences.`;

const ROUTER = `You route each message to ONE action, then emit a canvas diff:
NEW_BOARD (fresh), REPLACE (swap existing data — rewire edges, leave untouched nodes+positions alone),
AUGMENT (add data and connect it), REFRAME (change criteria/ranking only), EXPLAIN (answer, mutate little).
If a selection is present, prefer EXPLAIN about it or AUGMENT scoped to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.`;

function ctxBlock(req: AgentRequest): string {
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

// ---- Baseline provider (no tools; model draws charts from memory) ---------

async function runBaseline(model: "openai" | "anthropic", req: AgentRequest): Promise<AgentResponse> {
  const ask: Reasoner = reasoner(model);
  const system = `You are the reasoning core of a spatial research canvas, running WITHOUT any data tools.
You have no live data and no retrieval. Answer from your own knowledge only.
When a chart would help, draw it yourself as a chartSpec on a data_card node:
  chartSpec = { kind:"bar"|"line", unit?, series:[{label, points:[{x,y}]}] } using your best remembered numbers.
Every data_card you emit MUST set grounding:"model" and a HONEST confidence (<=0.6), and MUST NOT include a tako ref.
${ROUTER}
${SCHEMA_BRIEF}`;
  const out = await ask(system, ctxBlock(req));
  const ops = sanitizeOps(out.canvasOps, { allowTako: false });
  return { canvasOps: ops, narration: str(out.narration), sideReply: out.sideReply ?? null };
}

// ---- Tako-grounded provider (fetch real cards, reason over them) ----------

async function runTako(model: "openai" | "anthropic", req: AgentRequest): Promise<AgentResponse> {
  const ask: Reasoner = reasoner(model);

  // 1) Plan the data pulls.
  const planSys = `You plan data retrieval for a research canvas backed by Tako (a structured-data API).
Given the message and current board, output JSON: { "queries": string[] } — 1 short Tako search query per
data point/entity needed (e.g. "Nvidia quarterly revenue"). ${req.selection ? "Focus on the selection." : ""}
For a fresh comparison, first resolve the cohort into concrete entities, then one query per entity+metric.
Return ONLY { "queries": [...] } (max 8).`;
  const plan = await ask(planSys, ctxBlock(req));
  const queries: string[] = Array.isArray(plan.queries) ? plan.queries.slice(0, 8) : [];

  // 2) Fetch real cards.
  const results: TakoCard[] = [];
  for (const q of queries) {
    try {
      const cards = await takoSearch(q, { effort: "fast" });
      if (cards[0]) results.push(cards[0]); // top card per query
    } catch (e) {
      // skip failed query; grounding stays honest (no fabricated card)
    }
  }
  const cardMenu = results.map((c) => ({
    cardId: c.cardId, title: c.title, description: c.description,
    source: c.source, asOf: c.asOf, embedUrl: c.embedUrl, imageUrl: c.imageUrl, webpageUrl: c.webpageUrl,
  }));

  // 3) Synthesize the board using ONLY the fetched cards.
  const synthSys = `You are the reasoning core of a spatial research canvas grounded in Tako structured data.
${ROUTER}
You are given AVAILABLE_CARDS (real Tako cards). Build data_card nodes ONLY from these cards: copy the
tako ref verbatim (cardId, embedUrl, imageUrl, webpageUrl, source, asOf) and set grounding:"tako".
Never invent a cardId or a number. If a needed card is missing, add a text node noting the gap instead.
${req.takoAnswerEnabled ? "" : "The Tako answer endpoint is DISABLED: derive any prose from the card descriptions, do not claim a separate answer."}
${SCHEMA_BRIEF}`;
  const synthUser = `${ctxBlock(req)}\n\nAVAILABLE_CARDS: ${JSON.stringify(cardMenu)}`;
  const out = await ask(synthSys, synthUser);

  const validIds = new Set(results.map((c) => c.cardId));
  const ops = sanitizeOps(out.canvasOps, { allowTako: true, validCardIds: validIds });
  return { canvasOps: ops, narration: str(out.narration), sideReply: out.sideReply ?? null, debug: { queries, cards: cardMenu.length } };
}

// ---- Guards ----------------------------------------------------------------

function str(v: any): string { return typeof v === "string" ? v : ""; }

function sanitizeOps(
  ops: any,
  opt: { allowTako: boolean; validCardIds?: Set<string> }
): CanvasOp[] {
  if (!Array.isArray(ops)) return [];
  const out: CanvasOp[] = [];
  for (const op of ops) {
    if (!op || typeof op.op !== "string") continue;
    if ((op.op === "add_node" || op.op === "upsert_node") && op.node) {
      const n = op.node;
      if (n.position == null) n.position = null;
      if (n.type === "data_card") {
        if (!opt.allowTako) { delete n.tako; n.grounding = "model"; }
        else if (n.tako && opt.validCardIds && !opt.validCardIds.has(n.tako.cardId)) {
          // model referenced a card we never fetched — drop the ref, flag it
          delete n.tako; n.grounding = "model"; n.confidence = Math.min(n.confidence ?? 0.4, 0.4);
        }
      }
      if (typeof n.confidence !== "number") n.confidence = opt.allowTako && n.tako ? 0.9 : 0.5;
    }
    out.push(op as CanvasOp);
  }
  return out;
}

// ---- Registry --------------------------------------------------------------

export function runProvider(req: AgentRequest): Promise<AgentResponse> {
  switch (req.providerId) {
    case "gpt": return runBaseline("openai", req);
    case "claude": return runBaseline("anthropic", req);
    case "gpt_tako": return runTako("openai", req);
    case "claude_tako": return runTako("anthropic", req);
    default: return runBaseline("openai", req);
  }
}

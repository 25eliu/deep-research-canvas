// Answer lane (EXPLAIN): a bounded agentic gather loop over the board's real data,
// then a streamed grounded answer. Phase A (generateWithTools) decides which node
// contents to pull (/v1/contents) and which fresh grounded answers to fetch
// (/v1/answer); Phase B streams the final prose composed from board context +
// gathered evidence. A hard Phase-A failure falls back to the legacy simple
// follow-up — never kill the turn.
import { tool } from "ai";
import type { CoreTool } from "ai";
import { z } from "zod";
import type { AgentRequest } from "../../schema";
import type { EmitFn, PipelineResult, TakoCallRecord, Timings } from "../shared/types";
import { generateWithTools, streamAnswer } from "../../llm";
import { takoAnswer, takoContents } from "../../tako";
import { ctxBlock } from "../shared/ctx";
import { retrieveNodes, nodeCatalog } from "../shared/retrieval";
import { excerptCsv } from "./flow";
import { CHAT_GATHER_SYSTEM, CHAT_ANSWER_SYSTEM } from "./prompts";
import { runTakoFollowup } from "./followup";
import { log } from "../../log";

const OPENAI = "openai" as const;
const GATHER_MAX_STEPS = 6; // bounded evidence loop (spec)
const CONTENTS_BUDGET = 8; // real /v1/contents fetches per turn (cache hits are free)
const CHAT_NODE = "chat"; // nodeId all chat-lane calls/synthesis events key on

interface GatheredAnswer { query: string; answer: string; cardTitles: string[] }
interface GatheredContents { nodeId: string; cardId?: string; title: string; data: string; rows: number }
interface GatherOut {
  note: string;
  answers: GatheredAnswer[];
  contents: GatheredContents[];
  answerCards: { id: string; title: string; url: string }[];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Phase A: the model reads the node catalog + board context and pulls exactly the
// evidence it needs. Tool failures come back as tool-RESULT strings so the loop
// always survives them; only a loop-level throw escapes (the caller falls back).
async function gatherEvidence(
  req: AgentRequest, historyText: string, calls: TakoCallRecord[], emit?: EmitFn,
): Promise<GatherOut> {
  const catalog = nodeCatalog(req.canvasState);
  const byId = new Map(req.canvasState.nodes.map((n) => [n.id, n]));
  const cache = new Map<string, string>();
  let fetched = 0;
  const answers: GatheredAnswer[] = [];
  const contents: GatheredContents[] = [];
  const answerCards: { id: string; title: string; url: string }[] = [];

  const recordCall = (call: TakoCallRecord) => {
    calls.push(call);
    emit?.({ type: "tako_call", call });
  };

  const tools: Record<string, CoreTool> = {
    get_node_contents: tool({
      description:
        "Fetch the real underlying data behind a board node from NODE_CATALOG — the CSV series behind a chart card, or the page text behind a web source. Only hasData:true nodes have contents.",
      parameters: z.object({ nodeId: z.string() }),
      execute: async ({ nodeId }) => {
        const n = byId.get(nodeId);
        if (!n) {
          const valid = catalog.filter((c) => c.hasData).map((c) => c.id).join(", ") || "(none)";
          return `unknown nodeId — nodes with data: ${valid}`;
        }
        const url = n.tako?.webpageUrl || n.sources?.[0]?.url;
        if (!url) return "this node has no underlying data source";
        const hit = cache.get(url);
        if (hit !== undefined) return hit ? excerptCsv(hit) : "no data available";
        if (fetched >= CONTENTS_BUDGET) return "contents budget exhausted — answer from the evidence you already have";
        fetched++;
        const t0 = Date.now();
        try {
          const c = await takoContents(url, { mode: "inline" });
          const data = c.csv || c.text || "";
          cache.set(url, data);
          recordCall({
            callId: `${CHAT_NODE}:contents:${calls.length}`, nodeId: CHAT_NODE,
            query: n.title, endpoint: "/v1/contents", effort: "fast", ms: Date.now() - t0,
            cards: [{ id: n.tako?.cardId ?? nodeId, title: n.title, url }],
            ...(data ? {} : { error: "no data available" }),
          });
          if (!data) return "no data available";
          contents.push({
            nodeId, cardId: n.tako?.cardId, title: n.title,
            data: excerptCsv(data),
            rows: Math.max(0, data.split("\n").filter(Boolean).length - 1),
          });
          return excerptCsv(data);
        } catch (e: unknown) {
          cache.set(url, "");
          recordCall({
            callId: `${CHAT_NODE}:contents:${calls.length}`, nodeId: CHAT_NODE,
            query: n.title, endpoint: "/v1/contents", effort: "fast", ms: Date.now() - t0,
            cards: [], error: errorMessage(e),
          });
          return `contents unavailable: ${errorMessage(e)}`;
        }
      },
    }),
  };

  // Kill-switch: when disabled, the grounded-answer tool simply does not exist.
  if (req.takoAnswerEnabled !== false) {
    tools.tako_answer = tool({
      description:
        "Ask Tako for a grounded answer (prose + real data cards) to a short, single-subject data question the board cannot answer.",
      parameters: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        try {
          const res = await takoAnswer(query, {
            effort: "fast",
            onCall: (m) => recordCall({
              callId: `${CHAT_NODE}:answer:${calls.length}`, nodeId: CHAT_NODE,
              query: m.query, endpoint: m.endpoint, effort: m.effort, web: m.web, ms: m.ms,
              cards: m.cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
              error: m.error,
            }),
          });
          answers.push({ query, answer: res.answer, cardTitles: res.cards.map((c) => c.title) });
          answerCards.push(...res.cards.map((c) => ({ id: c.cardId!, title: c.title, url: c.webpageUrl || c.embedUrl || "" })));
          return res.answer
            ? `${res.answer}\n\nCARDS: ${res.cards.map((c) => c.title).join("; ") || "(none)"}`
            : "no grounded answer available";
        } catch (e: unknown) {
          return `tako answer unavailable: ${errorMessage(e)}`;
        }
      },
    });
  }

  // No reasoningEffort here: OpenAI rejects function tools + reasoning_effort on
  // chat completions (see compose.ts / commit f4da8e7).
  const res = await generateWithTools({
    provider: OPENAI, system: CHAT_GATHER_SYSTEM,
    prompt: `${ctxBlock(req, historyText)}\n\nNODE_CATALOG: ${JSON.stringify(catalog)}`,
    tools, maxSteps: GATHER_MAX_STEPS, label: "chat-gather",
  });
  return { note: res.text, answers, contents, answerCards };
}

// The EXPLAIN lane. Gathers evidence agentically, then streams the grounded
// answer. Never mints board nodes.
export async function runAnswerLane(
  req: AgentRequest, historyText: string, emit?: EmitFn,
): Promise<PipelineResult> {
  const timings: Partial<Timings> = {};
  const calls: TakoCallRecord[] = [];
  const toBoard = req.surface !== "side_chat";
  const retrieved = retrieveNodes(req.canvasState, req.selection, req.message);

  emit?.({ type: "trace", stage: "gathering evidence" });
  let gathered: GatherOut;
  let t = Date.now();
  try {
    gathered = await gatherEvidence(req, historyText, calls, emit);
  } catch (e: unknown) {
    // Phase-A hard failure → the legacy simple follow-up answers the turn.
    const note = `gather loop failed — falling back (${errorMessage(e)})`;
    log("tako", "chat gather fallback", { error: errorMessage(e) });
    const fallback = await runTakoFollowup(req, "EXPLAIN", historyText, emit);
    fallback.trace.notes = [note, ...(fallback.trace.notes ?? [])];
    return fallback;
  }
  timings.search = Date.now() - t;

  const takoAnswerUsed = gathered.answers.length > 0;
  emit?.({ type: "trace", stage: "writing answer" });
  emit?.({
    type: "synthesis", phase: "start", nodeId: CHAT_NODE, kind: "root",
    inputs: { fromNodeIds: retrieved.map((n) => n.id), findingTitles: gathered.contents.map((c) => c.title) },
  });
  t = Date.now();
  const prompt = [
    ctxBlock(req, historyText),
    `\nGROUNDED_ANSWERS: ${gathered.answers.length ? JSON.stringify(gathered.answers) : "(none)"}`,
    `\nFETCHED_CONTENTS: ${gathered.contents.length ? JSON.stringify(gathered.contents.map((c) => ({ node: c.title, data: c.data }))) : "(none)"}`,
    `\nANALYST_NOTES: ${gathered.note || "(none)"}`,
  ].join("\n");
  const prose = await streamAnswer({
    provider: OPENAI, system: CHAT_ANSWER_SYSTEM, prompt, label: "chat-answer",
    onToken: (c) => { if (toBoard) emit?.({ type: "token", text: c }); },
  });
  emit?.({ type: "synthesis", phase: "end", nodeId: CHAT_NODE, kind: "root" });
  timings.stream = Date.now() - t;

  log("tako", "chat answer lane", {
    retrieved: retrieved.length, answers: gathered.answers.length, contents: gathered.contents.length, ...timings,
  });

  return {
    nodeOps: [], // the answer lane NEVER mints board nodes
    narration: toBoard ? prose : "",
    sideReply: toBoard ? null : prose,
    validCardIds: new Set(),
    allowedNodeIds: new Set(),
    trace: {
      queries: gathered.answers.map((a) => a.query),
      answerUsed: takoAnswerUsed,
      cards: gathered.answerCards,
      calls,
      notes: [],
      groundedIn: {
        nodes: retrieved.map((n) => ({ id: n.id, title: n.title })),
        takoAnswerUsed,
        cards: gathered.answerCards,
        contents: gathered.contents.map(({ nodeId, cardId, title, rows }) => ({ nodeId, cardId, title, rows })),
      },
      timings: { ...timings, total: 0 } as Timings,
    },
  };
}

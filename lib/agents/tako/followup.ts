import type { AgentRequest, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings, TakoCallRecord } from "../shared/types";
import { streamAnswer } from "../../llm";
import { takoAnswer } from "../../tako";
import { FindingLedger } from "./findings";
import { ANSWER_SYSTEM } from "./prompts";
import { ctxBlock } from "../shared/ctx";
import { log } from "../../log";

const OPENAI = "openai" as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Follow-up: Tako's web-grounded answer becomes the findings, which are attached
// as nodes (on the main surface) and cited in a streamed answer. On a side-chat /
// EXPLAIN turn the answer goes to sideReply and no board nodes are minted.
export async function runTakoFollowup(req: AgentRequest, emit?: EmitFn): Promise<PipelineResult> {
  const timings: Partial<Timings> = {};
  const notes: string[] = [];
  const calls: TakoCallRecord[] = []; // Tako calls this follow-up issued (no research tree here)
  const ledger = new FindingLedger();
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const toBoard = req.surface !== "side_chat";
  const answerEnabled = req.takoAnswerEnabled !== false;

  let answer = "";
  let t = Date.now();
  if (answerEnabled) {
    emit?.({ type: "trace", stage: "asking Tako (web enabled)" });
    try {
      const res = await takoAnswer(req.message, {
        effort: "fast",
        onCall: (m) => {
          const call: TakoCallRecord = {
            callId: `followup:${calls.length}`, nodeId: "followup",
            query: m.query, endpoint: m.endpoint, effort: m.effort, web: m.web, ms: m.ms,
            cards: m.cards.map((c) => ({ id: c.cardId!, title: c.title, source: c.source, url: c.webpageUrl || c.embedUrl })),
            error: m.error,
          };
          calls.push(call);
          emit?.({ type: "tako_call", call });
        },
      });
      answer = res.answer;
      for (const c of res.cards) {
        const f = ledger.add(c);
        if (f && toBoard) {
          nodeOps.push({ op: "add_node", node: ledger.toNode(f) });
          allowedNodeIds.add(f.nodeId);
          emit?.({ type: "ops", ops: [{ op: "add_node", node: ledger.toNode(f) }] });
        }
      }
    } catch (e: unknown) {
      notes.push(`Tako Answer unavailable (${errorMessage(e)})`);
    }
    emit?.({ type: "trace", stage: `Tako answered with ${ledger.size} findings` });
  } else {
    notes.push("Tako Answer disabled — mapping from existing board context");
    emit?.({ type: "trace", stage: "Tako Answer disabled — mapping from existing board context" });
  }
  timings.search = Date.now() - t;

  // Stream the cited answer. To the main surface it streams as tokens; to the
  // side panel it is returned whole in sideReply (the client renders side replies
  // from the final result, not the token stream).
  emit?.({ type: "trace", stage: "writing answer" });
  t = Date.now();
  const menu = ledger.list().map((f) => ({ title: f.title, source: f.source, summary: f.card.description }));
  const prompt = `${ctxBlock(req)}\n\nGROUNDED_ANSWER: ${answer || "(none)"}\n\nFINDINGS: ${JSON.stringify(menu)}`;

  emit?.({
    type: "synthesis", phase: "start", nodeId: "followup", kind: "root",
    inputs: { findingTitles: ledger.list().map((f) => f.title) },
  });
  let prose: string;
  if (ledger.size > 0 || answer) {
    prose = await streamAnswer({
      provider: OPENAI, system: ANSWER_SYSTEM, prompt, label: "followup",
      onToken: (chunk) => { if (toBoard) emit?.({ type: "token", text: chunk }); },
    });
  } else {
    prose = "I couldn't find grounded data for this follow-up.";
    if (toBoard) emit?.({ type: "token", text: prose });
  }
  emit?.({ type: "synthesis", phase: "end", nodeId: "followup", kind: "root" });
  timings.stream = Date.now() - t;

  log("tako", "followup findings + timings", { findings: ledger.size, ...timings });

  return {
    nodeOps,
    narration: toBoard ? prose : "",
    sideReply: toBoard ? null : prose,
    validCardIds: new Set(ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      queries: [req.message],
      answerUsed: answerEnabled && !!answer,
      cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      calls,
      notes,
      timings: { ...timings, total: 0 } as Timings,
    },
  };
}

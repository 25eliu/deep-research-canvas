import type { AgentRequest, CanvasNode, CanvasOp } from "../../schema";
import type { EmitFn, PipelineResult, Timings, TakoCallRecord, RouteAction } from "../shared/types";
import { streamAnswer } from "../../llm";
import { takoAnswer } from "../../tako";
import { FindingLedger } from "./findings";
import { feedsEdge } from "./flow";
import { FOLLOWUP_ANSWER_SYSTEM } from "./prompts";
import { ctxBlock } from "../shared/ctx";
import { retrieveNodes } from "../shared/retrieval";
import { log } from "../../log";

const OPENAI = "openai" as const;

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Board-first follow-up: answer from the retrieved (selection-first) board nodes.
// Only call Tako when the user asked for new/changed data (AUGMENT/REPLACE) or the
// board has nothing to answer from — and never when takoAnswer is disabled. On a
// side-chat / EXPLAIN turn the answer goes to sideReply and no board nodes are minted.
export async function runTakoFollowup(
  req: AgentRequest,
  action: RouteAction,
  historyText: string,
  emit?: EmitFn,
): Promise<PipelineResult> {
  const timings: Partial<Timings> = {};
  const notes: string[] = [];
  const calls: TakoCallRecord[] = [];
  const ledger = new FindingLedger();
  const nodeOps: CanvasOp[] = [];
  const allowedNodeIds = new Set<string>();
  const toBoard = req.surface !== "side_chat";
  const answerEnabled = req.takoAnswerEnabled !== false;

  const retrieved: CanvasNode[] = retrieveNodes(req.canvasState, req.selection, req.message);
  const wantsNewData = action === "AUGMENT" || action === "REPLACE";
  const boardCanAnswer = retrieved.length > 0;
  const needsTako = answerEnabled && (wantsNewData || !boardCanAnswer);

  // This lane's calls/synthesis events all key on nodeId "followup", which has no
  // research-tree entry — without a reasoning step the trace renders it as an
  // "(unnamed step)". Name it with the user's question up front.
  emit?.({ type: "reasoning", nodeId: "followup", depth: 0, question: req.message, kind: "leaf" });

  let answer = "";
  let t = Date.now();
  if (needsTako) {
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
      // New cards must be ANCHORED with a feeds edge or the tree layout leaves them
      // position-less (stacked invisibly at 0,0 on any board with a research tree).
      // Anchor = the selection-first retrieved node (the node the follow-up is
      // about), else the board's synthesis node; a tree-less board needs no anchor
      // (the structured layout places every data card).
      const anchor = retrieved[0]?.id
        ?? req.canvasState.nodes.find((n) => n.role === "synthesis")?.id;
      for (const c of res.cards) {
        const f = ledger.add(c);
        if (f && toBoard) {
          const ops: CanvasOp[] = [
            { op: "add_node", node: ledger.toNode(f) },
            // Web findings render as role:"source" nodes, which the layout places
            // on its own — only embedded chart cards need the anchor edge.
            ...(anchor && f.kind === "data_card" ? [feedsEdge(f.nodeId, anchor)] : []),
          ];
          nodeOps.push(...ops);
          allowedNodeIds.add(f.nodeId);
          emit?.({ type: "ops", ops });
        }
      }
    } catch (e: unknown) {
      notes.push(`Tako Answer unavailable (${errorMessage(e)})`);
    }
    emit?.({ type: "trace", stage: `Tako answered with ${ledger.size} findings` });
  } else {
    notes.push(`Answering from ${retrieved.length} board node(s)`);
    emit?.({ type: "trace", stage: `answering from ${retrieved.length} board node(s)` });
  }
  timings.search = Date.now() - t;

  const takoAnswerUsed = calls.length > 0;

  // Compose the answer. Board content + history come from ctxBlock; a fresh Tako
  // answer (when fetched) is appended as GROUNDED_ANSWER.
  emit?.({ type: "trace", stage: "writing answer" });
  t = Date.now();
  const prompt = `${ctxBlock(req, historyText)}\n\nGROUNDED_ANSWER: ${answer || "(none — answer from board context)"}`;

  emit?.({
    type: "synthesis", phase: "start", nodeId: "followup", kind: "root",
    inputs: { fromNodeIds: retrieved.map((n) => n.id), findingTitles: ledger.list().map((f) => f.title) },
  });

  let prose: string;
  if (retrieved.length > 0 || ledger.size > 0 || answer) {
    prose = await streamAnswer({
      provider: OPENAI, system: FOLLOWUP_ANSWER_SYSTEM, prompt, label: "followup",
      onToken: (chunk) => { if (toBoard) emit?.({ type: "token", text: chunk }); },
    });
  } else {
    prose = "I couldn't find anything on the board or in Tako to answer that.";
    if (toBoard) emit?.({ type: "token", text: prose });
  }
  emit?.({ type: "synthesis", phase: "end", nodeId: "followup", kind: "root" });
  timings.stream = Date.now() - t;

  log("tako", "followup board-first", { retrieved: retrieved.length, findings: ledger.size, takoAnswerUsed, ...timings });

  return {
    nodeOps,
    narration: toBoard ? prose : "",
    sideReply: toBoard ? null : prose,
    validCardIds: new Set(ledger.list().map((f) => f.card.cardId)),
    allowedNodeIds,
    trace: {
      queries: [req.message],
      answerUsed: takoAnswerUsed,
      cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      calls,
      // No tree on this lane — the finalized trace rebuilds from calls + reasoning,
      // and this entry keeps the "followup" step named after the turn completes.
      reasoning: [{ nodeId: "followup", question: req.message, rationale: "" }],
      notes,
      groundedIn: {
        nodes: retrieved.map((n) => ({ id: n.id, title: n.title })),
        takoAnswerUsed,
        cards: ledger.list().map((f) => ({ id: f.card.cardId, title: f.title, url: f.url || "" })),
      },
      timings: { ...timings, total: 0 } as Timings,
    },
  };
}

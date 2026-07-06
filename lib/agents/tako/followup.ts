import type { AgentRequest } from "../../schema";
import type { TraceFn, TurnTrace } from "../shared/types";
import { generateStructured } from "../../llm";
import { ctxBlock } from "../shared/ctx";
import { zAgentBody, type AgentBody } from "../shared/schemas";
import { takoAnswer } from "../../tako";
import { FOLLOWUP_SYSTEM } from "./prompts";

const OPENAI = "openai" as const;

export async function runTakoFollowup(
  req: AgentRequest,
  onTrace?: TraceFn,
): Promise<{ body: AgentBody; validCardIds: Set<string>; trace: Partial<TurnTrace> }> {
  const notes: string[] = [];
  let answer = "";
  let cards: { cardId: string; title: string; webpageUrl?: string }[] = [];
  const answerEnabled = req.takoAnswerEnabled !== false;

  if (answerEnabled) {
    onTrace?.({ stage: "asking Tako" });
    try {
      const res = await takoAnswer(req.message, { effort: "fast" });
      answer = res.answer;
      cards = res.cards.map((c) => ({ cardId: c.cardId, title: c.title, webpageUrl: c.webpageUrl }));
    } catch (e: any) {
      notes.push(`Tako Answer unavailable (${e?.message ?? e})`);
    }
    onTrace?.({ stage: `Tako answered with ${cards.length} cards` });
  } else {
    notes.push("Tako Answer disabled — mapping from existing board context");
    onTrace?.({ stage: "Tako Answer disabled — mapping from existing board context" });
  }

  const body = await generateStructured({
    provider: OPENAI, system: FOLLOWUP_SYSTEM,
    prompt: `${ctxBlock(req)}\n\nTAKO_ANSWER: ${answer || "(none)"}\n\nANSWER_CARDS: ${JSON.stringify(cards)}`,
    schema: zAgentBody,
  });

  const validCardIds = new Set(cards.map((c) => c.cardId));
  return {
    body,
    validCardIds,
    trace: {
      queries: [req.message],
      answerUsed: answerEnabled,
      cards: cards.map((c) => ({ id: c.cardId, title: c.title, url: c.webpageUrl || "" })),
      notes,
    },
  };
}

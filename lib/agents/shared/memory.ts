import type { ChatTurn } from "../../schema";
import { generateFreeText } from "../../llm";

export const HISTORY_WINDOW = 8;

export type Summarize = (turnsText: string, priorSummary?: string) => Promise<string>;

// Render turns as a compact transcript. Side-chat turns note their focused nodes.
export function renderTurns(turns: ChatTurn[]): string {
  return turns
    .map((t) => {
      const who = t.role === "user" ? "USER" : "ASSISTANT";
      const focus = t.surface === "side_chat" && t.focus?.length ? ` (focused on ${t.focus.join(", ")})` : "";
      return `${who}${focus}: ${t.text}`;
    })
    .join("\n");
}

function composeHistory(summaryText: string, windowTurns: ChatTurn[]): string {
  const parts: string[] = [];
  if (summaryText) parts.push(`SUMMARY OF EARLIER CONVERSATION:\n${summaryText}`);
  if (windowTurns.length) parts.push(`RECENT MESSAGES:\n${renderTurns(windowTurns)}`);
  return parts.join("\n\n");
}

// Split the sent turns into a verbatim window (last `window`) + older turns folded
// into the rolling summary. `summary`/`summarizedThrough` are only set when new
// turns were folded, so the caller knows whether to update its cache.
export async function foldHistory(
  input: { turns: ChatTurn[]; priorSummary?: string },
  summarize: Summarize,
  window: number = HISTORY_WINDOW,
): Promise<{ historyText: string; windowTurns: ChatTurn[]; summary?: string; summarizedThrough?: string }> {
  const turns = input.turns ?? [];
  const prior = input.priorSummary?.trim() ?? "";

  if (turns.length <= window) {
    return { historyText: composeHistory(prior, turns), windowTurns: turns };
  }

  const older = turns.slice(0, turns.length - window);
  const windowTurns = turns.slice(turns.length - window);
  const summary = await summarize(renderTurns(older), prior || undefined);
  return {
    historyText: composeHistory(summary, windowTurns),
    windowTurns,
    summary,
    summarizedThrough: older[older.length - 1].id,
  };
}

const SUMMARY_SYSTEM =
  "Summarize this conversation between a user and a data-analysis assistant into a compact factual brief " +
  "(<=120 words). Preserve entities, metrics, questions asked, and conclusions reached. No preamble, no bullet headers.";

// Production summarizer: fold new turns into any existing summary.
export const summarizeTurns: Summarize = (turnsText, priorSummary) =>
  generateFreeText({
    provider: "openai",
    system: SUMMARY_SYSTEM,
    prompt: `${priorSummary ? `Existing summary:\n${priorSummary}\n\n` : ""}New messages to fold in:\n${turnsText}`,
    label: "history-summary",
  });

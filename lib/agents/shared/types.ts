import type { ProviderId } from "../../schema";

export type RouteAction = "NEW_BOARD" | "REPLACE" | "AUGMENT" | "REFRAME" | "EXPLAIN";

export interface TurnTrace {
  action: RouteAction;
  provider: ProviderId;
  graph?: { resolved: { query: string; node: string }[]; related: { node: string; items: string[] }[] };
  queries: string[];
  answerUsed?: boolean;
  cards: { id: string; title: string; url: string }[];
  opsApplied: number;
  notes: string[];
  ms: number;
}

export type TraceFn = (step: { stage: string; note?: string; data?: unknown }) => void;

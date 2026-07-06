import { z } from "zod";
import { zCanvasOps } from "../../schema";

// The board-diff body every agent returns (before sanitize/relate/consensus).
export const zAgentBody = z.object({
  canvasOps: zCanvasOps,
  narration: z.string(),
  sideReply: z.string().nullable(),
});
export type AgentBody = z.infer<typeof zAgentBody>;

// Tako pipeline sub-steps
export const zBreakdown = z.object({
  entities: z.array(z.string()),
  metrics: z.array(z.string()),
  subtypes: z.record(z.string()).optional(),
});
export const zQueries = z.object({ queries: z.array(z.string()) });

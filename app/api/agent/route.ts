import type { AgentRequest } from "@/lib/schema";
import { runProvider } from "@/lib/providers/registry";
import type { TurnTrace } from "@/lib/agents/shared/types";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<AgentRequest>;
  if (!body.message) {
    return new Response(JSON.stringify({ type: "error", error: "message required" }), { status: 400 });
  }
  const request: AgentRequest = {
    canvasId: body.canvasId || "default",
    message: body.message,
    surface: body.surface || "main",
    canvasState: body.canvasState || { nodes: [], edges: [] },
    selection: body.selection,
    providerId: body.providerId || "tako",
    takoAnswerEnabled: body.takoAnswerEnabled ?? true,
  };

  const started = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const result = await runProvider(request, (step) =>
          send({ type: "trace", stage: step.stage, note: step.note }));
        const trace = (result.trace ?? {}) as TurnTrace;
        trace.ms = Date.now() - started;
        send({ type: "result", canvasOps: result.canvasOps, narration: result.narration, sideReply: result.sideReply, trace });
      } catch (e: any) {
        send({ type: "error", error: String(e?.message || e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

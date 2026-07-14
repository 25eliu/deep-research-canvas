import type { AgentRequest } from "@/lib/schema";
import { runProvider } from "@/lib/providers/registry";
import type { TurnTrace } from "@/lib/agents/shared/types";
import { log, logError, startTimer } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: Request) {
  const body = (await req.json()) as Partial<AgentRequest>;
  if (!body.message) {
    logError("agent", "POST /api/agent rejected — message required");
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
    graphyEnabled: body.graphyEnabled ?? false,
    history: body.history ?? [],
    historySummary: body.historySummary,
  };

  const turn = startTimer("agent", `turn ${request.providerId}`, {
    canvasId: request.canvasId,
    surface: request.surface,
    provider: request.providerId,
    nodes: request.canvasState.nodes.length,
    takoAnswer: request.takoAnswerEnabled,
    graphy: request.graphyEnabled,
    message: request.message,
  });

  const started = Date.now();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        // Relay every pipeline event: trace labels, incremental canvas ops (graphs
        // stream in), and answer tokens (prose streams after).
        const result = await runProvider(request, (evt) => {
          if (evt.type === "trace") log("agent", `· ${evt.stage}`, { note: evt.note });
          send(evt);
        });
        const trace = (result.trace ?? {}) as TurnTrace;
        trace.ms = Date.now() - started;
        if (trace.timings) trace.timings.total = trace.ms;
        turn.done(`turn ${request.providerId}`, {
          action: (trace as any).action,
          ops: result.canvasOps?.length ?? 0,
          cards: (trace as any).cards?.length ?? 0,
          total: trace.ms,
        });
        send({ type: "result", canvasOps: result.canvasOps, narration: result.narration, sideReply: result.sideReply, memory: result.memory, trace });
      } catch (e: any) {
        turn.fail(`turn ${request.providerId} failed`, { error: String(e?.message || e) });
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

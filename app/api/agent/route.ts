import { NextRequest, NextResponse } from "next/server";
import { runProvider } from "@/lib/providers";
import type { AgentRequest } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as AgentRequest;
    if (!body?.message) return NextResponse.json({ error: "message required" }, { status: 400 });
    const result = await runProvider({
      canvasId: body.canvasId || "default",
      message: body.message,
      surface: body.surface || "main",
      canvasState: body.canvasState || { nodes: [], edges: [] },
      selection: body.selection,
      providerId: body.providerId || "gpt_tako",
      takoAnswerEnabled: body.takoAnswerEnabled ?? false,
    });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}

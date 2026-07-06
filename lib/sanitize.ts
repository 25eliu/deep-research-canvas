import type { CanvasOp } from "./schema";

// Reconciles model output against reality: baselines never carry a Tako ref;
// grounded providers may only reference cardIds actually fetched this turn.
export function sanitizeOps(
  ops: unknown,
  opt: { allowTako: boolean; validCardIds?: Set<string> },
): CanvasOp[] {
  if (!Array.isArray(ops)) return [];
  const out: CanvasOp[] = [];
  for (const op of ops) {
    if (!op || typeof (op as any).op !== "string") continue;
    if (((op as any).op === "add_node" || (op as any).op === "upsert_node") && (op as any).node) {
      const n = (op as any).node;
      if (n.position == null) n.position = null;
      if (n.type === "data_card") {
        if (!opt.allowTako) {
          delete n.tako;
          n.grounding = "model";
        } else if (n.tako && opt.validCardIds && !opt.validCardIds.has(n.tako.cardId)) {
          delete n.tako;
          n.grounding = "model";
          n.confidence = Math.min(typeof n.confidence === "number" ? n.confidence : 0.4, 0.4);
        }
      }
      if (typeof n.confidence !== "number") n.confidence = opt.allowTako && n.tako ? 0.9 : 0.5;
    }
    out.push(op as CanvasOp);
  }
  return out;
}

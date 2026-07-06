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
      const origNode = (op as any).node;
      let newNode = { ...origNode };

      // Normalize position
      if (newNode.position == null) newNode.position = null;

      if (newNode.type === "data_card") {
        if (!opt.allowTako) {
          // Remove tako and set grounding to model
          const { tako, ...nodeWithoutTako } = newNode;
          newNode = { ...nodeWithoutTako, grounding: "model" };
        } else if (newNode.tako && opt.validCardIds && !opt.validCardIds.has(newNode.tako.cardId)) {
          // Remove invalid tako, set grounding to model, cap confidence
          const { tako, ...nodeWithoutTako } = newNode;
          newNode = {
            ...nodeWithoutTako,
            grounding: "model",
            confidence: Math.min(typeof newNode.confidence === "number" ? newNode.confidence : 0.4, 0.4),
          };
        }
      }

      // Backfill confidence if not numeric
      if (typeof newNode.confidence !== "number") {
        newNode = {
          ...newNode,
          confidence: opt.allowTako && newNode.tako ? 0.9 : 0.5,
        };
      }

      // Push modified op with new node
      out.push({ ...op, node: newNode } as CanvasOp);
    } else if ((op as any).op === "update_node" && (op as any).patch) {
      const origPatch = (op as any).patch;
      let newPatch = { ...origPatch };

      if (!opt.allowTako) {
        // Remove tako and downgrade grounding if the patch touches either
        if (newPatch.tako !== undefined) {
          const { tako, ...patchWithoutTako } = newPatch;
          newPatch = patchWithoutTako;
        }
        if (newPatch.grounding === "tako") {
          newPatch = { ...newPatch, grounding: "model" };
        }
      } else if (
        newPatch.tako?.cardId &&
        opt.validCardIds &&
        !opt.validCardIds.has(newPatch.tako.cardId)
      ) {
        // Remove invalid tako, downgrade grounding, cap confidence
        const { tako, ...patchWithoutTako } = newPatch;
        newPatch = patchWithoutTako;
        if (newPatch.grounding === "tako") {
          newPatch = { ...newPatch, grounding: "model" };
        }
        if (typeof newPatch.confidence === "number") {
          newPatch = { ...newPatch, confidence: Math.min(newPatch.confidence, 0.4) };
        }
      }

      out.push({ ...op, patch: newPatch } as CanvasOp);
    } else {
      // Non-node ops pass through unchanged
      out.push(op as CanvasOp);
    }
  }
  return out;
}

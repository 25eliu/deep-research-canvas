import type { CanvasOp, NodeSource } from "./schema";

// Reconciles model output against reality so the canvas can NEVER present
// fabricated provenance:
//  - Baselines (gpt/claude) never carry a Tako ref.
//  - A baseline data_card/metric may only claim grounding "web" if it cites at
//    least one source URL we ACTUALLY retrieved this turn (`validSourceUrls`).
//    Any model-invented URL is dropped; a card left with no verifiable source is
//    relabelled "model" (an honest, unattributed guess) — it is never shown as
//    sourced. This mirrors the Tako path, which only trusts cardIds it fetched.
export function sanitizeOps(
  ops: unknown,
  opt: { allowTako: boolean; validCardIds?: Set<string>; validSourceUrls?: Set<string> },
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

      if (!opt.allowTako) {
        // Baselines never carry a Tako ref.
        if (newNode.tako !== undefined) {
          const { tako, ...rest } = newNode;
          newNode = rest;
        }
        if (newNode.type === "data_card" || newNode.type === "metric") {
          // Enforce real attribution on data-bearing cards.
          const valid = filterSources(newNode.sources, opt.validSourceUrls);
          if (newNode.grounding === "web" && valid.length > 0) {
            newNode = { ...newNode, grounding: "web", sources: valid };
          } else {
            newNode = dropSources({ ...newNode, grounding: "model" });
          }
        } else {
          // Structural nodes (entity/criteria/consensus/text) don't carry citations.
          newNode = dropSources(newNode);
        }
      } else if (newNode.type === "data_card" && newNode.tako && opt.validCardIds && !opt.validCardIds.has(newNode.tako.cardId)) {
        // Remove invalid tako, set grounding to model, cap confidence
        const { tako, ...nodeWithoutTako } = newNode;
        newNode = {
          ...nodeWithoutTako,
          grounding: "model",
          confidence: Math.min(typeof newNode.confidence === "number" ? newNode.confidence : 0.4, 0.4),
        };
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
        // A patch may only assert web sources it can actually back with retrieved URLs.
        if (newPatch.sources !== undefined || newPatch.grounding === "web") {
          const valid = filterSources(newPatch.sources, opt.validSourceUrls);
          if (valid.length > 0) {
            newPatch = { ...newPatch, sources: valid };
          } else {
            newPatch = dropSources(newPatch);
            if (newPatch.grounding === "web") newPatch = { ...newPatch, grounding: "model" };
          }
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

// Keep only citations whose URL was actually retrieved this turn (drops any
// model-invented URL). Returns a clean NodeSource[] with normalized shape.
function filterSources(sources: unknown, valid?: Set<string>): NodeSource[] {
  if (!Array.isArray(sources) || !valid) return [];
  const out: NodeSource[] = [];
  const seen = new Set<string>();
  for (const s of sources) {
    const url = (s as any)?.url;
    if (typeof url !== "string" || !valid.has(url) || seen.has(url)) continue;
    seen.add(url);
    const title = (s as any)?.title;
    out.push(typeof title === "string" ? { url, title } : { url });
  }
  return out;
}

function dropSources<T extends Record<string, any>>(node: T): T {
  if (!("sources" in node)) return node;
  const { sources, ...rest } = node as any;
  return rest;
}

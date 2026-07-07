import { z } from "zod";

export const zRouteAction = z.enum(["NEW_BOARD", "REPLACE", "AUGMENT", "REFRAME", "EXPLAIN"]);
export const zRoute = z.object({ action: zRouteAction, reason: z.string() });

export const ROUTER = `Route each message to ONE action, then emit a canvas diff:
NEW_BOARD (fresh investigation), REPLACE (swap existing data — rewire edges, leave untouched nodes+positions),
AUGMENT (add data and connect it), REFRAME (change criteria/ranking only, no new data), EXPLAIN (answer; mutate little).
If a selection is present, prefer EXPLAIN about it or AUGMENT scoped to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.
Use CONVERSATION SO FAR to resolve references ("it", "that", "them", "tell me more") to the entity/nodes
already discussed — a reference to prior context is usually EXPLAIN or AUGMENT, not NEW_BOARD.`;

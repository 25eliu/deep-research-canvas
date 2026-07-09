import { z } from "zod";

export const zRouteAction = z.enum(["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN"]);
export const zRoute = z.object({ action: zRouteAction, reason: z.string() });

export const ROUTER = `Route each message to ONE action:
REPLACE — a fresh or different investigation ("actually, let's look at European banks instead"); the research pipeline rebuilds the board.
AUGMENT — add supporting data about something already on the board and connect it ("pull in Intel's numbers too").
GENERATE — the user explicitly asks for a NEW component/chart/card/breakdown on the board ("add a chart of AMD's data-center revenue", "break down X into a card", "create a comparison of...").
EXPLAIN — answer a question from what's known; the board does not change ("why did Nvidia's revenue jump in 2024?").
If a selection is present, prefer EXPLAIN about it, or AUGMENT/GENERATE scoped to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.
Use CONVERSATION SO FAR to resolve references ("it", "that", "them", "tell me more") to the entity/nodes
already discussed — a reference to prior context is usually EXPLAIN or AUGMENT, not REPLACE.
AUGMENT vs GENERATE: both add to the board; GENERATE is an explicit "make/add/create a component" request,
AUGMENT is "bring in more data". When in doubt between EXPLAIN and AUGMENT, prefer EXPLAIN.`;

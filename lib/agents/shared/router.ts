import { z } from "zod";

export const zRouteAction = z.enum(["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN", "RESEARCH"]);
export const zRoute = z.object({ action: zRouteAction, reason: z.string() });

export const ROUTER = `Route each message to ONE action:
EXPLAIN — the DEFAULT for a question. Answer from what's known plus a grounded Tako answer; the board does NOT change. Use this for any single-part / data / "why did X happen", "how much is Y", "what is Z" question, EVEN about a subject not yet on the board. When in doubt between EXPLAIN and anything else, choose EXPLAIN.
RESEARCH — the user EXPLICITLY wants more research put ON THE CANVAS: verbs like "research", "dig into", "explore", "investigate", "expand on", "build out", "map out", "go deeper on", or a clear ask for a multi-facet investigation of something not already covered. Builds a NEW research tree next to the existing ones; it does NOT clear the board.
AUGMENT — add a single piece of supporting data about something already on the board and connect it ("pull in Intel's numbers too").
GENERATE — the user explicitly asks for ONE new component/chart/card/breakdown ("add a chart of AMD's data-center revenue", "break down X into a card").
REPLACE — ONLY an explicit restart: "start over", "clear the board", "scrap this and look at Y instead". An ambiguous new-topic question is NEVER replace — it is EXPLAIN (a question) or RESEARCH (an explicit research request).
If a selection is present, prefer EXPLAIN about it, or scope AUGMENT/GENERATE/RESEARCH to it.
If surface is "side_chat", put the answer in sideReply and keep narration short.
Use CONVERSATION SO FAR to resolve references ("it", "that", "them", "tell me more") to the entity/nodes already discussed — a reference to prior context is usually EXPLAIN, RESEARCH, or AUGMENT, not REPLACE.
RESEARCH vs EXPLAIN: EXPLAIN answers; RESEARCH puts new nodes on the canvas. Only choose RESEARCH when the user's wording asks to research/expand/explore, not merely to know something.
AUGMENT vs GENERATE: both add to the board; GENERATE is an explicit "make/add/create a component" request, AUGMENT is "bring in more data".`;

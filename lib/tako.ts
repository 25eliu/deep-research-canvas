// Live Tako REST client (v3 search + v1 answer + graph via agents/tako/graph.ts).
// IMPORTANT: host must be staging.tako.com — staging.trytako.com is Cloudflare-blocked (403).
import type { TakoRef } from "./schema";
import { startTimer, logError, preview, log } from "./log";

const HOST = process.env.TAKO_HOST || "https://staging.tako.com";
const BASE = `${HOST}/api`;
const TIMEOUT_MS = 25_000;

export interface TakoCard extends TakoRef {
  title: string;
  description?: string;
  relevance?: string; // Tako's per-card relevance rating: "Low" | "Medium" | "High"
  content?: string; // full page text (web_results only) — transient synthesis input, not node provenance
}

// Coerce an untrusted external field to a string (or undefined). Tako occasionally
// returns a non-string for text fields (e.g. a structured object); passing that
// downstream makes `.slice`/`.match` throw and kills the whole turn. Normalize here,
// at the boundary, so every consumer can safely treat these as strings.
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function mapCard(c: any): TakoCard {
  const id = c.card_id || c.cardId || c.pub_id;
  const description = asStr(c.description);
  return {
    cardId: id,
    title: asStr(c.title) || "Untitled",
    description,
    embedUrl: c.embed_url,
    imageUrl: c.image_url,
    webpageUrl: c.webpage_url,
    source: c.sources?.[0]?.source_name || c.source,
    asOf: extractAsOf(description),
    relevance: c.relevance,
  };
}

// Map a v3 `web_results[]` entry (a SEPARATE array from structured `cards[]`) into a
// web-kind TakoCard. It has no embedUrl, so classifyKind() renders it as a clickable
// "source" node rather than a chart. The url doubles as a stable cardId so it survives
// the cardId filter and dedup, and carries provenance for the synthesis.
export function mapWebResult(w: any): TakoCard {
  const url = w.url || w.webpage_url;
  const content = asStr(w.content); // full page text Tako fetched — the agent reads this in synthesis
  return {
    cardId: url || w.title,
    title: asStr(w.title) || asStr(w.source_name) || "Web source",
    description: asStr(w.snippet) || content,
    content, // always a string | undefined — safe for downstream .slice()
    webpageUrl: url,
    source: w.source_name || w.source,
    asOf: w.publish_date,
  };
}

// Keep only cards rated Medium or above. Only an EXPLICIT sub-Medium rating is
// dropped; a missing/unknown relevance is kept (don't over-filter cards Tako
// didn't score). Tako's ratings are "Low"/"Medium"/"High".
const LOW_RELEVANCE = new Set(["low", "very low", "none", "poor"]);
export function relevanceKeeps(rel?: string): boolean {
  if (!rel) return true;
  return !LOW_RELEVANCE.has(rel.trim().toLowerCase());
}

// Map + keep only cardId-bearing, Medium+ cards; log how many low-relevance were dropped.
function keepCards(raw: any[], query: string): TakoCard[] {
  const mapped = raw.map(mapCard).filter((c) => !!c.cardId);
  const kept = mapped.filter((c) => relevanceKeeps(c.relevance));
  const dropped = mapped.length - kept.length;
  if (dropped > 0) log("tako", "dropped low-relevance cards", { dropped, query });
  return kept;
}

function extractAsOf(desc?: string): string | undefined {
  if (!desc) return undefined;
  const m = desc.match(/last updated on ([A-Za-z]+ \d{1,2},? \d{4})/i);
  return m ? m[1] : undefined;
}

async function post(path: string, body: unknown): Promise<any> {
  const key = process.env.TAKO_API_KEY;
  if (!key) {
    logError("tako", `POST ${path} aborted — TAKO_API_KEY not set`);
    throw new Error("TAKO_API_KEY not set");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const timer = startTimer("tako", `POST ${path}`, { body: preview(body) });
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      timer.fail(`POST ${path} ${res.status}`, { body: text });
      throw new Error(`Tako ${res.status} on ${path}: ${text}`);
    }
    const json = await res.json();
    timer.done(`POST ${path} ${res.status}`, { cards: json?.cards?.length ?? 0 });
    return json;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      timer.fail(`POST ${path} timed out after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// Per-call trace metadata handed to an optional `onCall` observer. Purely
// additive — the return values are unchanged, so existing callers (and the
// array-returning test mocks) are unaffected. The caller owns trace-type shaping,
// keeping this module free of agent/trace types.
export interface TakoCallMeta {
  query: string;
  endpoint: "/v3/search" | "/v1/answer";
  effort: "fast" | "instant";
  web: boolean;
  ms: number;
  cards: TakoCard[];
  error?: string;
}

export async function takoSearch(
  text: string,
  opts: {
    count?: number;
    effort?: "fast" | "instant";
    web?: boolean;
    onCall?: (m: TakoCallMeta) => void;
  } = {},
): Promise<TakoCard[]> {
  const count = opts.count ?? 5;
  const effort = opts.effort || "fast";
  const web = !!opts.web;
  // sources.data = structured Tako cards; sources.web = web-grounded results.
  // (web source shape verified against staging.tako.com during impl.)
  const sources: Record<string, unknown> = { data: { count } };
  if (web) sources.web = { count };
  const t0 = Date.now();
  try {
    const data = await post("/v3/search", { query: text, effort, sources });
    const cards = keepCards(data?.cards || [], text);
    // Web-grounded results come back in a SEPARATE `web_results[]` array (NOT `cards[]`).
    // When web was requested, fold them in as web-kind cards so the agent can node them
    // as sources and cite them in the synthesis.
    const webCards = web
      ? (data?.web_results || []).map(mapWebResult).filter((c: TakoCard) => !!c.cardId)
      : [];
    const all = [...cards, ...webCards];
    opts.onCall?.({ query: text, endpoint: "/v3/search", effort, web, ms: Date.now() - t0, cards: all });
    return all;
  } catch (e: unknown) {
    opts.onCall?.({
      query: text, endpoint: "/v3/search", effort, web, ms: Date.now() - t0, cards: [],
      error: e instanceof Error ? e.message : String(e),
    });
    throw e; // preserve the existing throw contract — callers already try/catch
  }
}

// The underlying data behind a result URL, via POST /api/v1/contents (the "tako contents"
// API). A Tako card `webpageUrl` yields a CSV of the card's actual series (`csv`); any other
// URL yields the page's extracted full text (`text`). `inline` mode caps CSV at 1000 rows.
export interface TakoContents {
  csv?: string; // the card's data as CSV (Timestamp,label\n… rows)
  text?: string; // a web page's extracted full text
  totalRows?: number;
  truncated?: boolean;
}

export async function takoContents(
  url: string,
  opts: { mode?: "inline" | "url" } = {},
): Promise<TakoContents> {
  const data = await post("/v1/contents", { url, mode: opts.mode || "inline" });
  const c = (data?.contents || [])[0] || {};
  const out: TakoContents = { totalRows: c.total_rows ?? undefined, truncated: !!c.truncated };
  if (c.format === "csv") out.csv = asStr(c.data);
  else out.text = asStr(c.data);
  return out;
}

const ANSWER_WEB_COUNT = 8; // web articles requested when grounding a plan from current sources

export async function takoAnswer(
  query: string,
  opts: { effort?: "fast" | "instant"; web?: boolean; onCall?: (m: TakoCallMeta) => void } = {},
): Promise<{ answer: string; cards: TakoCard[] }> {
  const effort = opts.effort || "fast";
  const web = !!opts.web;
  // Grounding wants CURRENT ARTICLES, not the structured-data default. /v1/answer with
  // sources.web returns web_results[] (recent web sources) and writes the answer FROM
  // them; without it the answer over-weights whatever entity happens to hold a Tako card
  // (e.g. an obscure company with a stock page), which is poor grounding for discovering a
  // cohort's real members. Verified on staging: web-only surfaced the actual sector
  // leaders where the default surfaced a near-random card-backed name.
  const body: Record<string, unknown> = web
    ? { query, effort, sources: { web: { count: ANSWER_WEB_COUNT } } }
    : { query, effort };
  const t0 = Date.now();
  try {
    const data = await post("/v1/answer", body);
    // A web-grounded answer returns its sources in web_results[] (like /v3/search), NOT
    // cards[]; fold them into the returned cards so CARD_TITLES carries the article titles.
    const structured = keepCards(data?.cards || [], query);
    const webCards = web
      ? (data?.web_results || []).map(mapWebResult).filter((c: TakoCard) => !!c.cardId)
      : [];
    const cards = [...structured, ...webCards];
    opts.onCall?.({ query, endpoint: "/v1/answer", effort, web, ms: Date.now() - t0, cards });
    return { answer: typeof data?.answer === "string" ? data.answer : "", cards };
  } catch (e: unknown) {
    opts.onCall?.({
      query, endpoint: "/v1/answer", effort, web, ms: Date.now() - t0, cards: [],
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

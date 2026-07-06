// Live Tako REST client (v3 search + v1 answer + graph via agents/tako/graph.ts).
// IMPORTANT: host must be staging.tako.com — staging.trytako.com is Cloudflare-blocked (403).
import type { TakoRef } from "./schema";

const HOST = process.env.TAKO_HOST || "https://staging.tako.com";
const BASE = `${HOST}/api`;
const TIMEOUT_MS = 25_000;

export interface TakoCard extends TakoRef {
  title: string;
  description?: string;
}

export function mapCard(c: any): TakoCard {
  const id = c.card_id || c.cardId || c.pub_id;
  return {
    cardId: id,
    title: c.title || "Untitled",
    description: c.description,
    embedUrl: c.embed_url,
    imageUrl: c.image_url,
    webpageUrl: c.webpage_url,
    source: c.sources?.[0]?.source_name || c.source,
    asOf: extractAsOf(c.description),
  };
}

function extractAsOf(desc?: string): string | undefined {
  if (!desc) return undefined;
  const m = desc.match(/last updated on ([A-Za-z]+ \d{1,2},? \d{4})/i);
  return m ? m[1] : undefined;
}

async function post(path: string, body: unknown): Promise<any> {
  const key = process.env.TAKO_API_KEY;
  if (!key) throw new Error("TAKO_API_KEY not set");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Tako ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

let loggedShapeOnce = false;

export async function takoSearch(
  text: string,
  opts: { count?: number; effort?: "fast" | "instant" } = {},
): Promise<TakoCard[]> {
  const data = await post("/v3/search", {
    query: text,
    effort: opts.effort || "fast",
    sources: { data: { count: opts.count ?? 5 } },
  });
  const cards = data?.cards || [];
  if (!loggedShapeOnce && cards[0]) {
    console.log("[tako] v3 card keys:", Object.keys(cards[0]));
    loggedShapeOnce = true;
  }
  return cards.map(mapCard).filter((c: TakoCard) => !!c.cardId);
}

export async function takoAnswer(
  query: string,
  opts: { effort?: "fast" | "instant" } = {},
): Promise<{ answer: string; cards: TakoCard[] }> {
  const data = await post("/v1/answer", { query, effort: opts.effort || "fast" });
  const cards = (data?.cards || []).map(mapCard).filter((c: TakoCard) => !!c.cardId);
  return { answer: typeof data?.answer === "string" ? data.answer : "", cards };
}

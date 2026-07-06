// Live Tako REST client. Endpoint + auth confirmed from docs.trytako.com:
//   POST /api/v1/knowledge_search  with header X-API-Key.
// Pointed at the Tako staging environment (public API/SDK base URL).
import type { TakoRef } from "./schema";

const HOST = process.env.TAKO_HOST || "https://staging.trytako.com";
const BASE = process.env.TAKO_BASE_URL || `${HOST}/api/v1`;

export interface TakoCard extends TakoRef {
  title: string;
  description?: string;
}

function mapCard(c: any): TakoCard {
  const id = c.card_id || c.cardId || c.pub_id;
  // URLs are returned by the API, but can also be derived from the card id.
  return {
    cardId: id,
    title: c.title || "Untitled",
    description: c.description,
    embedUrl: c.embed_url || (id ? `${HOST}/embed/${id}/?dark_mode=auto` : undefined),
    imageUrl: c.image_url || (id ? `${HOST}/api/v1/image/${id}/` : undefined),
    webpageUrl: c.webpage_url || (id ? `${HOST}/card/${id}/` : undefined),
    source: c.sources?.[0]?.source_name || c.source,
    asOf: extractAsOf(c.description),
  };
}

function extractAsOf(desc?: string): string | undefined {
  if (!desc) return undefined;
  const m = desc.match(/last updated on ([A-Za-z]+ \d{1,2},? \d{4})/i);
  return m ? m[1] : undefined;
}

export async function takoSearch(
  text: string,
  opts: { count?: number; effort?: "fast" | "instant"; sources?: string[] } = {}
): Promise<TakoCard[]> {
  const key = process.env.TAKO_API_KEY;
  if (!key) throw new Error("TAKO_API_KEY not set");
  const res = await fetch(`${BASE}/knowledge_search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": key },
    body: JSON.stringify({
      inputs: { text },
      source_indexes: opts.sources || ["tako", "web"],
      search_effort: opts.effort || "fast",
      output_settings: { knowledge_card_settings: { image_dark_mode: true } },
      country_code: "US",
      locale: "en-US",
    }),
  });
  if (!res.ok) throw new Error(`Tako ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const cards = data?.outputs?.knowledge_cards || data?.cards || [];
  return cards.map(mapCard).filter((c: TakoCard) => !!c.cardId);
}

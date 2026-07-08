// Tako graph discovery client. Base must be staging.tako.com (trytako.com is CF-blocked).
import { startTimer, logError } from "../../log";

const HOST = process.env.TAKO_HOST || "https://staging.tako.com";
const BASE = `${HOST}/api/beta/graph`;
const TIMEOUT_MS = 15_000;

export interface GraphNode { id: string; name: string; type: string; subtype?: string; aliases?: string[]; description?: string; }
export interface GraphItem { id: string; name: string; aliases?: string[]; description?: string; }

async function get(path: string): Promise<any> {
  const key = process.env.TAKO_API_KEY;
  if (!key) {
    logError("tako-graph", `GET ${path} aborted — TAKO_API_KEY not set`);
    throw new Error("TAKO_API_KEY not set");
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const timer = startTimer("tako-graph", `GET ${path}`);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { "X-API-Key": key }, signal: ctrl.signal });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 160);
      timer.fail(`GET ${path} ${res.status}`, { body: text });
      throw new Error(`Tako graph ${res.status} on ${path}: ${text}`);
    }
    const json = await res.json();
    const count = json?.results?.length ?? json?.relation?.items?.length ?? 0;
    timer.done(`GET ${path} ${res.status}`, { count });
    return json;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      timer.fail(`GET ${path} timed out after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export async function graphSearch(
  q: string,
  opts: { types: "entity" | "metric"; subtype?: string; limit?: number },
): Promise<GraphNode[]> {
  const p = new URLSearchParams({ q, types: opts.types, limit: String(opts.limit ?? 5) });
  if (opts.subtype && opts.types === "entity") p.set("subtype", opts.subtype);
  const data = await get(`/search?${p.toString()}`);
  return Array.isArray(data?.results) ? data.results : [];
}

export async function graphRelated(
  nodeId: string,
  opts: { relationType: "entity" | "metric"; q?: string; limit?: number },
): Promise<GraphItem[]> {
  const p = new URLSearchParams({
    node_id: nodeId, relation_type: opts.relationType, limit: String(opts.limit ?? 6),
  });
  // `q` relevance-filters the related items against their NAMES. Only append it when
  // non-empty: a metric fetch with no `q` returns the entity's full (bounded) menu, which
  // is what we want as a fallback. (Entity relations should still pass `q` — unfiltered
  // they return tens of thousands — but that's the caller's choice.)
  const q = opts.q?.trim();
  if (q) p.set("q", q);
  const data = await get(`/related?${p.toString()}`);
  return Array.isArray(data?.relation?.items) ? data.relation.items : [];
}

// Tako graph discovery client. Base must be staging.tako.com (trytako.com is CF-blocked).
const HOST = process.env.TAKO_HOST || "https://staging.tako.com";
const BASE = `${HOST}/api/beta/graph`;
const TIMEOUT_MS = 15_000;

export interface GraphNode { id: string; name: string; type: string; subtype?: string; aliases?: string[]; description?: string; }
export interface GraphItem { id: string; name: string; aliases?: string[]; description?: string; }

async function get(path: string): Promise<any> {
  const key = process.env.TAKO_API_KEY;
  if (!key) throw new Error("TAKO_API_KEY not set");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { headers: { "X-API-Key": key }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Tako graph ${res.status} on ${path}: ${(await res.text()).slice(0, 160)}`);
    return await res.json();
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
  opts: { relationType: "entity" | "metric"; q: string; limit?: number },
): Promise<GraphItem[]> {
  const p = new URLSearchParams({
    node_id: nodeId, relation_type: opts.relationType, q: opts.q, limit: String(opts.limit ?? 6),
  });
  const data = await get(`/related?${p.toString()}`);
  return Array.isArray(data?.relation?.items) ? data.relation.items : [];
}

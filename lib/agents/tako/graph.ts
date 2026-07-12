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
    const count = json?.results?.length ?? json?.relation?.items?.length ?? json?.relations?.length ?? 0;
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

// One relation group from the /related OVERVIEW form (no relation param): a stable
// key (fixed like "metrics"/"siblings" or a named edge like "rel:competes_with"),
// a kind (related|membership|data|sibling|source), a server label, exact total
// (capped at 1000 → totalCapped), and ~10 inline items (full nodes).
export interface GraphRelation {
  key: string; kind: string; label: string;
  total: number; totalCapped: boolean; items: GraphItem[];
}

function parseRelation(r: any): GraphRelation {
  return {
    key: String(r?.key ?? ""), kind: String(r?.kind ?? ""), label: String(r?.label ?? ""),
    total: Number(r?.total ?? 0), totalCapped: Boolean(r?.total_capped),
    items: Array.isArray(r?.items) ? r.items : [],
  };
}

// Overview form: every non-empty relation group on a node, in server order.
export async function graphOverview(nodeId: string): Promise<{ node: GraphNode; relations: GraphRelation[] }> {
  const p = new URLSearchParams({ node_id: nodeId });
  const data = await get(`/related?${p.toString()}`);
  return {
    node: data?.node ?? { id: nodeId, name: "", type: "entity" },
    relations: Array.isArray(data?.relations) ? data.relations.map(parseRelation) : [],
  };
}

export async function graphRelated(
  nodeId: string,
  // `relation` is the group key: fixed ("metrics", "entities", "siblings") or a
  // named-edge key from an overview ("rel:has_team"). Replaces the deprecated
  // relation_type param (#27511).
  opts: { relation: string; q?: string; limit?: number },
): Promise<GraphItem[]> {
  const p = new URLSearchParams({
    node_id: nodeId, relation: opts.relation, limit: String(opts.limit ?? 6),
  });
  // `q` relevance-filters the related items against their NAMES. Only append it when
  // non-empty: a metrics fetch with no `q` returns the group's (bounded) menu, which
  // is what we want as a fallback.
  const q = opts.q?.trim();
  if (q) p.set("q", q);
  const data = await get(`/related?${p.toString()}`);
  return Array.isArray(data?.relation?.items) ? data.relation.items : [];
}

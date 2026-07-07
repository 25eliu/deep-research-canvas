import { tokenize, jaccard } from "../../text";

// Drop near-duplicate search queries so we don't fetch the same data twice.
// Keep-first: walk in order, keep a query only if its max token-set Jaccard vs
// every already-kept query is below `threshold`. Then cap to `max` distinct queries.
export function diversifyQueries(
  queries: string[],
  opts: { threshold?: number; max?: number } = {},
): string[] {
  const threshold = opts.threshold ?? 0.8;
  const max = opts.max ?? 10;
  const kept: string[] = [];
  const keptTokens: Set<string>[] = [];
  for (const q of queries) {
    const tokens = tokenize(q);
    const dup = keptTokens.some((k) => jaccard(tokens, k) >= threshold);
    if (dup) continue;
    kept.push(q);
    keptTokens.push(tokens);
    if (kept.length >= max) break;
  }
  return kept;
}

// Small, dependency-free text utilities for normalization, token-set similarity,
// and title signatures. Used for query diversification and finding dedup.
// Mirrors the slug/normalize shape already used by `sectionId` in the tako pipeline.

// Grammatical stopwords ONLY. Never include domain nouns (e.g. data, center,
// revenue) — stripping those would wrongly merge distinct queries/titles.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "vs", "versus", "compare",
  "comparison", "between", "in", "on", "to", "by", "what", "is", "are",
  "how", "much", "many", "latest", "current",
]);

// lowercase → strip punctuation → drop stopwords → collapse whitespace (tokens in order).
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(" ");
}

export function tokenize(s: string): Set<string> {
  return new Set(normalizeText(s).split(" ").filter(Boolean));
}

// |A ∩ B| / |A ∪ B|. Two empty sets are treated as dissimilar (0), so an
// all-stopword query is kept rather than merged.
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Normalized, order-preserving signature of a title. Equal for reworded-identical
// titles; differs when the meaningful tokens differ (e.g. distinct entities).
export function titleSignature(title: string): string {
  return normalizeText(title);
}

// Tako graph NER labels — the legal values for the `label` param on graph/search
// AND graph/related. `label` is a RANKING BOOST, not a filter: matching nodes rank
// higher (within each relation, for /related) but nothing is excluded, and totals
// are unchanged. Supplying `label` disables the API's own label inference. An
// out-of-enum value is a 400 (`Invalid label: '…'`). Single source of truth:
// schemas.ts builds the z.enum from this array and prompts.ts interpolates
// GRAPH_LABELS_LINE, so the schema guarantee and the prompt teaching can never
// drift apart. Values verbatim from the API docs.
export const GRAPH_LABELS = [
  "PERSON",
  "ORG",
  "GPE",
  "LOC",
  "PRODUCT",
  "EVENT",
  "LANGUAGE",
  "MONEY",
  "METRIC",
  "STOCK_TICKER",
  "WEBSITE",
] as const;

export type GraphLabel = (typeof GRAPH_LABELS)[number];

// Comma-joined list for prompt interpolation — the decompose model must SEE the
// legal values to pick correctly first try; the z.enum only retries.
export const GRAPH_LABELS_LINE = GRAPH_LABELS.join(", ");

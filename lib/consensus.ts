import type { CanvasState, CanvasOp, ConsensusRow } from "./schema";

const num = (s: string): number => {
  const m = String(s).replace(/[^0-9.\-]/g, "");
  const v = parseFloat(m);
  return Number.isFinite(v) ? v : 0;
};

export function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 1);
  return values.map((v) => (v - min) / (max - min));
}

export function computeConsensusRows(state: CanvasState, _target: string): ConsensusRow[] {
  const criteria = state.nodes.find((n) => n.type === "criteria");
  const weights = criteria?.criteria?.weights ?? {};
  const weightKeys = Object.keys(weights);

  // entities = sections that have an entity_section header
  const entities = state.nodes
    .filter((n) => n.type === "entity_section" && n.section)
    .map((n) => n.section as string);
  const uniqueEntities = Array.from(new Set(entities)).sort();

  // metric value per entity per criterion (case-insensitive label match)
  const metricValue = (entity: string, key: string): number => {
    const m = state.nodes.find(
      (n) => n.type === "metric" && n.section === entity &&
        (n.metric?.label ?? "").toLowerCase() === key.toLowerCase(),
    );
    return m?.metric ? num(m.metric.value) : 0;
  };

  // normalize each criterion across entities, then weight+sum
  const perKeyNorm: Record<string, number[]> = {};
  for (const key of weightKeys) {
    perKeyNorm[key] = normalize(uniqueEntities.map((e) => metricValue(e, key)));
  }

  const scored = uniqueEntities.map((entity, i) => {
    let score = 0;
    for (const key of weightKeys) score += (weights[key] ?? 0) * (perKeyNorm[key][i] ?? 0);
    return { entity, score };
  });

  // deterministic: sort by score desc, tie-break by entity name asc
  scored.sort((a, b) => (b.score - a.score) || a.entity.localeCompare(b.entity));

  return scored.map((s, i) => ({
    rank: i + 1,
    entity: s.entity,
    score: Math.round(s.score * 1000) / 1000,
  }));
}

export function recomputeConsensus(state: CanvasState, target: string): CanvasOp[] {
  const rows = computeConsensusRows(state, target);
  return [{ op: "update_node", id: target, patch: { consensusRows: rows } }];
}

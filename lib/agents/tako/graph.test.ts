import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Live-verified fixture shape (staging.tako.com, 2026-07-12, NVIDIA node).
const OVERVIEW_JSON = {
  node: { id: "ent::nvidia::1", name: "NVIDIA Corporation", type: "entity" },
  relations: [
    { key: "rel:competes_with", kind: "related", label: "Competes with", total: 181, total_capped: false,
      items: [{ id: "ent::amzn::2", name: "Amazon.com, Inc.", type: "entity", aliases: ["AMZN"] }] },
    { key: "siblings", kind: "sibling", label: "Other Companies", total: 1000, total_capped: true, items: [] },
  ],
};
const DRILL_JSON = {
  node: { id: "ent::nvidia::1", name: "NVIDIA Corporation", type: "entity" },
  relation: { key: "metrics", kind: "data", label: "Related Metrics", total: 80, total_capped: false,
    items: [{ id: "met::rev", name: "Revenues", aliases: [] }] },
};

const calls: string[] = [];
function mockFetch(json: unknown) {
  return vi.fn(async (url: string | URL) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => json, text: async () => "" } as unknown as Response;
  });
}

beforeEach(() => { calls.length = 0; vi.stubEnv("TAKO_API_KEY", "tako_sk_test"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("graphOverview", () => {
  it("parses the overview form into GraphRelation[] (snake_case → camelCase)", async () => {
    vi.stubGlobal("fetch", mockFetch(OVERVIEW_JSON));
    const { graphOverview } = await import("./graph");
    const { node, relations } = await graphOverview("ent::nvidia::1");
    expect(node.name).toBe("NVIDIA Corporation");
    expect(relations).toHaveLength(2);
    expect(relations[0]).toMatchObject({ key: "rel:competes_with", kind: "related", label: "Competes with", total: 181, totalCapped: false });
    expect(relations[0].items[0].name).toBe("Amazon.com, Inc.");
    expect(relations[1].totalCapped).toBe(true);
    expect(calls[0]).toContain("/related?node_id=");
    expect(calls[0]).not.toContain("relation_type");
    expect(calls[0]).not.toContain("relation=");
  });

  it("returns empty relations (not throw) when the field is missing", async () => {
    vi.stubGlobal("fetch", mockFetch({ node: { id: "x", name: "X", type: "entity" } }));
    const { graphOverview } = await import("./graph");
    const { relations } = await graphOverview("x");
    expect(relations).toEqual([]);
  });
});

describe("graphRelated (relation= param)", () => {
  it("sends relation=<key>, never the deprecated relation_type", async () => {
    vi.stubGlobal("fetch", mockFetch(DRILL_JSON));
    const { graphRelated } = await import("./graph");
    const items = await graphRelated("ent::nvidia::1", { relation: "metrics", q: "revenue", limit: 8 });
    expect(items.map((i) => i.name)).toEqual(["Revenues"]);
    expect(calls[0]).toContain("relation=metrics");
    expect(calls[0]).toContain("q=revenue");
    expect(calls[0]).not.toContain("relation_type");
  });

  it("accepts named-edge keys for drills", async () => {
    vi.stubGlobal("fetch", mockFetch(DRILL_JSON));
    const { graphRelated } = await import("./graph");
    await graphRelated("ent::nvidia::1", { relation: "rel:has_team", limit: 100 });
    expect(calls[0]).toContain(encodeURIComponent("rel:has_team"));
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Live-verified fixture shape (staging.tako.com, 2026-07-12, NVIDIA node).
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

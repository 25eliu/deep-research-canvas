import { describe, it, expect } from "vitest";
import { getAncestors, getDescendants } from "./lineage";
import type { CanvasEdge } from "./schema";

const E = (id: string, from: string, to: string, kind: CanvasEdge["kind"]): CanvasEdge => ({
  id, from, to, kind,
});

// synth ← rq1 ← rq1a; finding cards feed rq1a and rq2.
//   derived_from: child → parent; feeds: card → research node.
const tree: CanvasEdge[] = [
  E("d1", "rq1", "synth", "derived_from"),
  E("d2", "rq2", "synth", "derived_from"),
  E("d3", "rq1a", "rq1", "derived_from"),
  E("f1", "c1", "rq1a", "feeds"),
  E("f2", "c2", "rq2", "feeds"),
];

describe("getDescendants", () => {
  it("collects the full subtree across derived_from and feeds edges", () => {
    expect(getDescendants("synth", tree)).toEqual(new Set(["rq1", "rq2", "rq1a", "c1", "c2"]));
    expect(getDescendants("rq1", tree)).toEqual(new Set(["rq1a", "c1"]));
  });

  it("returns an empty set for leaves and unknown ids", () => {
    expect(getDescendants("c1", tree)).toEqual(new Set());
    expect(getDescendants("nope", tree)).toEqual(new Set());
  });

  it("ignores lateral edge kinds", () => {
    const withLateral = [
      ...tree,
      E("s1", "x", "rq1", "supports"),
      E("s2", "y", "rq1", "contradicts"),
      E("s3", "z", "rq1", "sibling"),
    ];
    expect(getDescendants("rq1", withLateral)).toEqual(new Set(["rq1a", "c1"]));
  });

  it("terminates on cyclic edges", () => {
    const cyclic = [
      E("d1", "b", "a", "derived_from"),
      E("d2", "c", "b", "derived_from"),
      E("d3", "a", "c", "derived_from"),
    ];
    expect(getDescendants("a", cyclic)).toEqual(new Set(["b", "c"]));
  });
});

describe("getAncestors", () => {
  it("collects the parent chain up to the root", () => {
    expect(getAncestors("c1", tree)).toEqual(new Set(["rq1a", "rq1", "synth"]));
    expect(getAncestors("rq2", tree)).toEqual(new Set(["synth"]));
  });

  it("returns an empty set for the root and unknown ids", () => {
    expect(getAncestors("synth", tree)).toEqual(new Set());
    expect(getAncestors("nope", tree)).toEqual(new Set());
  });

  it("ignores lateral edge kinds and terminates on cycles", () => {
    const cyclic = [
      E("d1", "b", "a", "derived_from"),
      E("d2", "a", "b", "derived_from"),
      E("s1", "b", "z", "supports"),
    ];
    expect(getAncestors("b", cyclic)).toEqual(new Set(["a"]));
  });
});

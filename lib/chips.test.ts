import { describe, it, expect } from "vitest";
import { nodeChip, stageChip } from "./chips";

describe("nodeChip", () => {
  it("labels a data_card as a generated graph", () => {
    expect(nodeChip({ type: "data_card", title: "NVDA revenue", role: undefined }))
      .toEqual({ icon: "📊", label: "Graph generated · NVDA revenue" });
  });
  it("labels a web evidence node as an info block", () => {
    expect(nodeChip({ type: "text", role: "evidence", title: "Analyst note" }))
      .toEqual({ icon: "📄", label: "Info block · Analyst note" });
  });
  it("returns null for section headers", () => {
    expect(nodeChip({ type: "entity_section", title: "Nvidia", role: "header" })).toBeNull();
  });
  it("returns null when there is no title", () => {
    expect(nodeChip({ type: "data_card", title: "", role: undefined })).toBeNull();
  });
});

describe("stageChip", () => {
  it("maps searching / asking to a Searching chip", () => {
    expect(stageChip("searching Tako (web enabled)")).toEqual({ icon: "🔍", label: "Searching Tako" });
    expect(stageChip("asking Tako (web enabled)")).toEqual({ icon: "🔍", label: "Searching Tako" });
  });
  it("maps resolved to a Resolved entities chip", () => {
    expect(stageChip("resolved 2 graph nodes")).toEqual({ icon: "🔗", label: "Resolved entities" });
  });
  it("maps writing answer", () => {
    expect(stageChip("writing answer")).toEqual({ icon: "✍️", label: "Writing answer" });
  });
  it("returns null for noisy internal stages", () => {
    expect(stageChip("routing")).toBeNull();
    expect(stageChip("planning queries")).toBeNull();
    expect(stageChip("fetched 5 findings")).toBeNull();
  });
});

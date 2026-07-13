import { describe, it, expect } from "vitest";
import { zRouteAction, zRoute, ROUTER } from "./router";

describe("router schema", () => {
  it("accepts RESEARCH as a valid action", () => {
    expect(zRouteAction.parse("RESEARCH")).toBe("RESEARCH");
    expect(zRoute.parse({ action: "RESEARCH", reason: "user wants to dig in" }).action).toBe("RESEARCH");
  });

  it("still accepts the four original actions", () => {
    for (const a of ["REPLACE", "AUGMENT", "GENERATE", "EXPLAIN"]) {
      expect(zRouteAction.parse(a)).toBe(a);
    }
  });

  it("documents RESEARCH and restricts REPLACE to explicit restarts in the prompt", () => {
    expect(ROUTER).toContain("RESEARCH");
    expect(ROUTER).toMatch(/start over|restart|scrap/i);
  });
});

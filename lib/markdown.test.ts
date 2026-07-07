import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../components/Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("renders paired **bold** as <strong>", () => {
    expect(html("a **b** c")).toContain("<strong>b</strong>");
  });
  it("leaves a trailing unmatched ** literal (mid-stream safety)", () => {
    const out = html("Nvidia leads **on");
    expect(out).not.toContain("<strong>");
    expect(out).toContain("**on");
  });
  it("renders ## as a subheading", () => {
    expect(html("## Revenue")).toContain('class="md-h2"');
  });
  it("keeps a heading's body when there is NO blank line between them", () => {
    const out = html("## Revenue\nNvidia grew fast.");
    expect(out).toContain('class="md-h2"');
    expect(out).toContain("Revenue");
    expect(out).toContain("Nvidia grew fast."); // body must NOT be dropped
  });
  it("renders a bullet list", () => {
    const out = html("- a\n- b");
    expect(out).toContain('class="md-ul"');
    expect((out.match(/md-li/g) || []).length).toBe(2);
  });
  it("renders paragraphs split by blank lines", () => {
    const out = html("one\n\ntwo");
    expect((out.match(/md-p/g) || []).length).toBe(2);
  });
  it("does not throw on empty or partial input", () => {
    expect(() => html("")).not.toThrow();
    expect(() => html("#")).not.toThrow();
    expect(() => html("- ")).not.toThrow();
  });
});

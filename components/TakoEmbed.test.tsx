import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import TakoEmbed from "./TakoEmbed";

// Explicit afterEach cleanup — vitest globals are off (see ComparisonChart.test.tsx).
afterEach(cleanup);

const tako = {
  cardId: "card_1",
  embedUrl: "https://staging.tako.com/embed/card_1",
  imageUrl: "https://staging.tako.com/img/card_1.png",
};

function postResize(source: Window | null, data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
  });
}

describe("TakoEmbed", () => {
  it("sizes by aspect-ratio estimate until the embed reports its height", () => {
    const { container } = render(<TakoEmbed tako={tako} title="t" />);
    const frame = container.querySelector<HTMLElement>(".tako-frame")!;
    expect(frame.style.aspectRatio).toContain("1 /");
    expect(frame.style.height).toBe("");
  });

  it("switches to the exact pixel height from a tako::resize message", () => {
    const { container } = render(<TakoEmbed tako={tako} title="t" />);
    const iframe = container.querySelector("iframe")!;
    postResize(iframe.contentWindow, { type: "tako::resize", height: 512 });
    const frame = container.querySelector<HTMLElement>(".tako-frame")!;
    expect(frame.style.height).toBe("512px");
    expect(frame.style.aspectRatio).toBe("");
  });

  it("accepts JSON-string message data and nested payload heights", () => {
    const { container } = render(<TakoEmbed tako={tako} title="t" />);
    const iframe = container.querySelector("iframe")!;
    postResize(iframe.contentWindow, JSON.stringify({ event: "tako::resize", payload: { height: 431 } }));
    expect(container.querySelector<HTMLElement>(".tako-frame")!.style.height).toBe("431px");
  });

  it("ignores messages from other windows and junk heights", () => {
    const { container } = render(<TakoEmbed tako={tako} title="t" />);
    const iframe = container.querySelector("iframe")!;
    postResize(window, { type: "tako::resize", height: 512 }); // wrong source
    postResize(iframe.contentWindow, { type: "tako::resize", height: 4 }); // implausibly small
    postResize(iframe.contentWindow, { type: "unrelated", height: 512 }); // wrong type
    const frame = container.querySelector<HTMLElement>(".tako-frame")!;
    expect(frame.style.height).toBe("");
    expect(frame.style.aspectRatio).toContain("1 /");
  });
});

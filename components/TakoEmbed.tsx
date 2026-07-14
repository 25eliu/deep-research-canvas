"use client";
import { useEffect, useRef, useState } from "react";
import type { TakoRef } from "@/lib/schema";

// Tako embeds post their rendered height via a `tako::resize` postMessage — that exact
// pixel height is the only way to avoid a mismatch strip under the card (the embed's own
// page background showing below its content). Until the message arrives we estimate the
// height from `imageUrl` (the same card as a flat PNG). Caveat for the estimate: the live
// embed wraps long titles to 2 lines at our 460px width while the wide source image keeps
// them on one line — so we fit through the WORST case at each aspect so the footer + TAKO
// logo are never clipped:
//   embedHeight ≈ 460 · (1.77·imageAspect + 0.14)
const DEFAULT_ASPECT = 0.95; // h/w fallback until the image reports its ratio
const MIN_ASPECT = 0.7;
const MAX_ASPECT = 1.8;
const MIN_POSTED_HEIGHT = 40; // below this a resize message is junk, not a card
const MAX_POSTED_HEIGHT = 1200;

function embedAspect(imgH: number, imgW: number): number {
  const r = imgH / imgW;
  const a = 1.77 * r + 0.14;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
}

function parseMessageData(data: unknown): Record<string, unknown> | null {
  if (typeof data === "string") {
    try { return JSON.parse(data) as Record<string, unknown>; } catch { return null; }
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

function postedHeight(data: unknown): number | null {
  const d = parseMessageData(data);
  if (!d) return null;
  const type = String(d.type ?? d.event ?? "");
  if (!type.includes("tako") || !type.includes("resize")) return null;
  const payload = (d.payload && typeof d.payload === "object" ? d.payload : d) as Record<string, unknown>;
  const h = Number(payload.height);
  if (!Number.isFinite(h) || h < MIN_POSTED_HEIGHT) return null;
  return Math.min(h, MAX_POSTED_HEIGHT);
}

export default function TakoEmbed({ tako, title }: { tako: TakoRef; title: string }) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);
  const [height, setHeight] = useState<number | null>(null); // exact px from tako::resize
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!tako.imageUrl) return;
    let alive = true;
    const img = new window.Image();
    img.onload = () => {
      if (alive && img.naturalWidth > 0) setAspect(embedAspect(img.naturalHeight, img.naturalWidth));
    };
    img.src = tako.imageUrl;
    return () => { alive = false; };
  }, [tako.imageUrl]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Many embeds share one window — match the event to THIS iframe via its source.
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      const h = postedHeight(e.data);
      if (h !== null) setHeight(h);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div
      className="tako-frame"
      style={height !== null ? { height } : { aspectRatio: `1 / ${aspect}` }}
    >
      {/* Static chart PNG behind the live embed. Cross-origin iframes routinely paint
          blank — while loading, when Chromium drops a transformed iframe's layer (many
          embeds on a scaled canvas), or when Tako's in-iframe chart fetch fails. The
          transparent iframe sits on top; whenever it's blank the user sees this image
          (the same chart) instead of a white void. An opaque loaded embed covers it. */}
      {tako.imageUrl && <img className="tako-frame-img" src={tako.imageUrl} alt="" aria-hidden />}
      {tako.embedUrl && (
        <iframe ref={iframeRef} src={tako.embedUrl} title={title} loading="lazy" allow="clipboard-write" />
      )}
      {!tako.imageUrl && !tako.embedUrl && (
        <div className="tako-frame-empty">chart unavailable</div>
      )}
    </div>
  );
}

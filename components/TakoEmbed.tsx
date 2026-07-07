"use client";
import { useEffect, useState } from "react";
import type { TakoRef } from "@/lib/schema";

// A Tako embed is cross-origin (no readable height, no postMessage), so we estimate its
// height from the `imageUrl` (the same card as a flat PNG). Caveat: the live embed wraps
// long titles to 2 lines at our 460px width while the wide source image keeps them on one
// line — so two cards with the SAME image aspect can need different heights (measured
// ~380px vs ~430px once a title wraps). No image variant reveals the wrap, so we fit
// through the WORST case at each aspect so the footer + TAKO logo are never clipped:
//   embedHeight ≈ 460 · (1.77·imageAspect + 0.14)
// This covers 1- and 2-line titles; the trade is a little bottom padding on short-title
// cards, which beats cutting off the source attribution.
const DEFAULT_ASPECT = 0.95; // h/w fallback until the image reports its ratio
const MIN_ASPECT = 0.7;
const MAX_ASPECT = 1.8;

function embedAspect(imgH: number, imgW: number): number {
  const r = imgH / imgW;
  const a = 1.77 * r + 0.14;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a));
}

export default function TakoEmbed({ tako, title }: { tako: TakoRef; title: string }) {
  const [aspect, setAspect] = useState(DEFAULT_ASPECT);

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

  return (
    <div className="tako-frame" style={{ aspectRatio: `1 / ${aspect}` }}>
      {/* Static chart PNG behind the live embed. Cross-origin iframes routinely paint
          blank — while loading, when Chromium drops a transformed iframe's layer (many
          embeds on a scaled canvas), or when Tako's in-iframe chart fetch fails. The
          transparent iframe sits on top; whenever it's blank the user sees this image
          (the same chart) instead of a white void. An opaque loaded embed covers it. */}
      {tako.imageUrl && <img className="tako-frame-img" src={tako.imageUrl} alt="" aria-hidden />}
      {tako.embedUrl && (
        <iframe src={tako.embedUrl} title={title} loading="lazy" allow="clipboard-write" />
      )}
    </div>
  );
}

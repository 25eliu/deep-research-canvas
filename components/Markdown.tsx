"use client";
import React from "react";

// A tiny, streaming-tolerant Markdown subset renderer: `#`/`##` headings,
// `**bold**`, `-`/`*` bullet lists, and paragraphs. It parses the current
// (possibly incomplete) string line-by-line on every render and never throws —
// an unclosed `**` or half-written heading mid-stream renders as literal text
// and upgrades once the rest arrives. No dangerouslySetInnerHTML.
//
// Line-based (not blank-line blocks) so a heading keeps its following body even
// when the model writes `## Heading\nbody` with no blank line between them.

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*/g; // only matched pairs become bold; a trailing ** stays literal
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={`${keyBase}-b${i++}`}>{m[1]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isBullet = (l: string) => /^\s*[-*]\s+/.test(l);
const isH2 = (l: string) => /^##\s/.test(l);
const isH1 = (l: string) => /^#\s/.test(l);

export default function Markdown({ text, compact }: { text: string; compact?: boolean }) {
  const lines = (text || "").split("\n");
  const out: React.ReactNode[] = [];
  let para: string[] = []; // buffered consecutive paragraph lines
  let bullets: string[] = []; // buffered consecutive bullet lines
  let k = 0;

  const flushPara = () => {
    if (!para.length) return;
    const key = `p${k++}`;
    out.push(<p key={key} className="md-p">{renderInline(para.join(" "), key)}</p>);
    para = [];
  };
  const flushBullets = () => {
    if (!bullets.length) return;
    const key = `u${k++}`;
    out.push(
      <ul key={key} className="md-ul">
        {bullets.map((l, li) => (
          <li key={li} className="md-li">{renderInline(l.replace(/^\s*[-*]\s+/, ""), `${key}-${li}`)}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  const flush = () => { flushBullets(); flushPara(); };

  for (const line of lines) {
    if (isH2(line)) { flush(); const key = `h${k++}`; out.push(<h4 key={key} className="md-h2">{renderInline(line.replace(/^##\s*/, ""), key)}</h4>); continue; }
    if (isH1(line)) { flush(); const key = `h${k++}`; out.push(<h3 key={key} className="md-h1">{renderInline(line.replace(/^#\s*/, ""), key)}</h3>); continue; }
    if (isBullet(line)) { flushPara(); bullets.push(line); continue; }
    if (!line.trim()) { flush(); continue; } // blank line ends a paragraph/list
    flushBullets(); para.push(line);
  }
  flush();

  return <div className={compact ? "md md-compact" : "md"}>{out}</div>;
}

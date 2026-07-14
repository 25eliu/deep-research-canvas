import type { SVGProps } from "react";

const s = (props: SVGProps<SVGSVGElement>) => ({
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...props,
});

export const IconSidebar = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
);
export const IconPlus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
);
export const IconSend = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M5 12h13M12 5l7 7-7 7" /></svg>
);
export const IconChevron = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M6 9l6 6 6-6" /></svg>
);
export const IconChevronRight = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M9 6l6 6-6 6" /></svg>
);
export const IconX = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconPanel = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
);
export const IconExternal = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4" /></svg>
);
export const IconSpark = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M12 3v4M12 17v4M5 12H1M23 12h-4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" /></svg>
);
export const IconMinus = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M5 12h14" /></svg>
);
export const IconChat = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M21 12a8 8 0 0 1-8 8H4l2.4-2.9A8 8 0 1 1 21 12z" /></svg>
);
export const IconFit = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /></svg>
);
// A branch splitting into two — a decomposed research question.
export const IconBranch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M6 4v6M6 10c0 4 4 4 6 4h6M6 10c0 4 4 4 6 4M18 14l-3-3M18 14l-3 3" /><circle cx="6" cy="4" r="1.6" /></svg>
);
// A terminal leaf node — an atomic sub-answer fetched directly.
export const IconLeaf = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M6 4v10M6 14h6" /><circle cx="6" cy="4" r="1.6" /><circle cx="15" cy="14" r="2.4" /></svg>
);
// Magnifier — a Tako search call.
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><circle cx="11" cy="11" r="6" /><path d="M20 20l-3.5-3.5" /></svg>
);
// Converging lines into one — the synthesis step.
export const IconSynthesis = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M5 5c5 0 5 7 10 7M5 19c5 0 5-7 10-7M15 12h4M19 12l-2.5-2.5M19 12l-2.5 2.5" /></svg>
);
// Braces — the LLM reasoning step.
export const IconReasoning = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M9 4c-2 0-2 2-2 4s0 2-2 4c2 2 2 2 2 4s0 4 2 4M15 4c2 0 2 2 2 4s0 2 2 4c-2 2-2 2-2 4s0 4-2 4" /></svg>
);
// Bar chart — a data/visualization step (legacy tool-chip 📊).
export const IconChart = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M4 20h16M7 20v-6M12 20V9M17 20v-9" /></svg>
);
// Document — a content/summary step (legacy tool-chip 📄).
export const IconDoc = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v4h4M9 12h6M9 16h6" /></svg>
);
// Chain link — a linking/citation step (legacy tool-chip 🔗).
export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5" /></svg>
);
// Pen — a writing/synthesis step (legacy tool-chip ✍️).
export const IconPen = (p: SVGProps<SVGSVGElement>) => (
  <svg {...s(p)}><path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" /><path d="M14 7l3 3" /></svg>
);

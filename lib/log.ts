// Lightweight structured logger for backend calls.
//
// Writes to the server console (the terminal running `next dev`, or your hosting
// platform's log stream) so every Tako REST call, graph call, LLM call, and
// agent step is visible with timing. Each line is:
//
//   [2026-07-06T18:20:01.123Z] [tako] → POST /v3/search { query: "nvidia revenue" }
//   [2026-07-06T18:20:01.884Z] [tako] ← POST /v3/search 200 { ms: 761, cards: 3 }
//
// Set AGENT_LOG=off to silence all of it; AGENT_LOG=verbose to include payload
// previews on every line.

type Fields = Record<string, unknown>;

const MODE = (process.env.AGENT_LOG || "on").toLowerCase();
const ENABLED = MODE !== "off" && MODE !== "0" && MODE !== "false";
const VERBOSE = MODE === "verbose" || MODE === "debug";

function ts(): string {
  // ISO timestamp; Date is fine on the server runtime.
  return new Date().toISOString();
}

function fmtFields(extra?: Fields): string {
  if (!extra) return "";
  const keys = Object.keys(extra).filter((k) => extra[k] !== undefined);
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}=${fmtValue(extra[k])}`);
  return " " + parts.join(" ");
}

function fmtValue(v: unknown): string {
  if (typeof v === "string") return v.length > 120 ? JSON.stringify(v.slice(0, 117) + "…") : JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 160 ? s.slice(0, 157) + "…" : s;
  } catch {
    return String(v);
  }
}

export function log(scope: string, msg: string, extra?: Fields): void {
  if (!ENABLED) return;
  console.log(`[${ts()}] [${scope}] ${msg}${fmtFields(extra)}`);
}

export function logError(scope: string, msg: string, extra?: Fields): void {
  if (!ENABLED) return;
  console.error(`[${ts()}] [${scope}] ✗ ${msg}${fmtFields(extra)}`);
}

/** Truncated preview of a payload, only rendered in verbose mode. */
export function preview(obj: unknown): string | undefined {
  if (!VERBOSE) return undefined;
  try {
    const s = typeof obj === "string" ? obj : JSON.stringify(obj);
    return s.length > 300 ? s.slice(0, 297) + "…" : s;
  } catch {
    return undefined;
  }
}

export interface Timer {
  /** Emit the closing "← <msg>" line with elapsed ms merged into `extra`. */
  done: (msg: string, extra?: Fields) => number;
  /** Emit a failure "✗ <msg>" line with elapsed ms merged into `extra`. */
  fail: (msg: string, extra?: Fields) => number;
}

/** Log an opening "→ <msg>" line and return a timer whose done()/fail() log the paired close. */
export function startTimer(scope: string, msg: string, extra?: Fields): Timer {
  const t0 = Date.now();
  log(scope, `→ ${msg}`, extra);
  return {
    done: (m, ex) => {
      const ms = Date.now() - t0;
      log(scope, `← ${m}`, { ms, ...ex });
      return ms;
    },
    fail: (m, ex) => {
      const ms = Date.now() - t0;
      logError(scope, `${m}`, { ms, ...ex });
      return ms;
    },
  };
}

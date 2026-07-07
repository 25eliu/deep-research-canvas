// Live web retrieval for the BASELINE providers (gpt, claude).
//
// Each provider searches the web with its own NATIVE web-search tool:
//   - OpenAI  → Responses API tool `web_search_preview`
//   - Anthropic → Messages API tool `web_search_20250305`
//
// We call the REST endpoints directly with the same API keys the AI SDK uses, so
// no SDK-version upgrade or new dependency is needed (the installed
// @ai-sdk/anthropic@1.2.12 does not expose a web-search tool). The model does the
// searching + synthesis server-side; we return its prose plus the cited source
// URLs. ANY failure (missing key, a model that can't web-search, network/timeout)
// degrades to an empty result, so the caller falls back to model knowledge
// instead of erroring the whole turn.

import { modelId, type LlmProvider } from "./llm";
import { startTimer, logError } from "./log";

export interface WebSource {
  url: string;
  title?: string;
}
export interface WebResearch {
  text: string;
  sources: WebSource[];
}

const EMPTY: WebResearch = { text: "", sources: [] };
const TIMEOUT_MS = 30_000;

// Keep the model focused on gathering citable facts, not composing a canvas.
const RESEARCH_SYSTEM =
  "Search the web and report the concrete, up-to-date facts and figures that answer " +
  "the question. Prefer specific numbers with their units and dates, and name the " +
  "source for each. Be concise.";

export async function researchWeb(opts: {
  provider: LlmProvider;
  query: string;
}): Promise<WebResearch> {
  const timer = startTimer("research", `web ${opts.provider}`, {
    model: modelId(opts.provider),
    query: opts.query,
  });
  try {
    const out =
      opts.provider === "openai"
        ? await researchOpenAI(opts.query)
        : await researchAnthropic(opts.query);
    timer.done(`web ${opts.provider}`, {
      chars: out.text.length,
      sources: out.sources.length,
    });
    return out;
  } catch (e: unknown) {
    // Non-fatal: the baseline falls back to model knowledge.
    timer.fail(`web ${opts.provider} failed — falling back to model knowledge`, {
      error: e instanceof Error ? e.message : String(e),
    });
    return EMPTY;
  }
}

async function researchOpenAI(query: string): Promise<WebResearch> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    logError("research", "OpenAI web search skipped — OPENAI_API_KEY not set");
    return EMPTY;
  }
  const data = await postJson(
    "https://api.openai.com/v1/responses",
    { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    {
      model: modelId("openai"),
      tools: [{ type: "web_search_preview" }],
      instructions: RESEARCH_SYSTEM,
      input: query,
    },
    "openai responses",
  );
  return parseOpenAI(data);
}

async function researchAnthropic(query: string): Promise<WebResearch> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    logError("research", "Anthropic web search skipped — ANTHROPIC_API_KEY not set");
    return EMPTY;
  }
  const data = await postJson(
    "https://api.anthropic.com/v1/messages",
    {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    {
      model: modelId("anthropic"),
      max_tokens: 1024,
      system: RESEARCH_SYSTEM,
      messages: [{ role: "user", content: query }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
    },
    "anthropic messages",
  );
  return parseAnthropic(data);
}

// Shared POST with timeout; throws on non-2xx so researchWeb can log + fall back.
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  label: string,
): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
    }
    return await res.json();
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error(`${label} timed out after ${TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// OpenAI Responses output: an array of items; message items carry `output_text`
// content whose `annotations` include `url_citation` sources.
function parseOpenAI(data: any): WebResearch {
  const sources: WebSource[] = [];
  let text = "";
  for (const item of asArray(data?.output)) {
    if (item?.type !== "message") continue;
    for (const c of asArray(item?.content)) {
      if (c?.type === "output_text" && typeof c.text === "string") {
        text = appendText(text, c.text);
        for (const a of asArray(c?.annotations)) {
          if (a?.type === "url_citation" && a?.url) {
            sources.push({ url: a.url, title: a.title });
          }
        }
      }
    }
  }
  return { text: text.trim(), sources: dedupeSources(sources) };
}

// Anthropic Messages content: `text` blocks (with `citations`) interleaved with
// `web_search_tool_result` blocks listing the raw results.
function parseAnthropic(data: any): WebResearch {
  const sources: WebSource[] = [];
  let text = "";
  for (const block of asArray(data?.content)) {
    if (block?.type === "text" && typeof block.text === "string") {
      text = appendText(text, block.text);
      for (const cit of asArray(block?.citations)) {
        if (cit?.url) sources.push({ url: cit.url, title: cit.title });
      }
    } else if (block?.type === "web_search_tool_result") {
      for (const r of asArray(block?.content)) {
        if (r?.url) sources.push({ url: r.url, title: r.title });
      }
    }
  }
  return { text: text.trim(), sources: dedupeSources(sources) };
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

function appendText(acc: string, next: string): string {
  return acc ? `${acc}\n${next}` : next;
}

function dedupeSources(list: WebSource[]): WebSource[] {
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const s of list) {
    if (!s.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

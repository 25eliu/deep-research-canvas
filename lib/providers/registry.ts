import type { AgentRequest, AgentResponse, ProviderId } from "../schema";
import type { EmitFn } from "../agents/shared/types";
import { runBaseline } from "../agents/baseline/agent";
import { runTako } from "../agents/tako/agent";
import { searchStrategy } from "../agents/tako/strategy";

export interface ProviderCapabilities {
  structured_cards: boolean;
  tako_search: boolean;
  tako_graph: boolean;
  tako_answer: boolean;
  web_search: boolean;
}

export interface ProviderDef {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  run: (req: AgentRequest, emit?: EmitFn) => Promise<AgentResponse>;
}

// Baselines have no Tako access but DO retrieve via the provider's native web search.
const BASELINE: ProviderCapabilities = {
  structured_cards: false, tako_search: false, tako_graph: false, tako_answer: false, web_search: true,
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  gpt: { id: "gpt", label: "GPT", capabilities: BASELINE, run: (r, t) => runBaseline("openai", r, t) },
  claude: { id: "claude", label: "Claude", capabilities: BASELINE, run: (r, t) => runBaseline("anthropic", r, t) },
  tako: {
    id: "tako", label: "LLM + Tako",
    capabilities: { structured_cards: true, tako_search: true, tako_graph: true, tako_answer: true, web_search: true },
    run: (r, e) => runTako(r, e),
  },
  "tako-search": {
    id: "tako-search", label: "LLM + Tako (search-only)",
    capabilities: { structured_cards: true, tako_search: true, tako_graph: false, tako_answer: true, web_search: true },
    run: (r, e) => runTako(r, e, searchStrategy),
  },
};

export function runProvider(req: AgentRequest, emit?: EmitFn): Promise<AgentResponse> {
  const def = PROVIDERS[req.providerId] ?? PROVIDERS.tako;
  return def.run(req, emit);
}

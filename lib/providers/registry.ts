import type { AgentRequest, AgentResponse, ProviderId } from "../schema";
import type { TraceFn } from "../agents/shared/types";
import { runBaseline } from "../agents/baseline/agent";
import { runTako } from "../agents/tako/agent";

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
  run: (req: AgentRequest, onTrace?: TraceFn) => Promise<AgentResponse>;
}

const NO_TAKO: ProviderCapabilities = {
  structured_cards: false, tako_search: false, tako_graph: false, tako_answer: false, web_search: false,
};

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  gpt: { id: "gpt", label: "GPT", capabilities: NO_TAKO, run: (r, t) => runBaseline("openai", r, t) },
  claude: { id: "claude", label: "Claude", capabilities: NO_TAKO, run: (r, t) => runBaseline("anthropic", r, t) },
  tako: {
    id: "tako", label: "LLM + Tako",
    capabilities: { structured_cards: true, tako_search: true, tako_graph: true, tako_answer: true, web_search: false },
    run: (r, t) => runTako(r, t),
  },
};

export function runProvider(req: AgentRequest, onTrace?: TraceFn): Promise<AgentResponse> {
  const def = PROVIDERS[req.providerId] ?? PROVIDERS.tako;
  return def.run(req, onTrace);
}

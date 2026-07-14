"use client";
import { useState } from "react";
import type { Provider } from "@/lib/sessions";
import { ProviderSeg, TakoSwitch, GraphySwitch } from "./ProviderControls";
import { IconSend } from "./icons";

// Chart-shaped questions (time series / entity comparisons Tako has real series
// for) — each verified live to produce a graphy hero when the toggle is on.
const EXAMPLES = [
  "Compare NVDA and AMD on revenue growth",
  "Compare US and China GDP growth since 2015",
  "How has US inflation changed over the past decade?",
];

export default function Landing({
  hidden, provider, setProvider, takoAnswer, setTakoAnswer, graphy, setGraphy, onSend, loading,
}: {
  hidden: boolean;
  provider: Provider;
  setProvider: (p: Provider) => void;
  takoAnswer: boolean;
  setTakoAnswer: (v: boolean) => void;
  graphy: boolean;
  setGraphy: (v: boolean) => void;
  onSend: (text: string) => void;
  loading: boolean;
}) {
  const [text, setText] = useState(EXAMPLES[0]);
  const submit = () => {
    if (!text.trim() || loading) return;
    onSend(text.trim());
    setText("");
  };

  return (
    <div className={`landing${hidden ? " hidden" : ""}`}>
      <div className="landing-inner">
        <h1 className="wordmark">A canvas that <em>remembers</em>.</h1>
        <p className="tagline">
          Ask a question and watch grounded evidence assemble itself into a spatial memory —
          Tako cards, metrics, and a consensus you can interrogate.
        </p>

        <div className="composer big">
          <textarea
            value={text}
            autoFocus
            rows={1}
            placeholder="Ask anything…"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          />
          <button className="send-btn" onClick={submit} disabled={loading || !text.trim()}>
            <IconSend />
          </button>
        </div>

        <div className="landing-controls">
          <ProviderSeg provider={provider} onChange={setProvider} />
          <TakoSwitch checked={takoAnswer} onChange={setTakoAnswer} />
          <GraphySwitch checked={graphy} onChange={setGraphy} />
        </div>

        <div className="examples">
          {EXAMPLES.map((ex) => (
            <button key={ex} className="chip" onClick={() => onSend(ex)}>{ex}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

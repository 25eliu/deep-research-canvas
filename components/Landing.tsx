"use client";
import { useState } from "react";
import type { Provider } from "@/lib/sessions";
import { ProviderSeg, TakoSwitch } from "./ProviderControls";
import { IconSend } from "./icons";

const EXAMPLES = [
  "Research the best 5 semiconductor companies to invest in",
  "Compare NVDA and AMD on revenue growth",
  "What's driving inflation this year?",
];

export default function Landing({
  hidden, provider, setProvider, takoAnswer, setTakoAnswer, onSend, loading,
}: {
  hidden: boolean;
  provider: Provider;
  setProvider: (p: Provider) => void;
  takoAnswer: boolean;
  setTakoAnswer: (v: boolean) => void;
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

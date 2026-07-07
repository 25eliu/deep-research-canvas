"use client";
import type { Provider } from "@/lib/sessions";

export const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "tako", label: "LLM + Tako" },
  { id: "gpt", label: "GPT" },
  { id: "claude", label: "Claude" },
];

export function ProviderSeg({
  provider, onChange,
}: {
  provider: Provider;
  onChange: (p: Provider) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {PROVIDERS.map((p) => (
        <button
          key={p.id}
          role="tab"
          aria-selected={provider === p.id}
          className={`seg-btn${provider === p.id ? " on" : ""}${p.id === "tako" ? " tako" : ""}`}
          onClick={() => onChange(p.id)}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export function TakoSwitch({
  checked, onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
      tako answer
    </label>
  );
}

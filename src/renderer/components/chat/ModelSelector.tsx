import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface LlmConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  isDefault: boolean;
}

interface ModelSelectorProps {
  selectedConfigId: string | null;
  onSelect: (configId: string) => void;
}

export const ModelSelector = ({ selectedConfigId, onSelect }: ModelSelectorProps) => {
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.filework.llmConfig.list().then((result) => {
      if (!("error" in result)) setConfigs(result as LlmConfig[]);
    });
  }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (configs.length <= 1) return null;

  const selected = configs.find((c) => c.id === selectedConfigId) || configs.find((c) => c.isDefault) || configs[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
      >
        <span className="max-w-[120px] truncate">{selected?.name}</span>
        <span className="opacity-40">·</span>
        <span className="max-w-[80px] truncate opacity-60">{selected?.model}</span>
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-border bg-background py-1 shadow-xl z-50">
          {configs.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => { onSelect(c.id); setOpen(false); }}
              className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent ${
                c.id === selected?.id ? "text-primary" : "text-foreground"
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{c.name}</div>
                <div className="truncate text-muted-foreground">{c.provider} · {c.model}</div>
              </div>
              {c.isDefault && <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">default</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

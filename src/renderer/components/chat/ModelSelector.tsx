import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Modality = "chat" | "image" | "video";

interface LlmConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  modality?: Modality;
}

interface ModelSelectorProps {
  selectedConfigId: string | null;
  onSelect: (configId: string) => void;
}

const MODALITY_ORDER: Modality[] = ["chat", "image", "video"];
const MODALITY_LABELS: Record<Modality, string> = {
  chat: "Chat",
  image: "Image",
  video: "Video",
};

export const ModelSelector = ({
  selectedConfigId,
  onSelect,
}: ModelSelectorProps) => {
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const loadConfigs = useCallback(() => {
    window.filework.llmConfig.list().then((result) => {
      if (!("error" in result)) setConfigs(result as LlmConfig[]);
    });
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const grouped = useMemo(() => {
    const groups: Record<Modality, LlmConfig[]> = {
      chat: [],
      image: [],
      video: [],
    };
    for (const c of configs) {
      groups[c.modality ?? "chat"].push(c);
    }
    return MODALITY_ORDER.filter((m) => groups[m].length > 0).map((m) => ({
      modality: m,
      items: groups[m],
    }));
  }, [configs]);

  if (configs.length <= 1) return null;

  const selected = configs.find((c) => c.id === selectedConfigId) || configs[0];
  const selectedModality = selected?.modality ?? "chat";
  const hasMultipleModalities = grouped.length > 1;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          if (!open) loadConfigs();
          setOpen(!open);
        }}
        className="flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
      >
        <span className="max-w-[120px] truncate">{selected?.name}</span>
        <span className="opacity-40">·</span>
        <span className="max-w-[80px] truncate opacity-60">
          {selected?.model}
        </span>
        {selectedModality !== "chat" && (
          <span className="ml-1 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-primary">
            {MODALITY_LABELS[selectedModality]}
          </span>
        )}
        <ChevronDown
          size={12}
          className={`transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-64 rounded-lg border border-border bg-background py-1 shadow-xl z-50 max-h-80 overflow-y-auto">
          {grouped.map((group) => (
            <div key={group.modality}>
              {hasMultipleModalities && (
                <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  {MODALITY_LABELS[group.modality]}
                </div>
              )}
              {group.items.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onSelect(c.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-accent ${
                    c.id === selected?.id ? "text-primary" : "text-foreground"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{c.name}</div>
                    <div className="truncate text-muted-foreground">
                      {c.provider} · {c.model}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

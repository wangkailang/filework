import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type Modality = "chat" | "image" | "video";

interface LlmConfig {
  id: string;
  name: string;
  provider: string;
  model: string;
  modality?: Modality;
  enabled?: boolean;
  lastCheckStatus?: "success" | "error" | null;
  modelAvailable?: boolean | null;
  modelCapabilities?: {
    preferredApi: "chat_completions" | "responses";
    supportsReasoning: boolean | null;
    supportsTools: boolean | null;
    supportsVision: boolean | null;
  } | null;
}

export interface SelectableLlmConfig {
  enabled?: boolean;
  lastCheckStatus?: "success" | "error" | null;
  modelAvailable?: boolean | null;
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

export function isSelectableLlmConfig(config: SelectableLlmConfig): boolean {
  return (
    config.enabled !== false &&
    config.lastCheckStatus === "success" &&
    config.modelAvailable !== false
  );
}

export function getSelectableLlmConfigs<T extends SelectableLlmConfig>(
  configs: T[],
): T[] {
  return configs.filter(isSelectableLlmConfig);
}

export const ModelSelector = ({
  selectedConfigId,
  onSelect,
}: ModelSelectorProps) => {
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [open, setOpen] = useState(false);

  const loadConfigs = useCallback(() => {
    window.filework.llmConfig.list().then((result) => {
      if (!("error" in result)) setConfigs(result as LlmConfig[]);
    });
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  const grouped = useMemo(() => {
    const selectableConfigs = getSelectableLlmConfigs(configs);
    const groups: Record<Modality, LlmConfig[]> = {
      chat: [],
      image: [],
      video: [],
    };
    for (const c of selectableConfigs) {
      groups[c.modality ?? "chat"].push(c);
    }
    return MODALITY_ORDER.filter((m) => groups[m].length > 0).map((m) => ({
      modality: m,
      items: groups[m],
    }));
  }, [configs]);

  const selectableConfigs = getSelectableLlmConfigs(configs);

  if (selectableConfigs.length <= 1) return null;

  const selected =
    selectableConfigs.find((c) => c.id === selectedConfigId) ||
    selectableConfigs[0];
  const selectedModality = selected?.modality ?? "chat";
  const hasMultipleModalities = grouped.length > 1;

  const getModelCapabilityHint = (config: LlmConfig): string | null => {
    const capabilities = config.modelCapabilities;
    if (!capabilities) return null;
    const parts: string[] = [];
    if (capabilities.preferredApi === "responses") parts.push("Responses");
    if (capabilities.supportsReasoning) parts.push("Reasoning");
    if (capabilities.supportsTools) parts.push("Tools");
    if (capabilities.supportsVision) parts.push("Vision");
    return parts.length > 0 ? parts.join(" · ") : null;
  };

  return (
    <Select
      value={selected?.id}
      onValueChange={onSelect}
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) loadConfigs();
        setOpen(nextOpen);
      }}
    >
      <SelectTrigger className="h-auto gap-1 rounded-md border-border bg-muted px-2 py-1 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
        <SelectValue aria-label={selected?.name}>
          <span className="flex min-w-0 items-center gap-1">
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
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="start" position="popper" className="w-64 max-h-80">
        {grouped.map((group) => (
          <SelectGroup key={group.modality}>
            {hasMultipleModalities && (
              <SelectLabel>{MODALITY_LABELS[group.modality]}</SelectLabel>
            )}
            {group.items.map((c) => (
              <SelectItem key={c.id} value={c.id} className="text-xs">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{c.name}</div>
                    <div className="truncate text-muted-foreground">
                      {c.provider} · {c.model}
                      {getModelCapabilityHint(c)
                        ? ` · ${getModelCapabilityHint(c)}`
                        : ""}
                    </div>
                  </div>
                </div>
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
};

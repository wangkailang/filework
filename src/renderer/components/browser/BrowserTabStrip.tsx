import { Globe2, LoaderCircle, Plus, X } from "lucide-react";

import type { BrowserTabState } from "../../../shared/browser";

export const BrowserTabStrip = ({
  tabs,
  onActivate,
  onClose,
  onCreate,
  closeLabel,
  newTabLabel,
}: {
  tabs: BrowserTabState[];
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onCreate: () => void;
  closeLabel: string;
  newTabLabel: string;
}) => (
  <div
    data-browser-tab-strip="true"
    className="flex h-8 shrink-0 items-stretch gap-px overflow-x-auto border-b border-border bg-muted/35 px-1 pt-1"
  >
    {tabs.map((tab) => (
      <div
        key={tab.id}
        data-browser-tab={tab.id}
        data-active={tab.active ? "true" : "false"}
        data-browser-loading={tab.loading ? "true" : "false"}
        className={`group flex min-w-0 max-w-44 items-center rounded-t-md border-x border-t px-1 transition-colors ${
          tab.active
            ? "border-border bg-background text-foreground"
            : "border-transparent text-muted-foreground hover:bg-background/60 hover:text-foreground"
        }`}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab.active}
          onClick={() => onActivate(tab.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-[11px]"
        >
          {tab.loading ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin text-sky-500" />
          ) : (
            <Globe2 className="size-3 shrink-0 opacity-65" />
          )}
          <span className="truncate">
            {tab.title || tab.url || newTabLabel}
          </span>
        </button>
        <button
          type="button"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={() => onClose(tab.id)}
          className="rounded p-0.5 opacity-45 hover:bg-muted hover:opacity-100"
        >
          <X className="size-3" />
        </button>
      </div>
    ))}
    <button
      type="button"
      data-browser-new-tab="true"
      aria-label={newTabLabel}
      title={newTabLabel}
      onClick={onCreate}
      className="mb-0.5 ml-0.5 grid w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground"
    >
      <Plus className="size-3.5" />
    </button>
  </div>
);

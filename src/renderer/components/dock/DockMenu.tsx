// 右上角面板菜单:一个下拉入口,统一切换右侧停靠区的 预览 / 子 agent / 差异 / 网页。
// 与 ContextDock 的标签等价,但即使停靠区关闭也能从这里打开;选中当前已开标签则收起。
import { ChevronDown, PanelRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import type { DockTab } from "./ContextDock";

export const DockMenu = ({
  activeTab,
  dockOpen,
  isGitRepo,
  hasSubagent,
  onSelect,
}: {
  activeTab: DockTab;
  dockOpen: boolean;
  isGitRepo: boolean;
  /** 是否有可钻入的子 agent;无则禁用「子 agent」项。 */
  hasSubagent: boolean;
  onSelect: (t: DockTab) => void;
}) => {
  const { LL } = useI18nContext();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击菜单外部关闭。
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // 快捷键提示与 App 中的全局监听保持一致(⇧⌘ + 首字母)。
  const items: {
    tab: DockTab;
    label: string;
    shortcut: string;
    on: boolean;
  }[] = [
    { tab: "preview", label: LL.dock_preview(), shortcut: "⇧⌘P", on: true },
    {
      tab: "subagent",
      label: LL.dock_subagent(),
      shortcut: "⇧⌘A",
      on: hasSubagent,
    },
    { tab: "diff", label: LL.dock_diff(), shortcut: "⇧⌘D", on: isGitRepo },
    { tab: "web", label: LL.dock_web(), shortcut: "⇧⌘W", on: isGitRepo },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={LL.dock_menu()}
        title={LL.dock_menu()}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1 rounded-md border px-2 py-1.5 transition-colors",
          dockOpen
            ? "border-primary/40 bg-accent text-foreground"
            : "border-border bg-muted/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
        )}
      >
        <PanelRight className="size-3.5" />
        <ChevronDown
          className={cn("size-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute top-full right-0 z-50 mt-1 w-52 rounded-lg border border-border bg-popover py-1 shadow-xl">
          {items.map((item) => {
            const active = dockOpen && activeTab === item.tab;
            return (
              <button
                key={item.tab}
                type="button"
                disabled={!item.on}
                onClick={() => {
                  onSelect(item.tab);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition-colors",
                  !item.on
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : active
                      ? "text-primary hover:bg-accent"
                      : "text-foreground hover:bg-accent",
                )}
              >
                <span>{item.label}</span>
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {item.shortcut}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

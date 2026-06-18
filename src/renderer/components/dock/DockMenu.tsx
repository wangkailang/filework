// 右上角面板菜单:一个下拉入口,统一切换右侧停靠区的 预览 / 子 agent / 差异 / 网页。
// 与 ContextDock 的标签等价,但即使停靠区关闭也能从这里打开;选中当前已开标签则收起。
import {
  Bot,
  ChevronDown,
  FileText,
  GitCompareArrows,
  Globe,
  type LucideIcon,
  PanelRight,
  Search,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import type { DockTab } from "./ContextDock";

export const DockShortcut = ({
  active,
  dimmed = false,
  shortcut,
  tab,
}: {
  active: boolean;
  dimmed?: boolean;
  shortcut: string;
  tab: DockTab;
}) => (
  <DropdownMenuShortcut
    data-dock-shortcut={tab}
    className={cn(
      "ml-auto flex shrink-0 items-center justify-end gap-0.5 font-mono leading-none tracking-normal tabular-nums",
      dimmed && "opacity-45",
    )}
  >
    {Array.from(shortcut).map((key, index, keys) => (
      <kbd
        key={`${tab}-${key}`}
        className={cn(
          "inline-flex size-[18px] items-center justify-center rounded-[4px] border border-border/55 bg-muted/35 text-[10px] text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.04)]",
          active && "border-primary/35 bg-primary/10 text-primary",
          index === keys.length - 1 &&
            (active
              ? "font-semibold text-primary"
              : "font-semibold text-foreground/80"),
        )}
      >
        {key}
      </kbd>
    ))}
  </DropdownMenuShortcut>
);

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

  // 快捷键提示与 App 中的全局监听保持一致(⇧⌘ + 首字母)。
  const items: {
    tab: DockTab;
    label: string;
    icon: LucideIcon;
    shortcut: string;
    on: boolean;
  }[] = [
    {
      tab: "preview",
      label: LL.dock_preview(),
      icon: FileText,
      shortcut: "⇧⌘P",
      on: true,
    },
    {
      tab: "search",
      label: LL.dock_search(),
      icon: Search,
      shortcut: "⇧⌘F",
      on: true,
    },
    {
      tab: "trash",
      label: LL.dock_trash(),
      icon: Trash2,
      shortcut: "⇧⌘T",
      on: true,
    },
    {
      tab: "subagent",
      label: LL.dock_subagent(),
      icon: Bot,
      shortcut: "⇧⌘A",
      on: hasSubagent,
    },
    {
      tab: "diff",
      label: LL.dock_diff(),
      icon: GitCompareArrows,
      shortcut: "⇧⌘D",
      on: isGitRepo,
    },
    {
      tab: "web",
      label: LL.dock_web(),
      icon: Globe,
      shortcut: "⇧⌘W",
      on: true,
    },
  ];

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={LL.dock_menu()}
          title={LL.dock_menu()}
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
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {items.map((item) => {
          const active = dockOpen && activeTab === item.tab;
          const Icon = item.icon;
          return (
            <DropdownMenuItem
              key={item.tab}
              disabled={!item.on}
              onClick={() => {
                onSelect(item.tab);
                setOpen(false);
              }}
              className={cn(
                "gap-3 text-xs",
                !item.on
                  ? "cursor-not-allowed text-muted-foreground/40"
                  : active
                    ? "text-primary hover:bg-accent"
                    : "text-foreground hover:bg-accent",
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </span>
              <DockShortcut
                active={active}
                dimmed={!item.on}
                shortcut={item.shortcut}
                tab={item.tab}
              />
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

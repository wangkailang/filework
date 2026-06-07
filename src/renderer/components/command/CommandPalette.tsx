// ⌘K 命令面板:聚合常用动作(新对话 / Dock 各标签 / 设置 / 切换工作区)。
// 复用 App 传入的 handler 与 ChatSession 的 handleNewChat;⌘K 全局开关,键盘可达。
import {
  Bot,
  FileText,
  FolderOpen,
  GitCompareArrows,
  Globe,
  type LucideIcon,
  MessageSquarePlus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { useChatSessionLite } from "../chat/ChatSessionProvider";
import type { DockTab } from "../dock/ContextDock";

interface Command {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
}

export const CommandPalette = ({
  isGitRepo,
  hasSubagent,
  onOpenDockTab,
  onOpenSettings,
  onSwitchWorkspace,
}: {
  isGitRepo: boolean;
  hasSubagent: boolean;
  onOpenDockTab: (t: DockTab) => void;
  onOpenSettings: () => void;
  onSwitchWorkspace: () => void;
}) => {
  const { LL } = useI18nContext();
  const { handleNewChat } = useChatSessionLite();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K 全局开关
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 打开时清空查询、聚焦输入
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const wrap = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const list: Command[] = [
      {
        id: "new-chat",
        label: LL.session_newChat(),
        icon: MessageSquarePlus,
        run: wrap(handleNewChat),
      },
      {
        id: "preview",
        label: LL.dock_preview(),
        icon: FileText,
        run: wrap(() => onOpenDockTab("preview")),
      },
      {
        id: "search",
        label: LL.dock_search(),
        icon: Search,
        run: wrap(() => onOpenDockTab("search")),
      },
      {
        id: "trash",
        label: LL.dock_trash(),
        icon: Trash2,
        run: wrap(() => onOpenDockTab("trash")),
      },
    ];
    if (hasSubagent) {
      list.push({
        id: "subagent",
        label: LL.dock_subagent(),
        icon: Bot,
        run: wrap(() => onOpenDockTab("subagent")),
      });
    }
    if (isGitRepo) {
      list.push({
        id: "diff",
        label: LL.dock_diff(),
        icon: GitCompareArrows,
        run: wrap(() => onOpenDockTab("diff")),
      });
    }
    // 网页面板对所有工作区可用(含非 git)。
    list.push({
      id: "web",
      label: LL.dock_web(),
      icon: Globe,
      run: wrap(() => onOpenDockTab("web")),
    });
    list.push({
      id: "settings",
      label: LL.topbar_settings(),
      icon: Settings,
      run: wrap(onOpenSettings),
    });
    list.push({
      id: "switch-ws",
      label: LL.cmdk_switchWorkspace(),
      icon: FolderOpen,
      run: wrap(onSwitchWorkspace),
    });
    return list;
  }, [
    LL,
    handleNewChat,
    hasSubagent,
    isGitRepo,
    onOpenDockTab,
    onOpenSettings,
    onSwitchWorkspace,
  ]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  // 命中数变化时夹紧选中索引
  useEffect(() => {
    setIndex((p) => (p >= filtered.length ? 0 : p));
  }, [filtered.length]);

  // 选中项滚动到可视区
  useEffect(() => {
    const el = listRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((p) => (p + 1) % Math.max(filtered.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((p) => (p <= 0 ? Math.max(filtered.length - 1, 0) : p - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[index]?.run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 遮罩点击关闭是弹层标准做法
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/40 pt-[15vh]"
      onMouseDown={() => setOpen(false)}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 阻止冒泡到遮罩 */}
      <div
        className="w-full max-w-lg animate-in fade-in-0 zoom-in-95 overflow-hidden rounded-lg border border-border bg-popover shadow-2xl duration-150"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border-faint px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={LL.cmdk_placeholder()}
            className="w-full bg-transparent py-3 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center font-mono text-xs text-muted-foreground">
              {LL.cmdk_empty()}
            </div>
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseEnter={() => setIndex(i)}
                  onClick={cmd.run}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                    i === index
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {cmd.label}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

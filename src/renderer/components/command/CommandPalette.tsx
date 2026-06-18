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
import { useEffect, useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { useChatSessionLite } from "../chat/ChatSessionProvider";
import type { DockTab } from "../dock/ContextDock";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../ui/command";

interface PaletteCommand {
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

  const commands = useMemo<PaletteCommand[]>(() => {
    const wrap = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const list: PaletteCommand[] = [
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

  if (!open) return null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title={LL.cmdk_placeholder()}
      description={LL.cmdk_empty()}
      className="border border-border bg-popover shadow-2xl"
    >
      <Command loop>
        <CommandInput placeholder={LL.cmdk_placeholder()} />
        <CommandList>
          <CommandEmpty>{LL.cmdk_empty()}</CommandEmpty>
          <CommandGroup>
            {commands.map((cmd) => {
              const Icon = cmd.icon;
              const shortcut =
                cmd.id === "new-chat"
                  ? "⌘N"
                  : cmd.id === "preview"
                    ? "⇧⌘P"
                    : cmd.id === "search"
                      ? "⇧⌘F"
                      : cmd.id === "trash"
                        ? "⇧⌘T"
                        : cmd.id === "subagent"
                          ? "⇧⌘A"
                          : cmd.id === "diff"
                            ? "⇧⌘D"
                            : cmd.id === "web"
                              ? "⇧⌘W"
                              : cmd.id === "settings"
                                ? "⌘,"
                                : undefined;
              return (
                <CommandItem
                  key={cmd.id}
                  value={cmd.label}
                  onSelect={cmd.run}
                  className="text-muted-foreground data-[selected=true]:text-foreground"
                >
                  <Icon className="size-4 shrink-0" />
                  <span>{cmd.label}</span>
                  {shortcut ? (
                    <CommandShortcut>{shortcut}</CommandShortcut>
                  ) : null}
                </CommandItem>
              );
            })}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
};

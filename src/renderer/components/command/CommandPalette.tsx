// ⌘K 命令面板:聚合常用动作(新对话 / Dock 各标签 / 设置 / 切换工作区)。
// 复用 App 传入的 handler 与 ChatSession 的 handleNewChat;⌘K 全局开关,键盘可达。
import {
  Bot,
  FileText,
  FolderOpen,
  GitCompareArrows,
  Globe,
  Loader2,
  type LucideIcon,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
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

interface QuickOpenFile {
  name: string;
  relPath: string;
}

const joinWorkspacePath = (root: string, relPath: string): string =>
  root.endsWith("/") ? `${root}${relPath}` : `${root}/${relPath}`;

export const CommandPalette = ({
  isGitRepo,
  hasSubagent,
  onOpenDockTab,
  onOpenFile,
  onOpenSettings,
  onSwitchWorkspace,
  workspaceRoot,
}: {
  isGitRepo: boolean;
  hasSubagent: boolean;
  onOpenDockTab: (t: DockTab) => void;
  onOpenFile: (path: string) => void;
  onOpenSettings: () => void;
  onSwitchWorkspace: () => void;
  workspaceRoot: string;
}) => {
  const { LL } = useI18nContext();
  const { handleNewChat, handleSelectSession, sessions } = useChatSessionLite();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [fileHits, setFileHits] = useState<QuickOpenFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);

  // ⌘K 打开完整命令面板;⌘P 复用同一入口快速打开任务或文件。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        (key === "k" || key === "p")
      ) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!open || normalizedQuery.length < 2) {
      setFileHits([]);
      setFilesLoading(false);
      return;
    }

    let cancelled = false;
    setFilesLoading(true);
    const timer = window.setTimeout(() => {
      window.filework
        .searchFiles(workspaceRoot, normalizedQuery, { limit: 8 })
        .then((result) => {
          if (!cancelled) setFileHits(result.hits);
        })
        .catch(() => {
          if (!cancelled) setFileHits([]);
        })
        .finally(() => {
          if (!cancelled) setFilesLoading(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, workspaceRoot]);

  const setPaletteOpen = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setFileHits([]);
      setFilesLoading(false);
    }
  }, []);

  const runAndClose = useCallback(
    (fn: () => void) => {
      setPaletteOpen(false);
      fn();
    },
    [setPaletteOpen],
  );

  const commands = useMemo<PaletteCommand[]>(() => {
    const wrap = (fn: () => void) => () => runAndClose(fn);
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
    runAndClose,
  ]);

  if (!open) return null;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setPaletteOpen}
      title={LL.cmdk_placeholder()}
      description={LL.cmdk_empty()}
      className="border border-border bg-popover shadow-2xl"
    >
      <Command loop>
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={LL.cmdk_placeholder()}
        />
        <CommandList>
          <CommandEmpty>
            {filesLoading ? LL.cmdk_searching() : LL.cmdk_empty()}
          </CommandEmpty>
          <CommandGroup heading={LL.cmdk_actions()}>
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
          {sessions.length > 0 && (
            <CommandGroup heading={LL.cmdk_tasks()}>
              {sessions
                .filter((session) => !session.automationRun)
                .slice(0, 12)
                .map((session) => (
                  <CommandItem
                    key={session.id}
                    value={`task ${session.title}`}
                    onSelect={() =>
                      runAndClose(() => handleSelectSession(session.id))
                    }
                    className="text-muted-foreground data-[selected=true]:text-foreground"
                  >
                    <MessageSquare className="size-4 shrink-0" />
                    <span className="truncate">{session.title}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          )}
          {(fileHits.length > 0 || filesLoading) && (
            <CommandGroup heading={LL.cmdk_files()}>
              {filesLoading && fileHits.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  {LL.cmdk_searching()}
                </div>
              ) : (
                fileHits.map((file) => (
                  <CommandItem
                    key={file.relPath}
                    value={`file ${file.name} ${file.relPath}`}
                    onSelect={() =>
                      runAndClose(() =>
                        onOpenFile(
                          joinWorkspacePath(workspaceRoot, file.relPath),
                        ),
                      )
                    }
                    className="text-muted-foreground data-[selected=true]:text-foreground"
                  >
                    <FileText className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">
                        {file.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {file.relPath}
                      </span>
                    </span>
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
};

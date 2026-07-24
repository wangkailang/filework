// 常驻会话列表(由原 SessionList 浮层提升到左栏)。从低频切片
// useChatSessionLite 取数据,流式期间不随 messages 重渲。
// 列表按更新时间分段(今天/昨天/近 7 天/近 30 天/更早),每项显示
// 相对时间,并支持双击或点铅笔图标就地重命名。
import {
  AlertCircle,
  Check,
  GitBranch,
  Loader2,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { useChatSessionLite } from "../chat/ChatSessionProvider";
import type { SessionRunStateMap } from "../chat/session-run-state";
import type { ChatSession } from "../chat/types";
import { Dialog, DialogContent, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

type BucketKey =
  | "attention"
  | "today"
  | "yesterday"
  | "week"
  | "month"
  | "earlier";

const DAY_MS = 86_400_000;
const PREVIEW_WIDTH = 320;
const PREVIEW_MARGIN = 12;

// 按 updatedAt 落到对应分段(sessions 已由持久化层按时间倒序给出)。
function bucketOf(iso: string, startOfToday: number): BucketKey {
  const t = new Date(iso).getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfToday - DAY_MS) return "yesterday";
  if (t >= startOfToday - 7 * DAY_MS) return "week";
  if (t >= startOfToday - 30 * DAY_MS) return "month";
  return "earlier";
}

// 今天/昨天只显示时分,更久的补上日期(按当前语言本地化,中/日为
// "6月1日",英文为 "Jun 1")。
function formatStamp(iso: string, bucket: BucketKey, locale: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  if (bucket === "today" || bucket === "yesterday") return time;
  const date = d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
  return `${date} ${time}`;
}

function formatAge(iso: string, nowMs: number, locale: string): string {
  const elapsed = Math.max(0, nowMs - new Date(iso).getTime());
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const unit =
    locale.startsWith("zh") || locale.startsWith("ja")
      ? {
          now: locale.startsWith("ja") ? "たった今" : "刚刚",
          minute: locale.startsWith("ja") ? "分" : "分钟",
          hour: locale.startsWith("ja") ? "時間" : "小时",
          day: locale.startsWith("ja") ? "日" : "天",
        }
      : {
          now: "now",
          minute: "min",
          hour: "h",
          day: "d",
        };

  if (elapsed < minute) return unit.now;
  if (elapsed < hour) return `${Math.floor(elapsed / minute)} ${unit.minute}`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)} ${unit.hour}`;
  return `${Math.floor(elapsed / day)} ${unit.day}`;
}

type SessionPreview = {
  session: ChatSession;
  absoluteStamp: string;
  left: number;
  top: number;
};

const AUTOMATION_TITLE_PREFIXES = [
  /^Run automation now:\s*/i,
  /^现在执行自动化[：:]\s*/,
  /^执行自动化[：:]\s*/,
];

const isAutomationSession = (session: ChatSession): boolean => {
  if (session.automationRun) return true;
  return AUTOMATION_TITLE_PREFIXES.some((prefix) => prefix.test(session.title));
};

export type HistoryFilter = "all" | "attention" | "duplicates" | "empty";

const EMPTY_SESSION_TITLES = new Set([
  "",
  "new chat",
  "新对话",
  "新しいチャット",
]);

const normalizeSessionTitle = (title: string, locale: string): string =>
  title.trim().replace(/\s+/g, " ").toLocaleLowerCase(locale);

const isEmptySession = (session: ChatSession, locale: string): boolean =>
  EMPTY_SESSION_TITLES.has(normalizeSessionTitle(session.title, locale));

export const filterHistorySessions = (
  sessions: ChatSession[],
  filter: HistoryFilter,
  sessionRunStates: SessionRunStateMap,
  locale: string,
): ChatSession[] => {
  if (filter === "all") return sessions;
  if (filter === "attention") {
    return sessions.filter((session) => sessionRunStates[session.id] != null);
  }
  if (filter === "empty") {
    return sessions.filter((session) => isEmptySession(session, locale));
  }

  const titleCounts = new Map<string, number>();
  for (const session of sessions) {
    if (isEmptySession(session, locale)) continue;
    const title = normalizeSessionTitle(session.title, locale);
    titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return sessions.filter((session) => {
    if (isEmptySession(session, locale)) return false;
    return (
      (titleCounts.get(normalizeSessionTitle(session.title, locale)) ?? 0) > 1
    );
  });
};

const sessionBranchOf = (session: ChatSession): string | null => {
  const branch = session.lastActiveBranch?.trim();
  return branch ? branch : null;
};

export const ChatHistoryPanel = ({
  isGitRepo = false,
}: {
  isGitRepo?: boolean;
}) => {
  const { LL, locale } = useI18nContext();
  const chat = useChatSessionLite();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HistoryFilter>("all");
  // 待二次确认删除的会话(null 表示无弹框)。
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);
  const projectSessions = useMemo(
    () => chat.sessions.filter((session) => !isAutomationSession(session)),
    [chat.sessions],
  );
  const governedSessions = useMemo(
    () =>
      filterHistorySessions(
        projectSessions,
        filter,
        chat.sessionRunStates,
        locale,
      ),
    [chat.sessionRunStates, filter, locale, projectSessions],
  );
  const matchingSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase(locale);
    if (!normalizedQuery) return governedSessions;
    return governedSessions.filter((session) =>
      session.title.toLocaleLowerCase(locale).includes(normalizedQuery),
    );
  }, [governedSessions, locale, query]);

  const groups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const order: BucketKey[] = [
      "attention",
      "today",
      "yesterday",
      "week",
      "month",
      "earlier",
    ];
    const map = new Map<BucketKey, ChatSession[]>();
    const sorted = [...matchingSessions].sort((a, b) => {
      const byUpdatedAt =
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (byUpdatedAt !== 0) return byUpdatedAt;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    for (const s of sorted) {
      const status = chat.sessionRunStates[s.id]?.status;
      const needsAttention =
        status === "pending" || status === "running" || status === "unread";
      const k: BucketKey = needsAttention
        ? "attention"
        : bucketOf(s.updatedAt, startOfToday);
      const arr = map.get(k);
      if (arr) arr.push(s);
      else map.set(k, [s]);
    }
    return order
      .map((key) => ({ key, items: map.get(key) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [chat.sessionRunStates, matchingSessions]);

  const groupLabel: Record<BucketKey, () => string> = {
    attention: LL.session_group_attention,
    today: LL.session_group_today,
    yesterday: LL.session_group_yesterday,
    week: LL.session_group_week,
    month: LL.session_group_month,
    earlier: LL.session_group_earlier,
  };

  const startRename = (s: ChatSession) => {
    setEditingId(s.id);
    setDraft(s.title);
  };

  const commitRename = (id: string) => {
    if (editingId !== id) return;
    chat.handleRenameSession(id, draft);
    setEditingId(null);
  };

  const cancelRename = () => setEditingId(null);
  const hidePreview = () => setPreview(null);
  const previewBranch = preview ? sessionBranchOf(preview.session) : null;
  const filters: Array<{ id: HistoryFilter; label: string }> = [
    { id: "all", label: LL.session_filter_all() },
    { id: "attention", label: LL.session_filter_attention() },
    { id: "duplicates", label: LL.session_filter_duplicates() },
    { id: "empty", label: LL.session_filter_empty() },
  ];

  const showPreview = (
    session: ChatSession,
    absoluteStamp: string,
    element: HTMLElement,
  ) => {
    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    setPreview({
      session,
      absoluteStamp,
      left: Math.min(
        rect.right + 8,
        Math.max(
          PREVIEW_MARGIN,
          viewportWidth - PREVIEW_WIDTH - PREVIEW_MARGIN,
        ),
      ),
      top: Math.min(
        Math.max(rect.top + rect.height / 2, PREVIEW_MARGIN),
        viewportHeight - PREVIEW_MARGIN,
      ),
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1.5 px-2 pt-2">
        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            data-session-search="true"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={LL.session_search()}
            placeholder={LL.session_search()}
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
          />
        </div>
        <fieldset
          className="flex gap-1 overflow-x-auto pb-0.5"
          aria-label={LL.session_filter_label()}
        >
          {filters.map((item) => (
            <button
              key={item.id}
              type="button"
              data-session-filter={item.id}
              aria-pressed={filter === item.id}
              onClick={() => setFilter(item.id)}
              className={cn(
                "h-6 shrink-0 rounded-md px-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                filter === item.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/70 hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="mt-1 flex-1 overflow-y-auto" onScroll={hidePreview}>
        {projectSessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {LL.session_empty()}
          </div>
        ) : groups.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {LL.session_searchEmpty()}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              <div className="sticky top-0 z-10 bg-background/95 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur">
                {groupLabel[group.key]()}
              </div>
              {group.items.map((s) => {
                const isEditing = editingId === s.id;
                const runState = chat.sessionRunStates[s.id];
                const absoluteStamp = formatStamp(
                  s.updatedAt,
                  group.key,
                  locale,
                );
                const relativeAge = formatAge(s.updatedAt, Date.now(), locale);
                const sessionBranch = sessionBranchOf(s);
                const runStateLabel =
                  runState?.status === "pending"
                    ? LL.task_pending()
                    : runState?.status === "running"
                      ? LL.task_running()
                      : runState?.status === "unread"
                        ? LL.session_unread()
                        : null;
                return (
                  <div
                    key={s.id}
                    data-session-row={s.id}
                    data-session-age={relativeAge}
                    className={cn(
                      "group relative flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-accent active:bg-accent/80",
                      s.id === chat.activeSessionId &&
                        "bg-accent shadow-[inset_2px_0_0_var(--color-primary)]",
                    )}
                  >
                    {isEditing ? (
                      <div className="min-w-0 flex-1">
                        <input
                          // biome-ignore lint/a11y/noAutofocus: 进入编辑态需立即聚焦
                          autoFocus
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename(s.id);
                            else if (e.key === "Escape") cancelRename();
                          }}
                          onBlur={() => commitRename(s.id)}
                          className="w-full rounded border border-input bg-background px-1.5 py-0.5 text-sm text-foreground outline-none focus:border-primary"
                        />
                        <div className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                          {absoluteStamp}
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => chat.handleSelectSession(s.id)}
                        onDoubleClick={() => startRename(s)}
                        onPointerEnter={(event) =>
                          showPreview(s, absoluteStamp, event.currentTarget)
                        }
                        onPointerLeave={hidePreview}
                        onFocus={(event) =>
                          showPreview(s, absoluteStamp, event.currentTarget)
                        }
                        onBlur={hidePreview}
                      >
                        <span className="truncate text-sm font-medium text-foreground">
                          {s.title}
                        </span>
                        <div
                          data-session-row-meta={s.id}
                          className="ml-auto inline-flex h-5 shrink-0 items-center justify-end text-xs tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                        >
                          {runState && runStateLabel ? (
                            <span
                              data-session-run-status={runState.status}
                              className="inline-flex shrink-0 items-center justify-center text-primary"
                              role="img"
                              aria-label={runStateLabel}
                              title={runStateLabel}
                            >
                              {runState.status === "unread" ? (
                                <span
                                  className="size-2.5 rounded-full bg-primary ring-2 ring-primary/20"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Loader2
                                  className="size-4 animate-spin"
                                  aria-hidden="true"
                                />
                              )}
                            </span>
                          ) : (
                            relativeAge
                          )}
                        </div>
                      </button>
                    )}
                    {isEditing ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          // onMouseDown 抢在 input 的 onBlur 之前,避免提交两次
                          onMouseDown={(e) => {
                            e.preventDefault();
                            commitRename(s.id);
                          }}
                          className="p-1 text-muted-foreground hover:text-primary"
                          aria-label={LL.session_rename()}
                        >
                          <Check className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            cancelRename();
                          }}
                          className="p-1 text-muted-foreground hover:text-destructive"
                          aria-label={LL.session_close()}
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div
                        data-session-row-actions={s.id}
                        className="absolute top-1/2 right-2 z-20 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button
                              type="button"
                              data-session-action-menu={s.id}
                              className="flex size-7 items-center justify-center rounded-md bg-background/85 text-muted-foreground shadow-sm outline-none hover:bg-accent hover:text-foreground active:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={LL.session_actions()}
                            >
                              <MoreHorizontal
                                className="size-3.5"
                                aria-hidden="true"
                              />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-36">
                            <DropdownMenuItem onSelect={() => startRename(s)}>
                              <Pencil className="size-3.5" />
                              {LL.session_rename()}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onSelect={() => setPendingDelete(s)}
                            >
                              <Trash2 className="size-3.5" />
                              {LL.session_delete()}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                    {!isEditing && isGitRepo && sessionBranch && (
                      <span
                        className="sr-only"
                        data-session-branch={sessionBranch}
                      >
                        {LL.session_branch_current()}: {sessionBranch}.{" "}
                        {LL.session_branch_hint()}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {preview && (
        <div
          className="pointer-events-none fixed z-50 w-80 -translate-y-1/2 rounded-lg border border-border bg-popover px-4 py-3 text-popover-foreground shadow-xl"
          style={{ left: preview.left, top: preview.top }}
        >
          <div className="flex items-start justify-between gap-4">
            <span className="min-w-0 truncate text-sm font-semibold">
              {preview.session.title}
            </span>
            <div className="shrink-0 text-xs text-muted-foreground">
              {preview.absoluteStamp}
            </div>
          </div>
          {isGitRepo && previewBranch && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <GitBranch
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">{LL.session_branch_current()}</span>
                <span>{previewBranch}</span>
              </div>
              <div className="flex gap-2 text-sm font-medium text-status-await">
                <AlertCircle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />
                <span>{LL.session_branch_hint()}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        {pendingDelete && (
          <DialogContent className="gap-0! overflow-hidden bg-background! p-0! text-foreground! shadow-lg w-full! max-w-sm!">
            <div className="border-b border-border px-4 py-3">
              <DialogTitle className="pr-8 text-sm font-medium">
                {LL.session_delete_confirm_title()}
              </DialogTitle>
            </div>
            <div className="space-y-2 px-4 py-3 text-sm">
              <p className="text-muted-foreground">
                {LL.session_delete_confirm_desc()}
              </p>
              <p className="truncate font-medium text-foreground">
                {pendingDelete.title}
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                {LL.session_cancel()}
              </button>
              <button
                type="button"
                onClick={() => {
                  chat.handleDeleteSession(pendingDelete.id);
                  setPendingDelete(null);
                }}
                className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:opacity-90"
              >
                {LL.session_confirm()}
              </button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
};

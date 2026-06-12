// 常驻会话列表(由原 SessionList 浮层提升到左栏)。从低频切片
// useChatSessionLite 取数据,流式期间不随 messages 重渲。
// 列表按更新时间分段(今天/昨天/近 7 天/近 30 天/更早),每项显示
// 相对时间,并支持双击或点铅笔图标就地重命名。
import {
  AlertCircle,
  Check,
  GitBranch,
  Loader2,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import { useChatSessionLite } from "../chat/ChatSessionProvider";
import type { ChatSession } from "../chat/types";

type BucketKey = "today" | "yesterday" | "week" | "month" | "earlier";

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

export const ChatHistoryPanel = ({
  currentBranch = null,
  isGitRepo = false,
}: {
  currentBranch?: string | null;
  isGitRepo?: boolean;
}) => {
  const { LL, locale } = useI18nContext();
  const chat = useChatSessionLite();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // 待二次确认删除的会话(null 表示无弹框)。
  const [pendingDelete, setPendingDelete] = useState<ChatSession | null>(null);
  const [preview, setPreview] = useState<SessionPreview | null>(null);

  const groups = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const order: BucketKey[] = [
      "today",
      "yesterday",
      "week",
      "month",
      "earlier",
    ];
    const map = new Map<BucketKey, ChatSession[]>();
    const sorted = [...chat.sessions].sort((a, b) => {
      const byUpdatedAt =
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      if (byUpdatedAt !== 0) return byUpdatedAt;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    for (const s of sorted) {
      const k = bucketOf(s.updatedAt, startOfToday);
      const arr = map.get(k);
      if (arr) arr.push(s);
      else map.set(k, [s]);
    }
    return order
      .map((key) => ({ key, items: map.get(key) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [chat.sessions]);

  const groupLabel: Record<BucketKey, () => string> = {
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

  // 删除确认弹框开启时,Esc 关闭。
  useEffect(() => {
    if (!pendingDelete) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendingDelete(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [pendingDelete]);

  return (
    <div className="flex h-full flex-col">
      <div className="mt-2 flex-1 overflow-y-auto" onScroll={hidePreview}>
        {chat.sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {LL.session_empty()}
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
                      "group relative flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-accent",
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
                        className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-left"
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
                        <div className="truncate text-sm font-medium text-foreground">
                          {s.title}
                        </div>
                        <div
                          data-session-row-meta={s.id}
                          className="ml-auto inline-flex h-5 shrink-0 items-center justify-end text-xs tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0"
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
                        className="absolute top-1/2 right-3 z-20 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startRename(s);
                          }}
                          className="p-1 text-muted-foreground hover:text-foreground"
                          aria-label={LL.session_rename()}
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDelete(s);
                          }}
                          className="p-1 text-muted-foreground hover:text-destructive"
                          aria-label={LL.session_delete()}
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    )}
                    {!isEditing && isGitRepo && currentBranch && (
                      <span
                        className="sr-only"
                        data-session-branch={currentBranch}
                      >
                        {LL.session_branch_current()}: {currentBranch}.{" "}
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
            <div className="min-w-0 truncate text-sm font-semibold">
              {preview.session.title}
            </div>
            <div className="shrink-0 text-xs text-muted-foreground">
              {preview.absoluteStamp}
            </div>
          </div>
          {isGitRepo && currentBranch && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 text-sm text-foreground">
                <GitBranch
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="sr-only">{LL.session_branch_current()}</span>
                <span>{currentBranch}</span>
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

      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-black/50 animate-in fade-in-0 duration-150"
            onClick={() => setPendingDelete(null)}
            aria-label={LL.session_cancel()}
          />
          <div className="relative w-full max-w-sm rounded-lg border border-border bg-background shadow-lg animate-in fade-in-0 zoom-in-95 duration-150">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-medium">
                {LL.session_delete_confirm_title()}
              </h2>
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
          </div>
        </div>
      )}
    </div>
  );
};

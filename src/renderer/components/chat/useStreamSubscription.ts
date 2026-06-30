import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PlanView } from "../../../main/core/session/message-parts";
import { useI18nContext } from "../../i18n/i18n-react";
import type { ApprovalState } from "../ai-elements/confirmation";
import { buildTurnSummary } from "./buildTurnSummary";
import {
  readContextCompressionDetail,
  upsertContextCompressedPart,
} from "./context-compression-part";
import { contentFromParts } from "./helpers";
import type { SkillApprovalData } from "./SkillApprovalDialog";
import type {
  ActiveSkillInfo,
  ArticleMetaPart,
  ChatMessage,
  ErrorPart,
  ImageGalleryPart,
  ImagePart,
  MessagePart,
  PlanMessagePart,
  ReasoningPart,
  SubagentChildView,
  SubagentMessagePart,
  ToolApproval,
  ToolPart,
  UsagePart,
  VideoGalleryPart,
  VideoJobPart,
} from "./types";

// Cap displayed gallery to keep DOM weight in check; remote image grids
// past this start to feel like a slideshow more than an inline result.
const MAX_GALLERY_IMAGES = 12;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

/**
 * Pull image URLs out of a `webSearch` / `webFetch` tool result and
 * shape them for `ImageGalleryPart`. Tolerates both shapes that the
 * tools currently produce:
 *   - webSearch: `images: Array<{ url, description? } | string>`
 *   - webFetch / webFetchRendered: `images: string[]` (from web-extract)
 * Returns null when nothing usable is present.
 */
function extractGalleryFromToolResult(
  toolName: string,
  result: unknown,
  args: unknown,
): ImageGalleryPart | null {
  if (!isRecord(result)) return null;
  const rawImages = result.images;
  if (!Array.isArray(rawImages) || rawImages.length === 0) return null;

  const seen = new Set<string>();
  const images: ImageGalleryPart["images"] = [];
  for (const entry of rawImages) {
    let url: string | undefined;
    let description: string | undefined;
    if (typeof entry === "string") {
      url = entry;
    } else if (isRecord(entry) && typeof entry.url === "string") {
      url = entry.url;
      if (typeof entry.description === "string" && entry.description.trim()) {
        description = entry.description;
      }
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const item: ImageGalleryPart["images"][number] = description
      ? { url, description }
      : { url };
    images.push(item);
    if (images.length >= MAX_GALLERY_IMAGES) break;
  }
  if (images.length === 0) return null;

  let source: ImageGalleryPart["source"] = "other";
  if (toolName === "webSearch") source = "web-search";
  else if (toolName === "webFetch" || toolName === "webFetchRendered")
    source = "web-fetch";

  // For webFetch the source page is the URL itself — fan out to each image.
  let pageUrl: string | undefined;
  if (source === "web-fetch") {
    const resultUrl = typeof result.url === "string" ? result.url : undefined;
    const argsUrl =
      isRecord(args) && typeof args.url === "string" ? args.url : undefined;
    pageUrl = resultUrl ?? argsUrl;
    if (pageUrl) {
      for (const img of images) {
        img.sourceUrl = pageUrl;
      }
    }
  }

  let context: string | undefined;
  if (
    source === "web-search" &&
    isRecord(args) &&
    typeof args.query === "string"
  ) {
    context = args.query;
  } else if (source === "web-fetch") {
    context = pageUrl;
  }

  return { type: "image-gallery", source, context, images };
}

const MAX_VIDEO_GALLERY = 8;

/**
 * Same idea as `extractGalleryFromToolResult` but for the `videos`
 * side-channel webFetch / webFetchRendered now produce. Tolerates both
 * shapes the renderer might see:
 *   - new: `[{ url, provider?, poster?, title? }]`
 *   - bare: `string[]` (defensive — older agent runs may shortcut here)
 */
function extractVideoGalleryFromToolResult(
  toolName: string,
  result: unknown,
  args: unknown,
): VideoGalleryPart | null {
  if (!isRecord(result)) return null;
  if (toolName !== "webFetch" && toolName !== "webFetchRendered") return null;
  const rawVideos = result.videos;
  if (!Array.isArray(rawVideos) || rawVideos.length === 0) return null;

  const seen = new Set<string>();
  const videos: VideoGalleryPart["videos"] = [];
  for (const entry of rawVideos) {
    let url: string | undefined;
    let provider: string | undefined;
    let poster: string | undefined;
    let title: string | undefined;
    if (typeof entry === "string") {
      url = entry;
    } else if (isRecord(entry) && typeof entry.url === "string") {
      url = entry.url;
      if (typeof entry.provider === "string") provider = entry.provider;
      if (typeof entry.poster === "string") poster = entry.poster;
      if (typeof entry.title === "string" && entry.title.trim())
        title = entry.title;
    }
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    videos.push({ url, provider, poster, title });
    if (videos.length >= MAX_VIDEO_GALLERY) break;
  }
  if (videos.length === 0) return null;

  const resultUrl = typeof result.url === "string" ? result.url : undefined;
  const argsUrl =
    isRecord(args) && typeof args.url === "string" ? args.url : undefined;
  const pageUrl = resultUrl ?? argsUrl;
  if (pageUrl) {
    for (const v of videos) v.sourceUrl = pageUrl;
  }
  return {
    type: "video-gallery",
    source: "web-fetch",
    context: pageUrl,
    videos,
  };
}

/**
 * Pull a small set of header-style fields out of `result.meta` produced
 * by the web tools. Returns null when nothing user-visible is present
 * (we don't want to render an empty strip just for `lang` or `favicon`
 * — at least one of byline / siteName / publishedTime must be set).
 */
function extractArticleMetaFromToolResult(
  toolName: string,
  result: unknown,
  args: unknown,
): ArticleMetaPart | null {
  if (!isRecord(result)) return null;
  if (
    toolName !== "webFetch" &&
    toolName !== "webFetchRendered" &&
    toolName !== "webScrape"
  )
    return null;
  const meta = result.meta;
  if (!isRecord(meta)) return null;

  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v : undefined;

  const byline = str(meta.byline);
  const siteName = str(meta.siteName);
  const publishedTime = str(meta.publishedTime);
  if (!byline && !siteName && !publishedTime) return null;

  const lang = str(meta.lang);
  const favicon = str(meta.favicon);
  const resultUrl = typeof result.url === "string" ? result.url : undefined;
  const argsUrl =
    isRecord(args) && typeof args.url === "string" ? args.url : undefined;
  const canonical = str(meta.canonical);
  const pageUrl = canonical ?? resultUrl ?? argsUrl;

  return {
    type: "article-meta",
    pageUrl,
    meta: { byline, siteName, publishedTime, lang, favicon },
  };
}

import type { RunningTaskRoute } from "./session-run-state";
import { finalizePartsForSettledTask } from "./stream-finalize";
import type { RetryInfo, StreamErrorInfo, UsageInfo } from "./useChatSession";

interface StreamSubscriptionDeps {
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  updateSessionMessages: (
    sessionId: string,
    updater: (prev: ChatMessage[]) => ChatMessage[],
  ) => ChatMessage[];
  setLastUsage: React.Dispatch<React.SetStateAction<UsageInfo | null>>;
  setLastError: React.Dispatch<React.SetStateAction<StreamErrorInfo | null>>;
  debouncedSave: (msgs: ChatMessage[], sessionId: string) => void;
  activeSessionIdRef: MutableRefObject<string | null>;
  onTaskStarted?: (task: RunningTaskRoute) => void;
  onTaskSettled?: (taskId: string) => void;
}

export function useStreamSubscription({
  setMessages,
  updateSessionMessages,
  setLastUsage,
  setLastError,
  debouncedSave,
  activeSessionIdRef,
  onTaskStarted,
  onTaskSettled,
}: StreamSubscriptionDeps) {
  const { LL } = useI18nContext();
  const [isLoading, setIsLoading] = useState(false);
  const [activeSkill, setActiveSkill] = useState<ActiveSkillInfo | null>(null);
  const [pendingSkillApproval, setPendingSkillApproval] =
    useState<SkillApprovalData | null>(null);
  const [retryInfo, setRetryInfo] = useState<RetryInfo | null>(null);
  const [isStalled, setIsStalled] = useState(false);

  const streamTaskIdRef = useRef<string | null>(null);
  const streamAssistantIdRef = useRef<string | null>(null);
  const taskRoutesRef = useRef(
    new Map<string, { sessionId?: string; assistantMessageId?: string }>(),
  );
  // 上次「流式期间」落盘的时间戳,用于节流。重连已由主进程事件日志重放权威负责,
  // 故流式落盘只为进程崩溃兜底,无需每个停顿都全量重写会话文件 —— 限到每 ~5s 一次。
  const lastStreamSaveRef = useRef(new Map<string, number>());
  const streamEventCursorRef = useRef(new Map<string, number>());
  const pendingStopRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const connectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const rememberTaskRoute = useCallback(
    (task: RunningTaskRoute) => {
      taskRoutesRef.current.set(task.taskId, {
        sessionId: task.sessionId,
        assistantMessageId: task.assistantMessageId,
      });
      onTaskStarted?.(task);
    },
    [onTaskStarted],
  );

  useEffect(() => {
    const routeForTask = (taskId: string) => taskRoutesRef.current.get(taskId);

    const canRouteTask = (taskId: string): boolean =>
      taskId === streamTaskIdRef.current || taskRoutesRef.current.has(taskId);

    const offStreamEvent = window.filework.onStreamEvent(({ id, index }) => {
      const nextIndex = index + 1;
      const previous = streamEventCursorRef.current.get(id) ?? 0;
      if (nextIndex > previous) {
        streamEventCursorRef.current.set(id, nextIndex);
      }
    });

    const offStart = window.filework.onStreamStart(
      ({ id, sessionId, assistantMessageId }) => {
        rememberTaskRoute({ taskId: id, sessionId, assistantMessageId });

        const shouldAttach =
          !sessionId || sessionId === activeSessionIdRef.current;
        if (!shouldAttach) return;

        console.log("[Stream Start] Setting taskId:", id);
        streamTaskIdRef.current = id;
        if (assistantMessageId) {
          streamAssistantIdRef.current = assistantMessageId;
        }
        // 重置当前助手消息的 parts。正常新回合消息本就为空(no-op);重连重放时
        // start 是首个事件,借此把盘上加载的部分内容清空,后续重放事件权威重建,
        // 避免与盘上内容叠加重复。
        const assistantId = streamAssistantIdRef.current;
        const targetSessionId = sessionId ?? activeSessionIdRef.current;
        if (assistantId && targetSessionId) {
          updateSessionMessages(targetSessionId, (prev) => {
            const idx = prev.findIndex((m) => m.id === assistantId);
            if (idx === -1) return prev;
            const msg = prev[idx];
            if ((msg.parts?.length ?? 0) === 0 && !msg.content) return prev;
            const updated = [...prev];
            updated[idx] = { ...msg, content: "", parts: [] };
            return updated;
          });
        }
        setIsLoading(true);
        setIsStalled(false);
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        if (pendingStopRef.current) {
          pendingStopRef.current = false;
          window.filework.stopGeneration(id).catch((error) => {
            console.error(
              "[Stop Generation] Failed to stop deferred task:",
              error,
            );
          });
        }
      },
    );

    const offSkillActivated = window.filework.onSkillActivated(
      ({ id, skillId, skillName, source }) => {
        if (id !== streamTaskIdRef.current) return;
        setActiveSkill({ skillId, skillName, source });
      },
    );

    const updateParts = (
      taskId: string,
      updater: (parts: MessagePart[]) => MessagePart[],
    ) => {
      const route = routeForTask(taskId);
      const sessionId = route?.sessionId ?? activeSessionIdRef.current;
      const assistantId =
        route?.assistantMessageId ??
        (taskId === streamTaskIdRef.current
          ? streamAssistantIdRef.current
          : null);
      if (!sessionId || !assistantId) return;

      updateSessionMessages(sessionId, (prev) => {
        const idx = prev.findIndex((m) => m.id === assistantId);
        if (idx === -1) return prev;
        const updated = [...prev];
        const msg = updated[idx];
        const newParts = updater([...(msg.parts ?? [])]);
        updated[idx] = {
          ...msg,
          parts: newParts,
          content: contentFromParts(newParts),
        };
        // 流式期间落盘(崩溃兜底):限到每 ~5s 一次,避免每个工具停顿都全量重写
        // 整份会话文件。重连本身由主进程事件日志重放负责,不依赖此处的盘上部分内容。
        const lastSavedAt = lastStreamSaveRef.current.get(taskId) ?? 0;
        if (Date.now() - lastSavedAt > 5000) {
          lastStreamSaveRef.current.set(taskId, Date.now());
          debouncedSave(updated, sessionId);
        }
        return updated;
      });
    };

    const offDelta = window.filework.onStreamDelta(({ id, delta }) => {
      if (!canRouteTask(id)) return;
      updateParts(id, (parts) => {
        const last = parts[parts.length - 1];
        if (last && last.type === "text") {
          parts[parts.length - 1] = { ...last, text: last.text + delta };
        } else {
          parts.push({ type: "text", text: delta });
        }
        return parts;
      });
    });

    const offMedia = window.filework.onStreamMedia(({ id, part }) => {
      if (!canRouteTask(id)) return;
      updateParts(id, (parts) => {
        parts.push(part as ImagePart | VideoJobPart);
        return parts;
      });
    });

    const offReasoning = window.filework.onStreamReasoning(({ id, delta }) => {
      if (!canRouteTask(id)) return;
      updateParts(id, (parts) => {
        // If an inline plan currently has a `running` step, attach the
        // reasoning delta to that step instead of surfacing it as a
        // top-level ReasoningPart. This keeps the model's thinking
        // scoped to the work it produced (one collapsible per step
        // inside the PlanViewer).
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.type === "plan") {
            const planPart = p as PlanMessagePart;
            const runningIdx = planPart.plan.steps.findIndex(
              (s) => s.status === "running",
            );
            if (runningIdx >= 0) {
              const newSteps = planPart.plan.steps.map((s, idx) =>
                idx === runningIdx
                  ? { ...s, reasoning: (s.reasoning ?? "") + delta }
                  : s,
              );
              parts[i] = {
                type: "plan",
                plan: { ...planPart.plan, steps: newSteps },
              };
              return parts;
            }
            // Plan exists but no running step yet — fall through to the
            // top-level reasoning fallback so deltas aren't dropped.
            break;
          }
          if (p.type === "text" || p.type === "tool") break;
        }
        // Fallback: most recent unfinished reasoning part, else push fresh.
        // Once `done: true` lands (after `reasoning_end`), the next delta
        // starts a fresh block — models can emit multiple reasoning passes
        // (one before each tool call).
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.type === "reasoning" && !p.done) {
            parts[i] = { ...p, text: p.text + delta };
            return parts;
          }
          if (p.type === "text" || p.type === "tool") break;
        }
        parts.push({ type: "reasoning", text: delta });
        return parts;
      });
    });

    const offReasoningEnd = window.filework.onStreamReasoningEnd(({ id }) => {
      if (!canRouteTask(id)) return;
      updateParts(id, (parts) => {
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          if (p.type === "reasoning" && !p.done) {
            parts[i] = { ...(p as ReasoningPart), done: true };
            break;
          }
          if (p.type === "text" || p.type === "tool") break;
        }
        return parts;
      });
    });

    const offToolCall = window.filework.onStreamToolCall(
      ({ id, toolCallId, toolName, args, previewSnapshot }) => {
        if (!canRouteTask(id)) return;
        // `createPlan` is rendered as a single evolving PlanMessagePart
        // (via `ai:stream-plan`). Suppress the generic tool bubble so N
        // status-update calls don't stack as N "完成 createPlan" rows.
        if (toolName === "createPlan") return;
        // `spawnSubagent` is rendered as a SubagentMessagePart (via
        // `ai:subagent-*`). Suppress the generic tool bubble — a fan-out of
        // N children can't fit the single args/result ToolPart shape.
        if (toolName === "spawnSubagent") return;
        updateParts(id, (parts) => {
          const existingIdx = parts.findIndex(
            (p) => p.type === "tool" && p.toolCallId === toolCallId,
          );
          if (existingIdx !== -1) {
            parts[existingIdx] = {
              ...(parts[existingIdx] as ToolPart),
              args,
              ...(previewSnapshot ? { previewSnapshot } : {}),
            };
          } else {
            parts.push({
              type: "tool",
              toolCallId,
              toolName,
              args,
              state: "input-available",
              ...(previewSnapshot ? { previewSnapshot } : {}),
            });
          }
          return parts;
        });
      },
    );

    const offToolResult = window.filework.onStreamToolResult(
      ({ id, toolCallId, result }) => {
        if (!canRouteTask(id)) return;
        updateParts(id, (parts) => {
          const resultObj =
            result != null && typeof result === "object"
              ? (result as Record<string, unknown>)
              : null;
          const isDenied = resultObj?.denied === true;
          // A failed tool call (MCP timeout / not-connected, isError, or any
          // tool returning `{ success: false }`) renders as `output-error`
          // so the bubble shows the failure instead of a misleading "完成".
          // Denied calls keep their own approval-rejected styling.
          const isFailure =
            !isDenied &&
            resultObj != null &&
            (resultObj.success === false || resultObj.isError === true);
          const next = parts.map((p) => {
            if (p.type !== "tool" || p.toolCallId !== toolCallId) return p;
            return {
              ...p,
              result,
              state: isFailure
                ? ("output-error" as const)
                : ("output-available" as const),
              approval: p.approval
                ? {
                    ...p.approval,
                    state: (isDenied
                      ? "approval-rejected"
                      : "approval-accepted") as ApprovalState,
                  }
                : undefined,
            };
          });
          // Auto-surface side-channel info from webSearch / webFetch /
          // webScrape: article-meta strip (author/date/site) first,
          // image gallery, then video gallery — so the rendered order
          // matches how a reader scans an article header. Skipped on
          // denied results.
          if (!isDenied && !isFailure) {
            const toolPart = next.find(
              (p): p is ToolPart =>
                p.type === "tool" && p.toolCallId === toolCallId,
            );
            if (toolPart) {
              const articleMeta = extractArticleMetaFromToolResult(
                toolPart.toolName,
                result,
                toolPart.args,
              );
              if (articleMeta) next.push(articleMeta);
              const imageGallery = extractGalleryFromToolResult(
                toolPart.toolName,
                result,
                toolPart.args,
              );
              if (imageGallery) next.push(imageGallery);
              const videoGallery = extractVideoGalleryFromToolResult(
                toolPart.toolName,
                result,
                toolPart.args,
              );
              if (videoGallery) next.push(videoGallery);
            }
          }
          return next;
        });
      },
    );

    const offToolApproval = window.filework.onStreamToolApproval(
      ({ id, toolCallId, toolName, args, description }) => {
        if (!canRouteTask(id)) return;
        updateParts(id, (parts) => {
          const existingIdx = parts.findIndex(
            (p) => p.type === "tool" && p.toolCallId === toolCallId,
          );
          const approval: ToolApproval = {
            toolCallId,
            toolName,
            description,
            state: "approval-requested",
          };
          if (existingIdx !== -1) {
            parts[existingIdx] = {
              ...(parts[existingIdx] as ToolPart),
              approval,
            };
          } else {
            parts.push({
              type: "tool",
              toolCallId,
              toolName,
              args,
              state: "input-available",
              approval,
            });
          }
          return parts;
        });
      },
    );

    const offToolBatchApproval = window.filework.onStreamToolBatchApproval(
      ({ id, batchId, toolName, entries }) => {
        if (!canRouteTask(id)) return;
        updateParts(id, (parts) => {
          parts.push({
            type: "batch-approval",
            batchId,
            toolName,
            entries,
            state: "approval-requested",
          });
          return parts;
        });
      },
    );

    const offToolBatchAutoApproved =
      window.filework.onStreamToolBatchAutoApproved(({ id, batchId }) => {
        if (!canRouteTask(id)) return;
        updateParts(id, (parts) =>
          parts.map((p) =>
            p.type === "batch-approval" && p.batchId === batchId
              ? { ...p, state: "approval-accepted" as const }
              : p,
          ),
        );
      });

    const offMemoryEvent =
      window.filework.memoryDebug?.onEvent?.(({ taskId, type, detail }) => {
        if (type !== "compression-write" || !canRouteTask(taskId)) return;
        const compression = readContextCompressionDetail(detail);
        updateParts(taskId, (parts) =>
          upsertContextCompressedPart(parts, compression),
        );
      }) ?? (() => {});

    const offDone = window.filework.onStreamDone(
      ({ id, sessionId, assistantMessageId }) => {
        if (sessionId || assistantMessageId) {
          rememberTaskRoute({ taskId: id, sessionId, assistantMessageId });
        }
        if (!canRouteTask(id)) return;

        const route = routeForTask(id);
        const isAttachedTask = id === streamTaskIdRef.current;
        const targetSessionId = route?.sessionId ?? activeSessionIdRef.current;
        const assistantId =
          route?.assistantMessageId ??
          (isAttachedTask ? streamAssistantIdRef.current : null);
        onTaskSettled?.(id);
        taskRoutesRef.current.delete(id);
        lastStreamSaveRef.current.delete(id);
        streamEventCursorRef.current.delete(id);

        console.log("[Stream Done] Cleaning up taskId:", id);
        if (isAttachedTask && connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        const stoppedByUser = isAttachedTask && stopRequestedRef.current;
        const settledStatus = stoppedByUser ? "cancelled" : "completed";
        if (isAttachedTask) {
          streamTaskIdRef.current = null;
          pendingStopRef.current = false;
          stopRequestedRef.current = false;
          setIsLoading(false);
          setActiveSkill(null);
          setRetryInfo(null);
          setLastError(null);
          setIsStalled(false);
        }

        if (assistantId && targetSessionId) {
          updateSessionMessages(targetSessionId, (prev) => {
            const idx = prev.findIndex((m) => m.id === assistantId);
            if (idx === -1) return prev;
            const updated = [...prev];
            const msg = updated[idx];
            const normalizedParts = finalizePartsForSettledTask(
              msg.parts ?? [],
              {
                status: settledStatus,
                cancelledReason: LL.chat_userStopped(),
              },
            );
            updated[idx] = {
              ...msg,
              parts: normalizedParts,
              content: contentFromParts(normalizedParts),
            };
            return updated;
          });
        }

        window.filework.usage
          .getTaskUsage(id)
          .then((usage: UsageInfo | null) => {
            const hasUsage = usage != null && usage.totalTokens != null;
            if (isAttachedTask && hasUsage && usage) setLastUsage(usage);
            if (!assistantId || !targetSessionId) return;
            updateSessionMessages(targetSessionId, (prev) => {
              const idx = prev.findIndex((m) => m.id === assistantId);
              if (idx === -1) return prev;
              const updated = [...prev];
              const msg = updated[idx];
              const baseParts = finalizePartsForSettledTask(msg.parts ?? [], {
                status: settledStatus,
                cancelledReason: LL.chat_userStopped(),
              });
              // Machine-generated turn deliverable, aggregated from the (by now
              // normalized) tool parts and inserted just before the usage row.
              // Null for pure Q&A turns — nothing to append.
              const summary = buildTurnSummary(baseParts);
              const appended: MessagePart[] = [
                ...(summary ? [summary] : []),
                ...(hasUsage && usage
                  ? [{ type: "usage", ...usage } as UsagePart]
                  : []),
              ];
              const nextParts =
                appended.length > 0 ? [...baseParts, ...appended] : baseParts;
              updated[idx] = {
                ...msg,
                parts: nextParts,
                content: contentFromParts(nextParts),
              };
              debouncedSave(updated, targetSessionId);
              return updated;
            });
            if (isAttachedTask) streamAssistantIdRef.current = null;
          })
          .catch(() => {
            if (assistantId && targetSessionId) {
              updateSessionMessages(targetSessionId, (prev) => {
                const idx = prev.findIndex((m) => m.id === assistantId);
                if (idx === -1) {
                  debouncedSave(prev, targetSessionId);
                  return prev;
                }
                const updated = [...prev];
                const msg = updated[idx];
                const finalizedParts = finalizePartsForSettledTask(
                  msg.parts ?? [],
                  {
                    status: settledStatus,
                    cancelledReason: LL.chat_userStopped(),
                  },
                );
                updated[idx] = {
                  ...msg,
                  parts: finalizedParts,
                  content: contentFromParts(finalizedParts),
                };
                debouncedSave(updated, targetSessionId);
                return updated;
              });
            }
            if (isAttachedTask) streamAssistantIdRef.current = null;
          });
      },
    );

    const offError = window.filework.onStreamError(
      ({ id, sessionId, assistantMessageId, error, type, recoveryActions }) => {
        if (sessionId || assistantMessageId) {
          rememberTaskRoute({ taskId: id, sessionId, assistantMessageId });
        }
        if (!canRouteTask(id)) return;

        console.log("[Stream Error] Cleaning up taskId:", id, "error:", error);
        const route = routeForTask(id);
        const isAttachedTask = id === streamTaskIdRef.current;
        const targetSessionId = route?.sessionId ?? activeSessionIdRef.current;
        const assistantId =
          route?.assistantMessageId ??
          (isAttachedTask ? streamAssistantIdRef.current : null);
        onTaskSettled?.(id);
        taskRoutesRef.current.delete(id);
        lastStreamSaveRef.current.delete(id);
        streamEventCursorRef.current.delete(id);

        if (isAttachedTask && connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
        if (isAttachedTask) {
          streamTaskIdRef.current = null;
          pendingStopRef.current = false;
          stopRequestedRef.current = false;
          setIsLoading(false);
          setActiveSkill(null);
          setRetryInfo(null);
          setLastError({ message: error, type, recoveryActions });
        }
        if (!assistantId || !targetSessionId) {
          if (isAttachedTask) streamAssistantIdRef.current = null;
          return;
        }
        updateSessionMessages(targetSessionId, (prev) => {
          const idx = prev.findIndex((m) => m.id === assistantId);
          if (idx === -1) return prev;
          const updated = [...prev];
          const msg = updated[idx];
          const errorPart: MessagePart = {
            type: "error",
            message: error,
            errorType: type,
            recoveryActions: recoveryActions as ErrorPart["recoveryActions"],
          };
          const existingParts =
            msg.parts && msg.parts.length > 0 ? msg.parts : [];
          const newParts = finalizePartsForSettledTask(
            [...existingParts, errorPart],
            { status: "failed" },
          );
          updated[idx] = {
            ...msg,
            content: msg.content || error,
            parts: newParts,
          };
          debouncedSave(updated, targetSessionId);
          return updated;
        });
        if (isAttachedTask) streamAssistantIdRef.current = null;
      },
    );

    const offClarification = window.filework.onStreamClarification(
      ({ id, clarificationId, question, options }) => {
        if (!canRouteTask(id)) return;
        updateParts(id, (parts) => {
          parts.push({
            type: "clarification",
            question,
            options: options?.filter(Boolean),
            taskId: id,
            clarificationId,
          });
          return parts;
        });
      },
    );

    // `createPlan` tool → upsert one PlanMessagePart per task (matched by
    // the deterministic `inline-<taskId>` id from agent-tools.ts). First
    // call appends, subsequent calls replace steps + status in place so
    // the user sees a single evolving checklist, not stacked snapshots.
    const offStreamPlan = window.filework.onStreamPlan(({ id, plan }) => {
      if (!canRouteTask(id)) return;
      const planView = plan as PlanView;
      updateParts(id, (parts) => {
        const idx = parts.findIndex(
          (p): p is PlanMessagePart =>
            p.type === "plan" && p.plan.id === planView.id,
        );
        if (idx >= 0) {
          parts[idx] = { type: "plan", plan: planView };
        } else {
          parts.push({ type: "plan", plan: planView });
        }
        return parts;
      });
    });

    const offRetry = window.filework.onStreamRetry(
      ({ id, attempt, type, maxRetries }) => {
        if (id !== streamTaskIdRef.current) return;
        setRetryInfo({ attempt, type, maxRetries });
      },
    );

    const offSkillApprovalRequest = window.filework.onSkillApprovalRequest(
      (data) => {
        setPendingSkillApproval(data);
      },
    );

    // M12: CI watcher events — surface inline in the chat as text parts.
    // Match by streamTaskIdRef so events for a stale task drop silently.
    const offCiRunDone = window.filework.onCiRunDone(
      ({ id, runId, conclusion, url, name }) => {
        if (!canRouteTask(id)) return;
        const verdict = conclusion ?? "未知";
        updateParts(id, (parts) => {
          parts.push({
            type: "text",
            text: `🔔 CI 运行 ${name} (#${runId}) 已完成,结果: ${verdict} — ${url}`,
          });
          return parts;
        });
      },
    );

    const offCiRunTimeout = window.filework.onCiRunTimeout(
      ({ id, runId, elapsedMs }) => {
        if (!canRouteTask(id)) return;
        const minutes = Math.round(elapsedMs / 60_000);
        updateParts(id, (parts) => {
          parts.push({
            type: "text",
            text: `⏱ CI 运行 #${runId} 在 ${minutes} 分钟内未完成,已停止跟踪。可调用 listCIRuns 手动查询。`,
          });
          return parts;
        });
      },
    );

    // M13: subscribeAfterDispatch couldn't resolve a runId for a manual
    // workflow_dispatch within the 6s retry budget — tell the user to fall
    // back to manual listing.
    const offCiDispatchResolveFailed =
      window.filework.onCiDispatchResolveFailed(({ id, ref, workflowFile }) => {
        if (!canRouteTask(id)) return;
        updateParts(id, (parts) => {
          parts.push({
            type: "text",
            text: `⚠️ 已 dispatch ${workflowFile} on ${ref},但未能识别新 run id (GitHub 可能尚未创建);可调用 githubListWorkflowRuns 手动查询。`,
          });
          return parts;
        });
      });

    // ── subagent(spawnSubagent fan-out)聚合 ────────────────────────
    // 全部按 parentTaskId 过滤(等于当前主任务才处理),用 batchId 定位
    // SubagentMessagePart、childTaskId 定位卡内某一行。
    const updateSubagentChild = (
      parentTaskId: string,
      batchId: string,
      childTaskId: string,
      fn: (child: SubagentChildView) => SubagentChildView,
    ) => {
      updateParts(parentTaskId, (parts) => {
        const idx = parts.findIndex(
          (p) => p.type === "subagent" && p.batchId === batchId,
        );
        if (idx === -1) return parts;
        const part = parts[idx] as SubagentMessagePart;
        parts[idx] = {
          ...part,
          children: part.children.map((c) =>
            c.childTaskId === childTaskId ? fn(c) : c,
          ),
        };
        return parts;
      });
    };

    const offSubagentSpawn = window.filework.onSubagentSpawn(
      ({ parentTaskId, batchId, toolCallId, concurrency, children }) => {
        if (!canRouteTask(parentTaskId)) return;
        updateParts(parentTaskId, (parts) => {
          if (parts.some((p) => p.type === "subagent" && p.batchId === batchId))
            return parts;
          parts.push({
            type: "subagent",
            batchId,
            toolCallId,
            concurrency,
            children: children.map((c) => ({
              childTaskId: c.childTaskId,
              goal: c.goal,
              status: "running",
              stepCount: 0,
              toolCalls: [],
              usage: {
                inputTokens: null,
                outputTokens: null,
                totalTokens: null,
              },
            })),
          });
          return parts;
        });
      },
    );

    // 子 agent 文本增量 → 累积进 child.parts(供钻入面板回放)。
    const offSubagentDelta = window.filework.onSubagentDelta(
      ({ parentTaskId, batchId, childTaskId, delta }) => {
        if (!canRouteTask(parentTaskId)) return;
        updateSubagentChild(parentTaskId, batchId, childTaskId, (c) => {
          const parts = c.parts ? [...c.parts] : [];
          const last = parts[parts.length - 1];
          if (last && last.type === "text") {
            parts[parts.length - 1] = { ...last, text: last.text + delta };
          } else {
            parts.push({ type: "text", text: delta });
          }
          return { ...c, parts };
        });
      },
    );

    const offSubagentToolCall = window.filework.onSubagentToolCall(
      ({ parentTaskId, batchId, childTaskId, toolCallId, toolName, args }) => {
        if (!canRouteTask(parentTaskId)) return;
        updateSubagentChild(parentTaskId, batchId, childTaskId, (c) => {
          const parts = c.parts ? [...c.parts] : [];
          if (
            !parts.some((p) => p.type === "tool" && p.toolCallId === toolCallId)
          ) {
            parts.push({
              type: "tool",
              toolCallId,
              toolName,
              args,
              state: "input-available",
            });
          }
          return {
            ...c,
            stepCount: c.stepCount + 1,
            toolCalls: c.toolCalls.some((t) => t.toolCallId === toolCallId)
              ? c.toolCalls
              : [
                  ...c.toolCalls,
                  { toolCallId, toolName, state: "input-available" as const },
                ],
            parts,
          };
        });
      },
    );

    const offSubagentToolResult = window.filework.onSubagentToolResult(
      ({ parentTaskId, batchId, childTaskId, toolCallId, result }) => {
        if (!canRouteTask(parentTaskId)) return;
        const resultObj =
          result != null && typeof result === "object"
            ? (result as Record<string, unknown>)
            : null;
        const isFailure =
          resultObj != null &&
          (resultObj.success === false || resultObj.isError === true);
        const nextState = isFailure
          ? ("output-error" as const)
          : ("output-available" as const);
        updateSubagentChild(parentTaskId, batchId, childTaskId, (c) => ({
          ...c,
          toolCalls: c.toolCalls.map((t) =>
            t.toolCallId === toolCallId ? { ...t, state: nextState } : t,
          ),
          parts: c.parts?.map((p) =>
            p.type === "tool" && p.toolCallId === toolCallId
              ? { ...p, result, state: nextState }
              : p,
          ),
        }));
      },
    );

    const offSubagentChildUsage = window.filework.onSubagentChildUsage(
      ({ parentTaskId, batchId, childTaskId, usage }) => {
        if (!canRouteTask(parentTaskId)) return;
        updateSubagentChild(parentTaskId, batchId, childTaskId, (c) => ({
          ...c,
          usage: {
            inputTokens: usage?.inputTokens ?? c.usage.inputTokens,
            outputTokens: usage?.outputTokens ?? c.usage.outputTokens,
            totalTokens:
              usage?.totalTokens ??
              (usage?.inputTokens != null || usage?.outputTokens != null
                ? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
                : c.usage.totalTokens),
          },
        }));
      },
    );

    const offSubagentReport = window.filework.onSubagentReport(
      ({ parentTaskId, batchId, childTaskId, report }) => {
        if (!canRouteTask(parentTaskId)) return;
        updateSubagentChild(parentTaskId, batchId, childTaskId, (c) => ({
          ...c,
          status: report.status,
          summary: report.summary || c.summary,
          error: report.error,
          durationMs: report.durationMs,
          usage: {
            inputTokens: report.usage.inputTokens ?? c.usage.inputTokens,
            outputTokens: report.usage.outputTokens ?? c.usage.outputTokens,
            totalTokens: report.usage.totalTokens ?? c.usage.totalTokens,
          },
        }));
      },
    );

    return () => {
      offStart();
      offSkillActivated();
      offStreamEvent();
      offDelta();
      offMedia();
      offReasoning();
      offReasoningEnd();
      offToolCall();
      offToolResult();
      offToolApproval();
      offToolBatchApproval();
      offToolBatchAutoApproved();
      offMemoryEvent();
      offRetry();
      offDone();
      offError();
      offClarification();
      offStreamPlan();
      offSkillApprovalRequest();
      offCiRunDone();
      offCiRunTimeout();
      offCiDispatchResolveFailed();
      offSubagentSpawn();
      offSubagentDelta();
      offSubagentToolCall();
      offSubagentToolResult();
      offSubagentChildUsage();
      offSubagentReport();
    };
  }, [
    debouncedSave,
    LL,
    updateSessionMessages,
    setLastUsage,
    setLastError,
    activeSessionIdRef,
    rememberTaskRoute,
    onTaskSettled,
  ]);

  const detachFromTask = useCallback(() => {
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
    streamTaskIdRef.current = null;
    streamAssistantIdRef.current = null;
    pendingStopRef.current = false;
    stopRequestedRef.current = false;
    setIsLoading(false);
    setActiveSkill(null);
    setPendingSkillApproval(null);
    setRetryInfo(null);
    setIsStalled(false);
  }, []);

  // 刷新/重载后:若该会话仍有在跑的任务,重新挂上 —— 设回 taskId/assistantId、
  // 标记 loading,并确保助手消息壳存在(历史尚未落盘时补一个空壳)。之后仍在
  // 流向同一 webContents 的事件即可命中 streamTaskIdRef,继续渲染、直到 done。
  const reattachRunningTask = useCallback(
    async (sessionId: string) => {
      if (streamTaskIdRef.current) return; // 已挂载,勿重复
      const active = await window.filework.getActiveTask(sessionId);
      if (!active || active.sessionId !== sessionId) return;
      if (streamTaskIdRef.current) return; // 期间已有新任务,放弃重连
      taskRoutesRef.current.set(active.taskId, {
        sessionId,
        assistantMessageId: active.assistantMessageId,
      });
      onTaskStarted?.({
        taskId: active.taskId,
        sessionId,
        assistantMessageId: active.assistantMessageId,
      });
      // 先把 refs / 消息壳 / loading 全部就位,最后再触发 reattachTask —— 保证主
      // 进程重放的录制事件到达时,streamTaskIdRef 已设(能过滤命中)、助手消息壳
      // 已存在(updateParts 能找到),重放的首个 start 会清空盘上部分内容再重建。
      streamTaskIdRef.current = active.taskId;
      const assistantId = active.assistantMessageId;
      if (assistantId) {
        streamAssistantIdRef.current = assistantId;
        const shell: ChatMessage = {
          id: assistantId,
          sessionId,
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
          parts: [],
        };
        setMessages((prev) =>
          prev.some((m) => m.id === assistantId) ? prev : [...prev, shell],
        );
      }
      setIsLoading(true);
      // 触发重连:主进程重放录制事件(零缺口重建)并把后续流重定向到本窗口。
      // 纯刷新(webContents 不变)时重定向是无害 no-op;重放仍消除刷新窗口期缺口。
      const startIndex = streamEventCursorRef.current.get(active.taskId) ?? 0;
      void window.filework.reattachTask(active.taskId, startIndex);
    },
    [onTaskStarted, setMessages],
  );

  return {
    isLoading,
    setIsLoading,
    reattachRunningTask,
    activeSkill,
    setActiveSkill,
    pendingSkillApproval,
    setPendingSkillApproval,
    retryInfo,
    setRetryInfo,
    isStalled,
    setIsStalled,
    detachFromTask,
    rememberTaskRoute,
    streamTaskIdRef,
    streamAssistantIdRef,
    pendingStopRef,
    stopRequestedRef,
    connectionTimeoutRef,
  };
}

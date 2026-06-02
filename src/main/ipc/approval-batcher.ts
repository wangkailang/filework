// 破坏性工具批量审批缓冲区。把同一 (taskId, toolName) 下 N 个并发的
// requestApproval() 调用合并成单个 IPC 事件，让渲染进程用一张卡片
// 展示 N 条条目。

import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import { dispatchPreview, PREVIEW_TIMEOUT_MS } from "../core/agent/preview";
import { rememberPreview } from "../core/agent/preview/snapshot-store";
import type { ToolPreview } from "../core/agent/preview/types";
import type { Workspace } from "../core/workspace/types";
import { addPersistentToolWhitelist } from "./tool-whitelist";

/**
 * 在最后一条到达后、flush 之前继续等待新条目的时间窗口。
 * AI-SDK 的并行工具派发会出现错峰：每个 `beforeToolCall` 在抵达
 * enqueueForBatch 之前都要先做文件系统检查（isInWorkspace 中的
 * realpath()），因此 6 个并行的 deleteFile 调用可能因 FS 负载不同
 * 而以 30-150ms 的间隔陆续到达 batcher。250ms 能可靠合并，又不会
 * 明显拖慢审批对话框。
 */
const DEBOUNCE_MS = 250;
/** 即使条目持续到达，缓冲区保持打开的硬性上限时长。 */
const MAX_BUFFER_AGE_MS = 10_000;

export interface BatchEntry {
  toolCallId: string;
  args: unknown;
  description: string;
  resolve: (approved: boolean) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
  /**
   * 结构化变更预览。由 PR2 的预览生成器在 `flushBuffer` 期间填充；
   * PR1 仅把该字段贯通传递（始终为 undefined）。
   */
  preview?: ToolPreview;
}

interface PendingBuffer {
  sender: WebContents;
  taskId: string;
  toolName: string;
  entries: BatchEntry[];
  debounceTimer: ReturnType<typeof setTimeout>;
  capTimer: ReturnType<typeof setTimeout>;
  /**
   * 拥有该任务的工作区。从第一个带 workspace 的入队请求中捕获；
   * `flushBuffer` 用它在发送 IPC 事件前为条目补充结构化预览。
   * 未设置 → 跳过预览生成并同步发送事件（单元测试及尚未接入该
   * 链路的调用方所走的旧路径）。
   */
  workspace?: Workspace;
}

export interface PendingBatch {
  sender: WebContents;
  taskId: string;
  toolName: string;
  entries: BatchEntry[];
}

// 等待防抖 flush 的缓冲区。Key = `${taskId}::${toolName}`。
const buffers = new Map<string, PendingBuffer>();
// 已 flush、等待用户响应的批次。Key = batchId。
const pendingBatches = new Map<string, PendingBatch>();

const bufferKey = (taskId: string, toolName: string): string =>
  `${taskId}::${toolName}`;

export interface EnqueueParams {
  sender: WebContents;
  taskId: string;
  toolName: string;
  toolCallId: string;
  args: unknown;
  description: string;
  abortSignal?: AbortSignal;
  /** 可选的预计算预览。省略且存在 `workspace` 时，
   *  batcher 会在 `flushBuffer` 中生成一个。 */
  preview?: ToolPreview;
  /** 拥有该任务的工作区。当没有预计算预览时，
   *  batcher 生成预览所必需。 */
  workspace?: Workspace;
}

/**
 * 缓冲该破坏性工具的审批请求。返回的 Promise 会在用户对所属批次
 * 作出决定时 resolve（或在 abort 信号触发时 resolve 为 `false`）。
 */
export function enqueueForBatch(params: EnqueueParams): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const entry: BatchEntry = {
      toolCallId: params.toolCallId,
      args: params.args,
      description: params.description,
      resolve,
      abortSignal: params.abortSignal,
      preview: params.preview,
    };

    if (params.abortSignal) {
      if (params.abortSignal.aborted) {
        resolve(false);
        return;
      }
      const onAbort = () => {
        removeEntry(params.taskId, params.toolName, entry.toolCallId);
        resolve(false);
      };
      entry.onAbort = onAbort;
      params.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const key = bufferKey(params.taskId, params.toolName);
    let buf = buffers.get(key);
    if (!buf) {
      buf = createBuffer(
        params.sender,
        params.taskId,
        params.toolName,
        params.workspace,
      );
      buffers.set(key, buf);
    } else if (!buf.workspace && params.workspace) {
      buf.workspace = params.workspace;
    }
    buf.entries.push(entry);
    // 延长防抖窗口 —— 后续并发到达会重置定时器，
    // 以便等待这一波全部到齐。
    clearTimeout(buf.debounceTimer);
    buf.debounceTimer = setTimeout(() => flushBuffer(key), DEBOUNCE_MS);
  });
}

function createBuffer(
  sender: WebContents,
  taskId: string,
  toolName: string,
  workspace?: Workspace,
): PendingBuffer {
  const key = bufferKey(taskId, toolName);
  const buf: PendingBuffer = {
    sender,
    taskId,
    toolName,
    entries: [],
    debounceTimer: setTimeout(() => flushBuffer(key), DEBOUNCE_MS),
    capTimer: setTimeout(() => flushBuffer(key), MAX_BUFFER_AGE_MS),
    workspace,
  };
  return buf;
}

function removeEntry(
  taskId: string,
  toolName: string,
  toolCallId: string,
): void {
  const key = bufferKey(taskId, toolName);
  const buf = buffers.get(key);
  if (buf) {
    const idx = buf.entries.findIndex((e) => e.toolCallId === toolCallId);
    if (idx !== -1) buf.entries.splice(idx, 1);
    if (buf.entries.length === 0) {
      clearTimeout(buf.debounceTimer);
      clearTimeout(buf.capTimer);
      buffers.delete(key);
    }
    return;
  }
  for (const batch of pendingBatches.values()) {
    if (batch.taskId === taskId && batch.toolName === toolName) {
      const idx = batch.entries.findIndex((e) => e.toolCallId === toolCallId);
      if (idx !== -1) batch.entries.splice(idx, 1);
      return;
    }
  }
}

function flushBuffer(key: string): void {
  const buf = buffers.get(key);
  if (!buf) return;
  clearTimeout(buf.debounceTimer);
  clearTimeout(buf.capTimer);
  buffers.delete(key);
  if (buf.entries.length === 0) return;

  const batchId = randomUUID();
  pendingBatches.set(batchId, {
    sender: buf.sender,
    taskId: buf.taskId,
    toolName: buf.toolName,
    entries: buf.entries,
  });

  // 有 workspace 时，异步补充条目预览后再发送。没有时
  // （如单元测试、旧调用方）保留同步 IPC 路径，以便现有的
  // fake-timer 测试无需 flush 微任务。
  if (buf.workspace) {
    void enrichAndSend(buf, batchId);
  } else {
    sendBatchApproval(buf, batchId);
  }
}

function sendBatchApproval(buf: PendingBuffer, batchId: string): void {
  if (buf.sender.isDestroyed()) return;
  buf.sender.send("ai:stream-tool-batch-approval", {
    id: buf.taskId,
    batchId,
    toolName: buf.toolName,
    entries: buf.entries.map((e) => ({
      toolCallId: e.toolCallId,
      args: e.args,
      description: e.description,
      preview: e.preview,
    })),
  });
}

async function enrichAndSend(
  buf: PendingBuffer,
  batchId: string,
): Promise<void> {
  const workspace = buf.workspace;
  if (!workspace) {
    if (pendingBatches.has(batchId)) sendBatchApproval(buf, batchId);
    return;
  }
  // 对 entries 数组做快照，避免并发的 `removeEntry` splice 改动
  // 正在遍历的内容。条目对象本身仍是共享的 —— sendBatchApproval
  // 仍能看到预览赋值，但遍历的结构是稳定的。
  const snapshot = buf.entries.slice();
  await Promise.all(
    snapshot.map(async (e) => {
      if (e.preview !== undefined) return;
      try {
        const preview = await Promise.race([
          dispatchPreview(buf.toolName, e.args, workspace),
          new Promise<undefined>((resolve) => {
            setTimeout(() => resolve(undefined), PREVIEW_TIMEOUT_MS);
          }),
        ]);
        e.preview = preview;
      } catch {
        // dispatchPreview 已自行吞掉错误；这里无需处理。
      }
    }),
  );
  // 若批次在 await 期间被取消 / 已结算 / 重新 flush，则丢弃该 IPC ——
  // 否则渲染进程会收到一张幽灵审批卡片，其按钮对 settleBatch 无效。
  if (!pendingBatches.has(batchId)) return;
  sendBatchApproval(buf, batchId);
}

/**
 * 以给定的决定结算批次中的每一条条目。
 *
 * 普通批准(`remember` 为 false)只放行**这一批显示出来的操作**,不写白名单、
 * 不级联——对齐 Claude Code「Yes」只批准当前这一次的语义。只有用户显式选择
 * 「始终允许」(`remember` 为 true)时,才把该工具加入任务白名单,让后续同类
 * 调用自动放行,并级联批准因抖动而单独 flush 的兄弟批次(点一次即可)。
 */
export function settleBatch(
  batchId: string,
  approved: boolean,
  remember = false,
): boolean {
  const batch = pendingBatches.get(batchId);
  if (!batch) return false;
  pendingBatches.delete(batchId);
  for (const entry of batch.entries) {
    if (entry.abortSignal && entry.onAbort) {
      entry.abortSignal.removeEventListener("abort", entry.onAbort);
    }
    if (approved && entry.preview) {
      // 把刚生成的预览交给快照存储，这样后续的
      // `tool_execution_start` IPC 无需重复读盘即可把它发给渲染进程。
      rememberPreview(entry.toolCallId, entry.preview);
    }
    entry.resolve(approved);
  }
  if (approved && remember) {
    // 写入持久白名单(跨任务/会话生效,可在设置面板里管理),
    // 并级联放行因抖动单独 flush 的同类兄弟批次。
    addPersistentToolWhitelist(batch.toolName);
    cascadeApproveSiblings(batch.taskId, batch.toolName, batch.sender);
  }
  return true;
}

/**
 * 在某批次被批准后，结算同一 (taskId, toolName) 下其余待处理批次，
 * 并发出一个通知性 IPC 事件，让渲染进程把它们的卡片收拢为已接受状态。
 */
function cascadeApproveSiblings(
  taskId: string,
  toolName: string,
  sender: WebContents,
): void {
  for (const [batchId, batch] of pendingBatches) {
    if (batch.taskId !== taskId || batch.toolName !== toolName) continue;
    pendingBatches.delete(batchId);
    for (const entry of batch.entries) {
      if (entry.abortSignal && entry.onAbort) {
        entry.abortSignal.removeEventListener("abort", entry.onAbort);
      }
      if (entry.preview) rememberPreview(entry.toolCallId, entry.preview);
      entry.resolve(true);
    }
    if (!sender.isDestroyed()) {
      sender.send("ai:stream-tool-batch-auto-approved", {
        id: taskId,
        batchId,
      });
    }
  }
}

/**
 * 拒绝属于指定任务的每一条条目（无论仍在缓冲还是已 flush）。
 * 由 `stopTaskExecution` 使用。
 */
export function cancelBatchesForTask(taskId: string): void {
  for (const [key, buf] of buffers) {
    if (buf.taskId !== taskId) continue;
    clearTimeout(buf.debounceTimer);
    clearTimeout(buf.capTimer);
    for (const entry of buf.entries) {
      if (entry.abortSignal && entry.onAbort) {
        entry.abortSignal.removeEventListener("abort", entry.onAbort);
      }
      entry.resolve(false);
    }
    buffers.delete(key);
  }
  for (const [batchId, batch] of pendingBatches) {
    if (batch.taskId !== taskId) continue;
    for (const entry of batch.entries) {
      if (entry.abortSignal && entry.onAbort) {
        entry.abortSignal.removeEventListener("abort", entry.onAbort);
      }
      entry.resolve(false);
    }
    pendingBatches.delete(batchId);
  }
}

/** 测试辅助函数。 */
export function __resetBatcherForTests(): void {
  for (const buf of buffers.values()) {
    clearTimeout(buf.debounceTimer);
    clearTimeout(buf.capTimer);
  }
  buffers.clear();
  pendingBatches.clear();
}

/** 测试用的状态检查辅助函数。 */
export function __getBatcherState(): {
  bufferCount: number;
  pendingBatchCount: number;
} {
  return {
    bufferCount: buffers.size,
    pendingBatchCount: pendingBatches.size,
  };
}

/**
 * 测试辅助函数：同步 flush 每个仍在缓冲的批次（跳过防抖等待）。
 * 返回被 flush 的 batchId 列表。
 */
export function __flushAllForTests(): string[] {
  const flushedIds: string[] = [];
  const keys = Array.from(buffers.keys());
  for (const key of keys) {
    const before = pendingBatches.size;
    flushBuffer(key);
    if (pendingBatches.size > before) {
      const id = Array.from(pendingBatches.keys()).pop();
      if (id) flushedIds.push(id);
    }
  }
  return flushedIds;
}

/**
 * 测试辅助函数：定位包含指定 toolCallId 的批次并结算它。
 * 涵盖仍在缓冲的条目（会先 flush 它们）。
 */
export function __settleByToolCallIdForTests(
  toolCallId: string,
  approved: boolean,
): boolean {
  for (const [key, buf] of buffers) {
    if (buf.entries.some((e) => e.toolCallId === toolCallId)) {
      flushBuffer(key);
      break;
    }
  }
  for (const [batchId, batch] of pendingBatches) {
    if (batch.entries.some((e) => e.toolCallId === toolCallId)) {
      return settleBatch(batchId, approved);
    }
  }
  return false;
}

/**
 * 维护 `toolCallId → ToolPreview` 映射的内存存储。当用户审批通过时,
 * approval batcher 会记住每条条目刚生成的预览;tool-execution-start
 * 的 IPC 桥接随后消费该快照,并连同工具参数一起发送给渲染进程。
 * 这样,执行后的工具卡片无需重新读取(此时已被覆盖的)前镜像,
 * 即可渲染出用户在审批卡片上看到的那份完全一致的 diff。
 *
 * 进程本地存储,不持久化。采用有界 LRU,避免始终未被认领的审批
 * 无限期泄漏。
 */

import type { ToolPreview } from "./types";

const LRU_MAX = 64;
const store = new Map<string, ToolPreview>();

/** 以 toolCallId 为键保存快照。会替换任何先前的条目。 */
export function rememberPreview(
  toolCallId: string,
  preview: ToolPreview,
): void {
  if (store.size >= LRU_MAX && !store.has(toolCallId)) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(toolCallId, preview);
}

/** 取出并移除指定 toolCallId 对应的快照。 */
export function consumePreview(toolCallId: string): ToolPreview | undefined {
  const v = store.get(toolCallId);
  if (v !== undefined) store.delete(toolCallId);
  return v;
}

/** 测试辅助函数。 */
export function __resetSnapshotStore(): void {
  store.clear();
}

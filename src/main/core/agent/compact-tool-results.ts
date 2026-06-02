/**
 * 对 agent 工具结果进行循环内上下文压缩。
 *
 * 在同一次用户轮次中,AI SDK 内部的逐步循环会在每一步把整个消息列表
 * ——包括目前产生的每个工具结果——重新发送给模型。因此单个大结果
 * (一个 webFetch 的 `raw` 主体、某个命令的 stdout)的代价 = 其大小 × 剩余步数,
 * 这正是"抓取一个 4MB 词表后再迭代"的轮次会冲破 200 万输入 token 的原因。
 *
 * 本函数收缩较旧的工具结果:最新的工具消息保持原样
 * (模型通常正在对它进行操作),而较早的超大结果会被替换为头部+尾部摘录。
 * 并行工具调用已被禁用,因此"最新的工具消息" == "当前步骤的结果"。
 * 纯函数且保留结构:只有 `output` 文本被收缩;toolCallId /
 * toolName / 消息配对均不受影响。
 */

import type { ModelMessage } from "ai";

/** 较旧的工具结果被裁剪到这么多字符(头部+尾部)。 */
const DEFAULT_BUDGET_CHARS = 4_000;
const HEAD_FRAC = 0.75;

interface CompactOptions {
  budgetChars?: number;
}

function outputToString(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const o = output as { type?: string; value?: unknown };
  if (o.type === "text" || o.type === "error-text") {
    return typeof o.value === "string" ? o.value : null;
  }
  if (o.type === "json" || o.type === "error-json") {
    try {
      return JSON.stringify(o.value);
    } catch {
      return null;
    }
  }
  return null; // execution-denied / 内容片段——体积小,不予处理
}

function clamp(s: string, budget: number): string {
  if (s.length <= budget) return s;
  const head = Math.floor(budget * HEAD_FRAC);
  const tail = budget - head;
  const dropped = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${dropped} chars elided to save context — re-run the tool or grep the file if you need them]…\n${s.slice(-tail)}`;
}

/**
 * 返回 `messages` 的压缩副本,若无任何改动则返回 `null`。
 * 保留最后一条 `tool` 角色消息的完整内容;裁剪较早的超大消息。
 */
export function compactToolResults(
  messages: ModelMessage[],
  opts?: CompactOptions,
): ModelMessage[] | null {
  const budget = opts?.budgetChars ?? DEFAULT_BUDGET_CHARS;

  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") {
      lastToolIdx = i;
      break;
    }
  }
  if (lastToolIdx <= 0) return null; // 0 或 1 条工具消息——没有更早的可裁剪

  let changed = false;
  const out = messages.map((m, i) => {
    if (m.role !== "tool" || i === lastToolIdx || !Array.isArray(m.content)) {
      return m;
    }
    const content = m.content.map((part) => {
      if (
        !part ||
        typeof part !== "object" ||
        (part as { type?: string }).type !== "tool-result"
      ) {
        return part;
      }
      const tr = part as { output: unknown };
      const str = outputToString(tr.output);
      if (str == null || str.length <= budget) return part;
      changed = true;
      return {
        ...tr,
        output: { type: "text" as const, value: clamp(str, budget) },
      };
    });
    return { ...m, content } as ModelMessage;
  });

  return changed ? out : null;
}

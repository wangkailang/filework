/**
 * MessagePart 感知的脱敏:只对承载明文的字段(text / reasoning / error.message /
 * tool.args / tool.result)掩码,跳过 image/attachment 等二进制数据,避免破坏 base64。
 * 持久化层(jsonl-store)与渲染层(ChatPanel)共用,保证落盘与显示口径一致。
 */
import type { MessagePart } from "../../main/core/session/message-parts";

import { redactDeep, redactSecrets } from "./secret-detection";

/** 对一组 parts 选择性脱敏,返回脱敏副本与命中数(不修改入参)。 */
export function redactMessageParts(parts: MessagePart[]): {
  parts: MessagePart[];
  count: number;
} {
  let count = 0;
  const out = parts.map((part): MessagePart => {
    if (part.type === "text" || part.type === "reasoning") {
      const r = redactSecrets(part.text);
      count += r.count;
      return { ...part, text: r.text };
    }
    if (part.type === "error") {
      const r = redactSecrets(part.message);
      count += r.count;
      return { ...part, message: r.text };
    }
    if (part.type === "tool") {
      const a = redactDeep(part.args);
      const b = redactDeep(part.result);
      count += a.count + b.count;
      return { ...part, args: a.value, result: b.value };
    }
    // 这些 part 含模型/用户产生的明文(plan 工件 args/result、批准条目 args、
    // 澄清问答、回合摘要命令、视频任务 prompt 等),且不含二进制数据,整体深度脱敏。
    if (
      part.type === "clarification" ||
      part.type === "batch-approval" ||
      part.type === "plan" ||
      part.type === "turn-summary" ||
      part.type === "video-job"
    ) {
      const r = redactDeep(part);
      count += r.count;
      return r.value as MessagePart;
    }
    return part;
  });
  return { parts: out, count };
}

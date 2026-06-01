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
    return part;
  });
  return { parts: out, count };
}

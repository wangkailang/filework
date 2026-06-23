import type { ModelMessage, UserContent } from "ai";
import {
  type AttachmentHistoryEntry,
  buildUserContentWithAttachments,
} from "./attachments";

// ---------------------------------------------------------------------------
// Part 类型(渲染进程 MessagePart 类型的精简版)
// ---------------------------------------------------------------------------

export interface TextPart {
  type: "text";
  text: string;
}

/**
 * 由具备推理能力的模型产生的隐藏推理内容。会持久化到会话 JSONL 并在此回放,
 * 使得那些要求在后续轮次将推理内容回填到 assistant 消息的适配器
 * (Xiaomi MiMo、DeepSeek-Reasoner)能拿到上一轮的
 * reasoning_content。忽略推理 part 的适配器(OpenAI Chat
 * Completions)会静默丢弃它们 —— 属于安全的空操作。
 */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  state?: string;
}

export interface PlanMessagePart {
  type: "plan";
  plan: unknown;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | PlanMessagePart
  | AttachmentHistoryEntry;

/**
 * 用于 IPC 传输的 ChatMessage 精简版。
 * 排除 id、sessionId、timestamp 以减小负载体积。
 */
export interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
  parts?: MessagePart[];
}

const TOOL_RESULT_PLACEHOLDER = "[工具执行结果未记录]";

/**
 * 将前端的 HistoryMessage[] 转换为 Vercel AI SDK 的 ModelMessage[]。
 *
 * 转换规则:
 * - user 消息 → 默认 { role: "user", content }(字符串)
 * - 带附件 part 的 user 消息 → { role: "user", content: [...] },
 *   包含 image / file / inline-text 内容 part,受 provider 能力约束
 *   (见 `attachments.ts`)
 * - assistant TextPart → { role: "assistant", content: [{ type: "text", text }] }
 * - assistant ToolPart → assistant 的 tool-call 内容 part + 独立的 tool 角色消息
 * - PlanMessagePart → 忽略
 * - ToolPart 缺少 result → 使用占位文本
 * - 保留消息的时间先后顺序
 */
export async function convertToCoreMessages(
  history: HistoryMessage[],
  opts?: { providerId?: string },
): Promise<ModelMessage[]> {
  const result: ModelMessage[] = [];

  for (const msg of history) {
    if (msg.role === "user") {
      const attachments = (msg.parts ?? []).filter(
        (p): p is AttachmentHistoryEntry => p.type === "attachment",
      );
      if (attachments.length === 0) {
        result.push({ role: "user", content: msg.content });
      } else {
        const content = await buildUserContentWithAttachments(
          msg.content,
          attachments,
          opts?.providerId,
        );
        // 我们的 `UserContentPart` 对应 AI SDK 的 UserContent 的一个子集
        // (text / image / file)。通过 `UserContent` 做类型断言,
        // 使 ModelMessage 联合类型在 provider 边界处正确收窄。
        result.push({
          role: "user",
          content: content as unknown as UserContent,
        });
      }
      continue;
    }

    // assistant 消息 —— 处理 parts
    if (!msg.parts || msg.parts.length === 0) {
      // 没有 parts,直接使用 content 字符串
      if (msg.content) {
        result.push({ role: "assistant", content: msg.content });
      }
      continue;
    }

    const reasoningParts: Array<{ type: "reasoning"; text: string }> = [];
    const textParts: Array<{ type: "text"; text: string }> = [];
    const toolCallParts: Array<{
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }> = [];
    const toolResults: Array<{
      toolCallId: string;
      toolName: string;
      result: unknown;
    }> = [];

    for (const part of msg.parts) {
      switch (part.type) {
        case "text": {
          const tp = part as TextPart;
          if (tp.text) {
            textParts.push({ type: "text", text: tp.text });
          }
          break;
        }
        case "reasoning": {
          const rp = part as ReasoningPart;
          if (rp.text) {
            reasoningParts.push({ type: "reasoning", text: rp.text });
          }
          break;
        }
        case "tool": {
          const tp = part as ToolPart;
          const normalizedInput = normalizeToolInput(tp.args);
          if (!normalizedInput.ok) {
            textParts.push({
              type: "text",
              text: buildMalformedToolCallText(tp),
            });
            break;
          }
          toolCallParts.push({
            type: "tool-call",
            toolCallId: tp.toolCallId,
            toolName: tp.toolName,
            input: normalizedInput.input,
          });
          toolResults.push({
            toolCallId: tp.toolCallId,
            toolName: tp.toolName,
            result: tp.result ?? TOOL_RESULT_PLACEHOLDER,
          });
          break;
        }
        // "plan" 及其他任何未知类型均被忽略
        default:
          break;
      }
    }

    // 构造 assistant 消息的内容数组。推理 part 必须排在
    // text/tool-call part 之前,这样那些扫描第一个 `reasoning` part 的
    // 适配器(DeepSeek / Xiaomi)才能将其附加到 assistant 消息的
    // `reasoning_content` 字段。
    const assistantContent: Array<
      | { type: "reasoning"; text: string }
      | { type: "text"; text: string }
      | {
          type: "tool-call";
          toolCallId: string;
          toolName: string;
          input: unknown;
        }
    > = [...reasoningParts, ...textParts, ...toolCallParts];

    if (assistantContent.length > 0) {
      result.push({ role: "assistant", content: assistantContent });
    }

    // 为每个工具调用生成 tool 角色消息
    if (toolResults.length > 0) {
      result.push({
        role: "tool",
        content: toolResults.map((tr) => ({
          type: "tool-result" as const,
          toolCallId: tr.toolCallId,
          toolName: tr.toolName,
          output: formatToolResult(tr.result),
        })),
      });
    }
  }

  return result;
}

function normalizeToolInput(
  args: unknown,
): { ok: true; input: unknown } | { ok: false } {
  if (typeof args !== "string") {
    return { ok: true, input: args };
  }

  try {
    return { ok: true, input: JSON.parse(args) };
  } catch {
    return { ok: false };
  }
}

function buildMalformedToolCallText(part: ToolPart): string {
  const error = extractToolError(part.result);
  const prefix = `Skipped malformed ${part.toolName} tool call from prior history`;
  return error ? `${prefix}: ${error}` : `${prefix}.`;
}

function extractToolError(result: unknown): string | null {
  const raw =
    result != null && typeof result === "object" && "error" in result
      ? (result as { error?: unknown }).error
      : typeof result === "string"
        ? result
        : null;
  if (typeof raw !== "string" || !raw.trim()) return null;

  const withoutRawPayload = raw.replace(/\s*Text:\s*[\s\S]*$/u, "").trim();
  const trimmed = withoutRawPayload.replace(/[:：.。]+$/u, "");
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}...` : trimmed;
}

/**
 * 将工具结果格式化为 AI SDK 所需的 ToolResultOutput 格式。
 */
function formatToolResult(result: unknown): { type: "text"; value: string } {
  if (typeof result === "string") {
    return { type: "text", value: result };
  }
  try {
    return { type: "text", value: JSON.stringify(result) };
  } catch {
    return { type: "text", value: String(result) };
  }
}

/**
 * 用户附件 → ModelMessage 内容适配器。
 *
 * 聊天输入框会把文件作为 user 消息上的 `AttachmentPart` 条目附加进来。
 * 消息转换器在此遍历它们,构建出符合 provider 形态的内容数组,再由
 * Vercel AI SDK 转发给模型。
 *
 * provider 的能力很关键:Anthropic 的 `claude` 系列接受原生的 `file`
 * 内容(用于 PDF);OpenAI 和 DeepSeek 的视觉能力只接受 `image` 内容;
 * MiniMax chat 接受图像;Ollama 仅支持文本。任何不在该能力矩阵内的内容
 * 都会回退为一条文本提示,这样模型仍能知道附件存在,而不会看到损坏 /
 * 不受支持的内容。
 *
 * 已知不足:`truncate-to-fit.ts` 中的 token 估算目前尚未计入图像字节。
 * 大图像附件会被低估。目前可以接受 —— 通过流结束后的 usage 事件来追踪
 * 实际用量。
 */

import { readFile } from "node:fs/promises";

import type { AttachmentKind } from "../core/session/message-parts";
import { extractPdfText } from "./pdf-text";

export interface AttachmentHistoryEntry {
  type: "attachment";
  path: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
}

export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: Uint8Array; mediaType: string }
  | { type: "file"; data: Uint8Array; mediaType: string };

interface ProviderCaps {
  image: boolean;
  pdf: boolean;
}

/**
 * 静态能力矩阵。保守策略:若某个 provider 未被列出,默认仅支持图像
 *(覆盖大多数 OpenAI 兼容的视觉端点)—— 文本始终可用。
 */
const PROVIDER_CAPS: Record<string, ProviderCaps> = {
  anthropic: { image: true, pdf: true },
  openai: { image: true, pdf: false },
  deepseek: { image: true, pdf: false },
  minimax: { image: true, pdf: false },
  ollama: { image: false, pdf: false },
  // Xiaomi MiMo(经 deepseek 兼容协议接入)是纯文本推理模型,不接受图像内容。
  // 注意:此 key 须是「解析后的 adapter 名」(见 resolveAdapterName)——MiMo 常以
  // host 覆盖路由,llmConfig.provider 未必等于 "xiaomi",故调用方需传解析后的名字。
  xiaomi: { image: false, pdf: false },
  custom: { image: true, pdf: false },
};

const DEFAULT_CAPS: ProviderCaps = { image: true, pdf: false };
const TEXT_MAX_BYTES = 200 * 1024; // 每个文件内联上限 200 KB

const capsForProvider = (providerId?: string): ProviderCaps => {
  if (!providerId) return DEFAULT_CAPS;
  return PROVIDER_CAPS[providerId] ?? DEFAULT_CAPS;
};

/**
 * 根据输入的文本及任意附件,构建 user 消息的内容数组。会从磁盘读取每个
 * 文件;在失败 / 不受支持时,追加一条文本提示而非抛出异常,这样单个
 * 损坏的附件永远不会阻塞整次提交。
 */
export async function buildUserContentWithAttachments(
  baseText: string,
  attachments: AttachmentHistoryEntry[],
  providerId?: string,
): Promise<UserContentPart[]> {
  const caps = capsForProvider(providerId);
  const out: UserContentPart[] = [];
  const notices: string[] = [];

  if (baseText) out.push({ type: "text", text: baseText });

  // 并行读取所有受支持且符合条件的附件 —— 磁盘读取彼此独立,在多个 PDF
  // 一起提交时,N 倍的串行延迟会迅速累积。每个 Promise 解析为一个
  // part-or-notice 元组,以便在输出阶段保留输入顺序。
  type Resolved = { part: UserContentPart } | { notice: string };
  const reads: Promise<Resolved>[] = attachments.map(async (a) => {
    try {
      if (a.kind === "image") {
        if (!caps.image) {
          return {
            notice: `[Attachment "${a.name}" was not sent: provider "${providerId ?? "unknown"}" does not support images.]`,
          };
        }
        const buf = await readFile(a.path);
        // Node 的 Buffer 本身就是 Uint8Array —— 无需拷贝。
        return {
          part: {
            type: "image" as const,
            image: buf,
            mediaType: a.mimeType || "image/png",
          },
        };
      }
      if (a.kind === "pdf") {
        if (!caps.pdf) {
          // provider 无法接受原生的 PDF 文件 part。与其丢弃二进制内容、
          // 只给模型留一条「未发送」提示(这曾导致模型幻觉式地调用
          // listDirectory 去找文件),不如内联提取文本,使模型可以直接
          // 分析其内容。
          const extracted = await extractPdfText(a.path);
          if (!extracted.ok) {
            return {
              notice: `[Attachment "${a.name}" (PDF) could not be parsed: ${extracted.error}. The attachment was provided by the user — do not search the filesystem for it.]`,
            };
          }
          const trailer = extracted.truncated
            ? "\n... [truncated, only the first 80k characters were included]"
            : "";
          return {
            part: {
              type: "text" as const,
              text: `\n\n--- attached PDF: ${a.name} (${extracted.pages} pages) ---\n${extracted.text}${trailer}\n--- end PDF: ${a.name} ---\n`,
            },
          };
        }
        const buf = await readFile(a.path);
        return {
          part: {
            type: "file" as const,
            data: buf,
            mediaType: "application/pdf",
          },
        };
      }
      // 文本 / 代码 —— 内联。对每个文件设上限,避免一个误入的 5MB 日志
      // 撑爆上下文窗口。TextDecoder 设为非致命模式,这样在截断边界被截开
      // 的多字节码点会产出 U+FFFD,而不会抛出异常。
      const buf = await readFile(a.path);
      const truncated = buf.byteLength > TEXT_MAX_BYTES;
      const slice = truncated ? buf.subarray(0, TEXT_MAX_BYTES) : buf;
      const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
      return {
        part: {
          type: "text" as const,
          text: `\n\n--- file: ${a.name} (${a.mimeType}) ---\n${text}${truncated ? "\n... [truncated]" : ""}\n--- end: ${a.name} ---\n`,
        },
      };
    } catch (err) {
      return {
        notice: `[Failed to read attachment "${a.name}": ${err instanceof Error ? err.message : String(err)}]`,
      };
    }
  });

  const resolved = await Promise.all(reads);
  for (const r of resolved) {
    if (!("part" in r)) {
      notices.push(r.notice);
      continue;
    }
    // Schema 安全防护:防止未来出现某种回归,使消息经过 JSON 往返
    //(例如经由某个 clone 辅助函数)而把 Buffer 变成
    // `{type:"Buffer",data:[...]}`。AI SDK 的 prompt schema 要求
    // `instanceof Uint8Array`;普通对象会以一个晦涩的错误校验失败。
    const binary =
      r.part.type === "image"
        ? r.part.image
        : r.part.type === "file"
          ? r.part.data
          : null;
    if (binary !== null && !(binary instanceof Uint8Array)) {
      console.error(
        `[attachments] ${r.part.type} data is not Uint8Array, got:`,
        typeof binary,
      );
      notices.push(
        `[Attachment ${r.part.type} was dropped: data became invalid after read.]`,
      );
      continue;
    }
    out.push(r.part);
  }

  if (notices.length > 0) {
    out.push({
      type: "text",
      text: `\n\n${notices.join("\n")}`,
    });
  }

  // 防御性处理:尽管 `userModelMessageSchema` 允许空内容数组,某些
  // provider 适配器仍会拒绝它。回退为单个文本 part,让模型至少有
  // *某些内容*可以据以处理。
  if (out.length === 0) {
    out.push({
      type: "text",
      text: "(attachment was provided but could not be processed)",
    });
  }

  return out;
}

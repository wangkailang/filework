/**
 * Xiaomi MiMo Provider 适配器
 *
 * 为什么需要专门的适配器(而不直接用 DeepSeek):
 *
 *   `@ai-sdk/deepseek` 使用了正确的传输协议(assistant 消息携带
 *   `reasoning_content`,OpenAI 兼容的 Chat Completions)。但它的消息
 *   转换器会丢弃所有 index ≤ 最后一条 user 消息的 assistant 上的
 *   `reasoning_content` —— DeepSeek-Reasoner 只需要最新一轮的 reasoning,
 *   而 Xiaomi MiMo 在第 2 轮及以后会返回 400:
 *
 *     "The reasoning_content in the thinking mode must be passed back to the API."
 *
 * 修复方案:用一层中间件包装 deepseek 模型,将原始 prompt 中每一轮
 * assistant 的 reasoning 捕获到一个 AsyncLocalStorage 存储中,然后由
 * 自定义 fetch 读取该存储,为 deepseek 转换器清空过的每一条 assistant
 * 消息重新写回 `reasoning_content`。结果:Xiaomi 能看到完整的 reasoning
 * 历史;DeepSeek 的代码路径不受影响。
 *
 * 底层我们仍使用 `createDeepSeek`(因此流式响应解析、tool-call 增量、
 * 错误处理都保持久经考验的状态),只对*发出的*请求体打补丁。中间件
 * 从不修改 prompt —— 那样只会再次败给 deepseek 转换器。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { type LanguageModel, wrapLanguageModel } from "ai";
import {
  type CacheMetrics,
  NO_CACHE_METRICS,
  NO_PROVIDER_OPTIONS,
  type ProviderAdapter,
  type ProviderConfig,
} from "./base";

// 每一轮 assistant 对应一个 reasoning 字符串,按 prompt 顺序排列。
// 空字符串表示「该轮未产生 reasoning」—— 此时保持发出的消息不变。
type AssistantReasonings = readonly string[];

const reasoningStorage = new AsyncLocalStorage<AssistantReasonings>();

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

interface AssistantContentPart {
  type: string;
  text?: string;
}

interface LanguageModelMessage {
  role: string;
  content: string | AssistantContentPart[];
}

/**
 * 遍历 AI-SDK 的 LanguageModelV3 prompt,为每一条 assistant 消息收集
 * 拼接后的 reasoning 文本。这些下标与「发出的」API 请求体中的 assistant
 * 消息一一对应 —— 也正是 fetch 补丁器所遍历的对象。
 */
function extractAssistantReasonings(
  prompt: readonly LanguageModelMessage[],
): string[] {
  const out: string[] = [];
  for (const msg of prompt) {
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") {
      out.push("");
      continue;
    }
    let reasoning = "";
    for (const part of msg.content) {
      if (part.type === "reasoning" && typeof part.text === "string") {
        reasoning += part.text;
      }
    }
    out.push(reasoning);
  }
  return out;
}

interface XiaomiBody {
  messages?: Array<
    {
      role?: string;
      reasoning_content?: string;
    } & Record<string, unknown>
  >;
}

function patchOutgoingBody(bodyText: string): string {
  const reasonings = reasoningStorage.getStore();
  if (!reasonings || reasonings.length === 0) return bodyText;
  let body: XiaomiBody;
  try {
    body = JSON.parse(bodyText) as XiaomiBody;
  } catch {
    return bodyText;
  }
  if (!Array.isArray(body.messages)) return bodyText;
  let assistantIdx = 0;
  let mutated = false;
  for (const msg of body.messages) {
    if (msg.role !== "assistant") continue;
    const reasoning = reasonings[assistantIdx];
    assistantIdx++;
    if (!reasoning) continue;
    // 仅在 deepseek 转换器丢弃了 reasoning 时才写回。保留转换器为最新
    // 一轮写入的内容(反正数据是一样的)。
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
      continue;
    }
    msg.reasoning_content = reasoning;
    mutated = true;
  }
  return mutated ? JSON.stringify(body) : bodyText;
}

function makeXiaomiFetch(): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (!url.includes("/chat/completions") || !init?.body) {
      return fetch(input as RequestInfo, init);
    }
    let bodyText: string | undefined;
    if (typeof init.body === "string") {
      bodyText = init.body;
    } else if (init.body instanceof Uint8Array) {
      bodyText = new TextDecoder().decode(init.body);
    }
    if (bodyText === undefined) {
      return fetch(input as RequestInfo, init);
    }
    const patched = patchOutgoingBody(bodyText);
    if (patched === bodyText) {
      return fetch(input as RequestInfo, init);
    }
    return fetch(input as RequestInfo, { ...init, body: patched });
  };
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

export class XiaomiAdapter implements ProviderAdapter {
  readonly name = "xiaomi";

  createModel(config: ProviderConfig): LanguageModel {
    const deepseek = createDeepSeek({
      apiKey: config.apiKey || "",
      baseURL: config.baseUrl || undefined,
      fetch: makeXiaomiFetch(),
    });
    const baseModel = deepseek(config.model);
    return wrapLanguageModel({
      model: baseModel,
      middleware: {
        specificationVersion: "v3",
        transformParams: async ({ params }) => {
          // 在 deepseek 转换器剥离 reasoning 之前先捕获它。
          // 使用 enterWith,使外层异步上下文(包括 doStream 内部
          // 的嵌套 fetch 调用)都能读到该存储。
          const reasonings = extractAssistantReasonings(
            (params.prompt ?? []) as LanguageModelMessage[],
          );
          reasoningStorage.enterWith(reasonings);
          return params;
        },
      },
    });
  }

  buildProviderOptions() {
    return NO_PROVIDER_OPTIONS;
  }

  extractCacheMetrics(
    _providerMetadata: Record<string, unknown> | undefined,
  ): CacheMetrics {
    return NO_CACHE_METRICS;
  }
}

// ---------------------------------------------------------------------------
// 测试辅助(不用于生产环境)
// ---------------------------------------------------------------------------

export const _internal = {
  extractAssistantReasonings,
  patchOutgoingBody,
  reasoningStorage,
};

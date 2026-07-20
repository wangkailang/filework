/**
 * 聊天消息 part 的存储形态。
 *
 * 放在 `core/` 中,以便 JSONL 会话存储、未来的无头 SDK
 * 和渲染器都读取同一份真相来源。渲染器模块
 * (chat/types.ts、ai-elements/confirmation.tsx、ai-elements/tool.tsx、
 * ai-elements/plan-viewer.tsx)从这里再导出 —— 不存在需要
 * 同步维护的平行定义。
 *
 * 这些刻意是纯类型定义:不含 React、DOM、Electron。
 * 渲染器的 UI 组件单独存放并消费这些形态。
 */

import type { ToolPreview } from "../agent/preview/types";
import type { SubAgentResultQuality } from "../agent/sub-agent-contract";

export type { ToolPreview } from "../agent/preview/types";

// ─── 确认 / 审批 ────────────────────────────────────────────────────

export type ApprovalState =
  | "approval-requested"
  | "approval-accepted"
  | "approval-rejected";

// ─── 工具执行状态 ───────────────────────────────────────────────────

export type ToolState =
  | "input-streaming"
  | "input-available"
  | "output-available"
  | "output-error";

export interface ToolApproval {
  toolCallId: string;
  toolName: string;
  description: string;
  state: ApprovalState;
  /**
   * 待执行变更的结构化预览。在审批阶段由主进程的预览
   * 生成器填充。不持久化到 JSONL —— 重新加载后会过期,
   * 因此仅保存在渲染器内存中。缺失时渲染器回退到 `description`。
   */
  preview?: ToolPreview;
}

export interface BatchApprovalEntry {
  toolCallId: string;
  args: unknown;
  description: string;
  /** 参见 {@link ToolApproval.preview}。不持久化。 */
  preview?: ToolPreview;
}

// ─── 计划查看器(数据形态 —— UI 位于 plan-viewer.tsx) ─────────────

export interface PlanSubStepView {
  label: string;
  status: "pending" | "done";
}

export interface PlanStepArtifactView {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  success: boolean;
}

export interface PlanStepView {
  id: number;
  action: string;
  description: string;
  skillId?: string;
  verification?: string;
  subSteps?: PlanSubStepView[];
  artifacts?: PlanStepArtifactView[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  error?: string;
  /**
   * 在该步骤处于活跃 `running` 状态期间累积的推理文本。
   * 由 `useStreamSubscription` 从 `ai:stream-reasoning` 的增量中
   * 填充 —— 当增量到达且某个计划步骤当前正在 `running` 时,
   * 该增量被追加到这里,而不是作为顶层的 `ReasoningPart` 呈现。
   * 持久化到 JSONL,以便思考轨迹始终附着在它所产生的那个步骤上。
   */
  reasoning?: string;
}

export interface PlanView {
  id: string;
  goal: string;
  steps: PlanStepView[];
  status:
    | "draft"
    | "approved"
    | "executing"
    | "completed"
    | "failed"
    | "cancelled";
}

// ─── 错误时呈现的恢复操作 ──────────────────────────────────────────

export type RecoveryAction = "retry" | "settings" | "new_chat";

// ─── MessagePart 变体 ───────────────────────────────────────────────

export interface TextPart {
  type: "text";
  text: string;
}

/**
 * 来自具备推理能力的模型(OpenAI o 系列、DeepSeek-Reasoner、
 * Claude 扩展思考)的隐藏推理 / 扩展思考。渲染为助手文本
 * 上方的可折叠块。持久化到 JSONL,以便用户可以重新打开
 * 对话并查看模型的推理过程。
 */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
  /** `reasoning_end` 触发后即为 true —— UI 据此停止加载动画。 */
  done?: boolean;
}

export interface ToolPart {
  type: "tool";
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: unknown;
  state: ToolState;
  approval?: ToolApproval;
  /**
   * 由审批批处理器捕获、并经 `ai:stream-tool-call` 串联传递的
   * 执行前预览。渲染器的呈现器优先使用它,而非重新读取
   * (此刻已被覆盖的)前镜像。不持久化到 JSONL。
   */
  previewSnapshot?: ToolPreview;
}

export interface PlanMessagePart {
  type: "plan";
  plan: PlanView;
}

export interface ErrorPart {
  type: "error";
  message: string;
  errorType?: string;
  recoveryActions?: RecoveryAction[];
}

export interface UsagePart {
  type: "usage";
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  modelId: string | null;
  provider: string | null;
  latestStepContextTokens?: number | null;
  maxStepContextTokens?: number | null;
}

export interface ContextCompressedPart {
  type: "context-compressed";
  originalTokens?: number | null;
  compressedTokens?: number | null;
}

/**
 * Provider 返回的不可见上下文状态。它会持久化到 JSONL 并在后续请求中
 * 原样回传,但不参与聊天正文渲染。
 */
export interface ProviderContextPart {
  type: "provider-context";
  provider: "openai";
  kind: "compaction";
  itemId: string;
  encryptedContent?: string;
}

export interface ClarificationPart {
  type: "clarification";
  question: string;
  options?: string[];
  /**
   * 该澄清所针对的任务 id。保留用于诊断
   * 以及(遗留的)渲染器逻辑;路由现在改用 clarificationId。
   */
  taskId?: string;
  /**
   * 由 `askClarificationTool` 为每次调用生成的 UUID。渲染器经由
   * `window.filework.answerClarification({ clarificationId, answer })`
   * 将用户的回复路由回挂起的工具。
   * 设为可选以兼容此字段出现之前持久化的 part —— 当其缺失
   * 或已过期(例如重启后任务已不存在)时,IPC 返回
   * `{ok:false}`,渲染器回退为把这次选择当作一次新的对话轮次处理。
   */
  clarificationId?: string;
  /**
   * 用户选中的选项。用户点击按钮后即设置,以便卡片
   * 在重新挂载 / 会话重载时能以已回答状态重新渲染。
   * 与仍处于待回答的 UI 互斥。
   */
  answeredOption?: string;
}

/**
 * 内联生成的图片。在一次 MiniMax image_generation 调用成功后
 * 由 `media-handlers.ts` 写入;通过 `MediaImageCard` 使用
 * `local-file://` 自定义协议渲染。
 *
 * 持久化到 JSONL 会话存储,以便图片在重载后依然存在。
 * `path` 指向的文件位于 `~/.filework/generated/{sessionId}/` 下。
 */
export interface ImagePart {
  type: "image";
  /** 已保存图片的绝对文件系统路径。 */
  path: string;
  /** 原始用户提示词 —— 显示在图片下方。 */
  prompt: string;
  /** 生成它的 LLM 配置 id —— 支持稍后重新生成。 */
  configId: string;
  /** 来自生成调用的短十六进制 id;适合用作 React key。 */
  imageId: string;
  /** 模型标识符(例如 "image-01")。设为可选以向后兼容。 */
  modelId?: string;
}

/**
 * 由 web 工具呈现的图片画廊。当 `webSearch`(带 `includeImages`)
 * 或 `webFetch` 返回非空 `images` 数组时,由流式订阅的渲染器侧
 * 发出 —— 作为同级 part 紧跟在对应的 `tool` part 之后追加,
 * 这样用户看到的是一个可点击的缩略图网格,而不是一堆图片 URL。
 *
 * 区别于 `ImagePart`(单张 MiniMax 生成、保存在
 * `~/.filework/generated/` 下的本地图片):画廊图片是 *远程 URL*,
 * 没有本地副本,可能加载缓慢 / 失败。渲染器必须能逐张
 * 容忍 `onError` 而不破坏整张卡片。
 */
export interface ImageGalleryPart {
  type: "image-gallery";
  /** 哪个工具产出了这些图片 —— 决定卡片标题。 */
  source: "web-search" | "web-fetch" | "other";
  /** 触发该调用的查询 / URL,显示在卡片头部。 */
  context?: string;
  images: Array<{
    /** 绝对的 http(s) 图片 URL。 */
    url: string;
    /** 可选的点击跳转(发现该图片所在的页面)。 */
    sourceUrl?: string;
    /** 可选的说明文字(Tavily 描述或 img alt)。 */
    description?: string;
  }>;
}

/**
 * 由 web 工具呈现的可嵌入视频。对应于
 * `ImageGalleryPart`:当 `webFetch` 返回非空 `videos`
 * 数组(YouTube/Vimeo/Bilibili 的 iframe、<video> 元素、og:video)时,
 * 渲染器追加一个这样的 part,使用户得到缩略图加播放
 * 的卡片,而不是一堆嵌入 URL。
 *
 * 点击加载:先渲染缩略图,iframe / <video> 仅在
 * 用户点击后才挂载,以保持页面轻量,并对 YouTube 嵌入
 * 尊重隐私。
 */
export interface VideoGalleryPart {
  type: "video-gallery";
  source: "web-fetch" | "other";
  /** 触发该调用的 URL / 上下文(用于卡片头部)。 */
  context?: string;
  videos: Array<{
    url: string;
    /** youtube / vimeo / bilibili / twitter / other / 直接 <video> 时为 undefined。 */
    provider?: string;
    /** 可选的封面图(来自 <video poster=> 或 YouTube oEmbed 风格的提示)。 */
    poster?: string;
    /** 可选的 iframe 标题。 */
    title?: string;
    /** 发现该视频所在的页面 —— 点击跳转的小标签。 */
    sourceUrl?: string;
  }>;
}

/**
 * 渲染在画廊 part 上方的轻量文章元信息条。
 * 当页面至少具备 byline / siteName / publishedTime 之一时,
 * 由 `webFetch` / `webFetchRendered` / `webScrape` 的结果组合而成。
 * 外观:favicon · siteName · • · byline · • · publishedTime。
 */
export interface ArticleMetaPart {
  type: "article-meta";
  /** 整个小标签的点击跳转 URL。 */
  pageUrl?: string;
  meta: {
    byline?: string;
    siteName?: string;
    publishedTime?: string;
    lang?: string;
    favicon?: string;
  };
}

/**
 * 进行中或已完成的视频生成任务。第 3 阶段 —— MiniMax 视频
 * 需要 1–5 分钟,因此主进程运行一个 watcher,经由
 * `ai:media-job-update` IPC 事件更新该 part 的
 * `status` / `progressPct` / `resultPath`。
 *
 * 与其他 part 一样持久化到 JSONL,因此渲染器重载后仍能显示
 * 最新已知状态。即便渲染器已不在,watcher 仍会写入 DB;
 * 下次加载时渲染器按 `jobId` 重新订阅。
 */
export interface VideoJobPart {
  type: "video-job";
  jobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  progressPct?: number | null;
  /** 视频下载完成后的绝对文件系统路径。 */
  resultPath?: string | null;
  errorMessage?: string | null;
  prompt: string;
  configId: string;
  modelId?: string;
}

/**
 * 用户附加的文件(image / pdf / text)。在渲染器拖入或选取文件后
 * 由 `chat:attachFile` 创建:源文件被复制到
 * `~/.filework/attachments/{sessionId}/{ts}-{shortId}.{ext}`,
 * 使附件在应用重启后依然存在,且 JSONL 保持精简(仅路径 +
 * 元数据)。
 *
 * 区别于 `ImagePart`(它是 *生成的* 图片):该 part
 * 挂在用户消息上,驱动编辑器侧的小标签,且消息
 * 转换器会遍历 `parts` 来构建发送给 LLM 的用户消息
 * 内容数组。
 *
 * `kind` 是粗粒度的路由标志,供渲染器(图标 vs.
 * 缩略图)和转换器(image content / file content / 内联文本)共同使用。
 */
export type AttachmentKind = "image" | "pdf" | "text";

export interface AttachmentPart {
  type: "attachment";
  /** 位于 `~/.filework/attachments/{sessionId}/` 下的绝对路径。 */
  path: string;
  /** 在小标签中显示的原始文件名。 */
  name: string;
  /** 附加时从扩展名嗅探得到的 MIME。 */
  mimeType: string;
  /** 字节数,在附加时捕获。 */
  size: number;
  /** 路由标志 —— image / pdf / text。 */
  kind: AttachmentKind;
  /** 与时间戳配对的 8 字符十六进制;可安全用作 React key。 */
  attachmentId: string;
}

/**
 * 批量 destructive 工具审批卡片。当 LLM 在一个轮次内发起 N 个
 * 并发 destructive 调用、且主进程通过 `approval-batcher` 将其
 * 合并时发出。一张卡片 → 一次点击即可处理所有条目。
 */
export interface BatchApprovalPart {
  type: "batch-approval";
  batchId: string;
  toolName: string;
  entries: BatchApprovalEntry[];
  state: ApprovalState;
}

/**
 * 单个助手轮次的机器生成交付物。在一个轮次终结时(紧挨在
 * UsagePart 之前)由渲染器的流式订阅追加,完全从该轮次自身的
 * 工具 part 聚合而来 —— 因此文件计数和命令结果都是模型无法
 * 篡改的 *事实*。
 *
 * 区别于逐工具卡片(关于工作是 *如何* 完成的叙述):这是
 * *做了什么* 的呈现面 —— 一份 Codex 风格的变更清单,用户
 * 可以扫读并点击进入 diff dock。持久化到 JSONL,以便
 * 重新打开会话时仍能显示该交付物。
 *
 * 对纯问答轮次(未触碰文件、未运行命令)则完全省略。
 */
export interface TurnSummaryFile {
  /** 工具上报的工作区相对路径或绝对路径。 */
  path: string;
  op: "create" | "modify" | "delete";
  /** 本轮次对该路径所有写入的净新增行数。 */
  added: number;
  /** 本轮次对该路径所有写入的净删除行数。 */
  removed: number;
  /** 有多少次写入调用命中该路径 —— 当 > 1 时 UI 显示 ⟳ N。 */
  writeCount: number;
  /** diff 统计不可用/不可靠(二进制、过大、出错)。 */
  unknownStat?: boolean;
}

export interface TurnSummaryCommand {
  command: string;
  /** 进程退出码;被中断或未知时为 null。 */
  exitCode: number | null;
  kind: "test" | "build" | "generic";
  /** 仅当 test 类命令的输出被成功解析时才存在。 */
  testStats?: { passed: number; failed: number };
}

export interface TurnSummaryPart {
  type: "turn-summary";
  files: TurnSummaryFile[];
  commands: TurnSummaryCommand[];
}

/**
 * 一次 `spawnSubagent` fan-out 中单个子 agent 的实时视图。由
 * `useStreamSubscription` 从 `ai:subagent-*` 事件聚合:spawn 建行
 *(status=running),tool-call/tool-result 累加 toolCalls,child-usage
 * 填 token,report 切终态并填 summary/error。
 */
export interface SubagentChildView {
  childTaskId: string;
  goal: string;
  status:
    | "queued"
    | "running"
    | "ok"
    | "failed"
    | "cancelled"
    | "timeout"
    | "token_limit";
  /** 已观察到的工具调用次数(驱动"步数"显示)。 */
  stepCount: number;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    state: ToolState;
  }>;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  /** report 完成后填充的压缩摘要。 */
  summary?: string;
  /** 结果是否可被父 agent 作为证据采纳。 */
  resultQuality?: SubAgentResultQuality;
  /** 子 agent 返回的结构化结果;通常来自 RESULT_JSON。 */
  artifacts?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  /**
   * 子 agent 的执行过程(文本 / 推理 / 工具调用),供"钻入面板"复用主线程
   * 渲染器回放。由 `useStreamSubscription` 从 ai:subagent-delta / -tool-call /
   * -tool-result 累积。实时运行时由 renderer 内存聚合;冷启动恢复时可从
   * run-event log 物化并落盘,以便重启后仍能钻入查看。缺省/为空 →
   * 钻入面板显示"无过程记录(可能已重载)"。
   */
  parts?: MessagePart[];
}

/**
 * 主 agent 一次 `spawnSubagent` 调用产生的可折叠进度卡。一张卡承载
 * N 个并行子 agent(children),独立于 spawnSubagent 的通用 ToolPart
 *(后者在渲染层被抑制)。持久化到 JSONL,使重载后仍能看到委派结果。
 */
export interface SubagentMessagePart {
  type: "subagent";
  /** runForkBatch 的批次 id,事件路由的定位键。 */
  batchId: string;
  /** 关联的 spawnSubagent 工具调用 id(折叠标题用)。 */
  toolCallId: string;
  concurrency: number;
  children: SubagentChildView[];
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | PlanMessagePart
  | ErrorPart
  | UsagePart
  | ContextCompressedPart
  | ProviderContextPart
  | ClarificationPart
  | ImagePart
  | ImageGalleryPart
  | VideoGalleryPart
  | ArticleMetaPart
  | VideoJobPart
  | AttachmentPart
  | BatchApprovalPart
  | TurnSummaryPart
  | SubagentMessagePart;

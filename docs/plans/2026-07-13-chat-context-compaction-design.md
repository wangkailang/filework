# 对话上下文压缩设计

## 改造前的问题

旧链路混用了累计计费量与单次模型请求的上下文大小。长时间运行的主代理或子代理任务可能在当前请求并不大时错误触发压缩；摘要失败后还可能直接丢弃对话中段。

另外，滚动摘要缺少可靠的消息水位，OpenAI 原生压缩结果没有进入会话持久化链路，工具调用与工具结果也可能在裁剪后失配。OpenAI token 预检虽然能得到精确值，但每个步骤都请求一次会增加延迟和费用。

## 设计目标

- 只用下一次完整模型请求的 token 数控制压缩，不使用累计 usage 或子代理计费量。
- 在语义压缩成功后把上下文收敛到目标预算，而不只是生成摘要。
- 摘要失败且请求仍低于硬上限时保留原始上下文；仅在超过硬上限时执行安全截断。
- 通过稳定消息 ID 推进增量 checkpoint，避免重复摘要和错误覆盖。
- 保持工具调用与工具结果配对，常规压缩时保留最新工具结果。
- 持久化并重放 OpenAI 原生压缩的 opaque context item。
- 在准确性、额外请求延迟和成本之间使用混合 token 计数。

## 上下文指标

以下指标相互独立：

- `billableInputTokens`：成本统计使用的累计输入 token。
- `latestStepContextTokens`：主代理最近一步的输入 token。
- `maxStepContextTokens`：当前任务中主代理单次请求的最大输入 token。
- `renderedRequestTokens`：provider 对下一次完整请求计算的 token。
- `estimatedRequestTokens`：本地对 system prompt、消息和工具 schema 的估算值。

只有 `renderedRequestTokens` 或同一请求的 `estimatedRequestTokens` 可以控制压缩。子代理 usage 仍计入费用，但不能强制压缩主代理历史。

## 预算与触发策略

预算按模型上下文窗口动态计算：

```text
hardBudget = contextWindow - maxOutputTokens - safetyMargin
growthReserve = min(contextWindow * 10%, 32768)
highWater = min(contextWindow * 85%, hardBudget - growthReserve)
lowWater = min(contextWindow * 50%, hardBudget)
```

`highWater` 同时考虑上下文比例和下一步可能增长的空间。GPT-5.5 的 API fallback 上下文窗口为 1,050,000 token，因此高水位是 892,500，低水位目标是 525,000；32K 上下文且输出预留为 8,192 时，高水位为 18,608。

超过高水位后启动语义压缩，并在摘要拼装完成后再次校验输出，使其不超过低水位。只有摘要失败且仍超过 `hardBudget` 时，才进入安全截断。

## 混合 Token 计数

本地估算始终包含 system prompt、历史消息和序列化后的工具定义。官方 OpenAI Responses 且未启用 provider 原生压缩时采用以下策略：

1. 第一个代理步骤调用 `/v1/responses/input_tokens` 获取准确基线。
2. 后续步骤使用“准确基线 + 本地估算增量”计算预计值。
3. 预计值达到高水位或硬预算较小值的 85% 时，再次执行准确计数。
4. provider 计数失败后，当前任务回退到完整本地估算，不重复发送失败请求。
5. 启用 OpenAI 原生压缩时跳过额外 token 预检，由 provider 管理触发。

准确计数请求必须与实际请求一致地包含 `instructions`、`input`、`tools` 和 `tool_choice`。

## 增量 Checkpoint

每个对话 session 持久化以下核心字段：

```ts
interface ContextCheckpoint {
  scopeId: string;
  coveredThroughMessageId: string;
  retainedTailStartId: string | null;
  summary: string;
  summaryVersion: number;
}
```

下一次请求保留固定头部，注入 checkpoint summary，并只加载 `coveredThroughMessageId` 之后的消息。若历史中找不到水位消息，则忽略 checkpoint 并保留完整历史。

只有摘要成功且能找到稳定的 `coveredThroughMessageId` 时，才更新 session checkpoint 和向量 memory chunks。任务级调试摘要可以写入，但不得借此推进 session 水位。

## 工具调用完整性

- 常规语义压缩只压缩旧工具结果，保留最新工具结果原文。
- 裁剪后移除没有对应工具调用的孤立工具结果。
- 工具调用仍存在但结果缺失时，补入明确的占位结果。
- 仅当目标预算无法容纳受保护上下文时，才允许紧急裁剪最新结果。

## OpenAI 原生压缩

`@ai-sdk/openai` 将 Responses 压缩结果表示为 `openai.compaction` custom part。运行时把它转换为隐藏的 `provider-context` part，通过 IPC 写入会话 JSONL，并在后续 OpenAI Responses 请求中还原为 SDK custom part。

重放时只保留最新 compaction boundary 及其后的消息，避免把已经折叠的旧历史重复发送。切换到非 OpenAI provider 或关闭原生压缩时忽略 opaque provider context，继续使用本地 checkpoint 路径。

## 摘要召回

短滚动摘要应完整保留。向量 memory chunks 只在摘要超过字符预算时补充相关事实；召回查询使用最新用户请求，而不是正在被摘要的旧对话中段。

## 失败处理与可观测性

上下文事件记录压缩来源、token 准确度、触发预算、压缩前后 token、消息丢弃数、工具结果修复数及 provider 原生压缩能力。语义摘要失败时不推进 checkpoint；低于硬预算时原样继续，高于硬预算时显式记录安全截断。

## 验证要求

- 累计 usage 和子代理 usage 不会触发主代理上下文压缩。
- 摘要失败时，硬上限以下保留上下文，硬上限以上安全截断。
- 语义压缩成功后的实际结果不超过目标预算。
- checkpoint 不会覆盖没有稳定消息 ID 的历史。
- 最新工具结果与工具调用配对保持完整。
- OpenAI token 计数包含 instructions 和工具 schema，并减少重复预检。
- OpenAI compaction part 能经过 AgentLoop、IPC、JSONL 和下一轮请求完整往返。
- provider 切换不会错误重放 OpenAI opaque context。

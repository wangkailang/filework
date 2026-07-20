# 对话上下文压缩实施记录

**目标：** 升级 `@ai-sdk/openai`，并让面向 GPT-5.5 大上下文的对话压缩具备准确触发、增量处理、失败安全和 provider 感知能力。

**约束：** 保留工作区内与本次任务无关的现有改动；不修改 `src/main/skills-runtime/`；核心逻辑先补回归测试再实现。

## 已完成

- [x] 将 `@ai-sdk/openai` 升级到 `4.0.11`，并确认 Responses 原生 context management 与 compaction custom part 类型。
- [x] 把累计计费 usage、子代理 usage 与单步上下文预算解耦。
- [x] 实现 85% 动态高水位、50% 低水位及最多 32,768 token 的单步增长预留。
- [x] 摘要成功后执行目标预算校验；摘要失败时仅在超过硬预算后安全截断。
- [x] 持久化 `coveredThroughMessageId`、`retainedTailStartId` 和 `summaryVersion`，水位缺失时忽略 checkpoint。
- [x] 只在存在稳定来源消息 ID 时推进 session checkpoint 和 memory chunks。
- [x] 保留短滚动摘要，并使用最新用户请求执行向量召回。
- [x] OpenAI Responses token 计数包含 instructions、input、工具 schema 和 tool choice。
- [x] 实现“首次准确计数、后续增量估算、接近阈值再准确计数”的任务级缓存。
- [x] provider 原生压缩开启时跳过额外 token 预检。
- [x] 常规压缩保留最新工具结果，并修复缺失或孤立的工具结果。
- [x] 将 `openai.compaction` 作为隐藏 provider context 经 AgentLoop、IPC、renderer 和 JSONL 持久化。
- [x] 后续 OpenAI 请求从最新 compaction boundary 重放；切换 provider 时不重放 opaque context。

## 回归覆盖

- checkpoint 水位存在、缺失和 JSONL 往返。
- 摘要失败的硬预算内保留与超预算安全截断。
- 语义压缩后的低水位预算收敛。
- 最新工具结果保留、工具调用结果补全和孤立结果移除。
- OpenAI input token 请求体、工具 schema token 估算和任务级计数缓存。
- 原生 compaction 配置、流事件、IPC 转发、会话持久化和 provider 切换。

## 最终验证

- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm test`
- [x] `pnpm build`
- [x] `git diff --check`

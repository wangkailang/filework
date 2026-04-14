# FileWork 优化方向：基于 Hermes Agent 的分析

> **Last Updated**: 2026-04-13
> **Reference**: [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent)
> **Status**: 规划中

## 背景

Hermes Agent 是 Nous Research 开源的自学习 AI Agent，支持多 provider、多平台、技能自进化、记忆系统等成熟功能。通过对比 Hermes Agent 的架构设计，梳理 FileWork 可以借鉴的优化方向。

---

## 1. 上下文压缩（Context Compression）

### Hermes 的做法

`ContextCompressor` 使用结构化 LLM 摘要，保护头尾消息，按 token 预算裁剪中间轮次，支持迭代更新摘要，还有工具输出预剪枝（无需 LLM 调用的廉价预处理）。

核心策略：
- 保护 head messages（系统提示 + 首轮交互）
- 按 token 预算保护 tail messages（最近约 20K tokens）
- 用廉价模型摘要中间轮次，生成结构化摘要（Resolved/Pending 问题追踪）
- 迭代更新：后续压缩在前次摘要基础上更新，避免信息丢失
- 工具输出预剪枝：压缩前先清理大型工具结果（廉价预处理，不需要 LLM）

### FileWork 现状

`token-budget.ts` 仅做简单的字符估算（1 token ≈ 4 字符）+ 丢弃旧消息，大工具结果用占位符替换。

### 优化方向

- 引入 LLM 辅助摘要压缩（用廉价模型），而非简单丢弃历史
- 增加 "resolved/pending" 问题追踪，保留上下文连续性
- 工具输出预剪枝：在 LLM 压缩前先清理大型工具结果
- 摘要前缀标记，防止模型将摘要当作活跃指令执行

---

## 2. 错误分类与智能恢复（Error Classification & Failover）

### Hermes 的做法

`ErrorClassifier` 对 API 错误做结构化分类：

| 错误类型 | 恢复策略 |
|---------|---------|
| auth (401/403) | 刷新/轮换 credential |
| billing (402) | 立即轮换到其他 credential |
| rate_limit (429) | backoff + 重试 + 轮换 |
| context_overflow | 自动压缩上下文 |
| server_error (500/502) | 重试 |
| overloaded (503/529) | backoff |
| timeout | 重建连接 + 重试 |
| model_not_found (404) | fallback 到其他模型 |

每个 `ClassifiedError` 携带恢复提示：`retryable`、`should_compress`、`should_rotate_credential`、`should_fallback`。

### FileWork 现状

仅判断 `isAuthError()`（401/403），其余错误粗略处理。

### 优化方向

- 建立结构化错误分类体系
- 针对 context overflow 自动触发压缩而非直接报错
- rate limit 时自动 backoff + 重试
- server error 时自动重试（带指数退避）

---

## 3. 智能模型路由（Smart Model Routing）

### Hermes 的做法

`smart_model_routing.py` 根据用户消息复杂度自动选择模型：

- 简单消息 → 走廉价/快速模型
- 复杂消息（含调试、重构、架构设计等关键词，或长文本、代码、URL）→ 走强模型

判断标准：
- 关键词匹配（debug、implement、refactor、analyze 等）
- 消息长度
- 是否包含代码片段或 URL

### FileWork 现状

用户手动选择 LLM 配置，没有自动路由。

### 优化方向

- 简单问题（问候、简短查询）自动走廉价/快速模型
- 复杂任务（调试、重构、多文件操作）走强模型
- 降低用户成本，提升响应速度
- 可设置为可选功能，让用户选择是否启用自动路由

---

## 4. Prompt Caching

### Hermes 的做法

`prompt_caching.py` 实现 Anthropic 的 `system_and_3` 缓存策略：

- 使用 4 个 `cache_control` 断点（Anthropic 最大值）
- 断点 1：系统提示（跨所有轮次稳定）
- 断点 2-4：最近 3 条非系统消息（滚动窗口）
- 降低约 75% 的输入 token 成本

### FileWork 现状

无 prompt caching 机制。

### 优化方向

- 对 Anthropic 模型启用 prompt caching（Vercel AI SDK 支持 `cacheControl` 选项）
- 系统提示是高度稳定的，特别适合缓存
- 滚动窗口策略：缓存最近几条消息，降低多轮对话成本

---

## 5. Credential Pool & Rate Limit 追踪

### Hermes 的做法

**Credential Pool**：
- 同一 provider 配置多个 API key
- 支持多种轮换策略：fill_first、round_robin、random、least_used
- 当某个 key exhausted（429/402）后自动冷却 1 小时，切换到下一个

**Rate Limit Tracker**：
- 从响应头解析 `x-ratelimit-*` 信息
- 追踪 RPM/RPH/TPM/TPH 的 limit/remaining/reset
- 在 `/usage` 命令中展示剩余额度

### FileWork 现状

每个 provider 单一 API key，无 rate limit 感知。

### 优化方向

- 支持同一 provider 多 key 配置，exhausted 后自动切换
- 解析 `x-ratelimit-*` 响应头，展示剩余额度
- 在设置界面展示当前 rate limit 状态

---

## 6. 子目录上下文发现（Subdirectory Hints）

### Hermes 的做法

`SubdirectoryHintTracker` 在工具调用时懒加载子目录下的上下文文件：

- 监听工具调用中的路径参数（path、file_path 等）
- 首次访问某子目录时，扫描 `AGENTS.md` / `CLAUDE.md` / `.cursorrules`
- 将发现的上下文注入到工具结果中（不修改系统提示，保留 prompt caching）
- 限制每个 hint 文件最大 8000 字符，防止上下文膨胀
- 最多向上遍历 5 层父目录

### FileWork 现状

仅在 workspace 根目录级别工作，无子目录上下文感知。

### 优化方向

- 当用户浏览/操作子目录时，自动发现并加载子目录的上下文文件
- 帮助 AI 更好地理解项目各部分的约定和结构
- 注入到工具结果而非系统提示，避免破坏缓存

---

## 7. 用量洞察（Usage Insights）

### Hermes 的做法

`InsightsEngine` 分析历史会话数据：

- Token 消耗统计（输入/输出/缓存读取/缓存写入）
- 成本估算（按模型定价计算 USD）
- 工具使用模式和频率
- 活跃趋势（按天/周）
- 模型和平台分布
- 会话时长和轮次统计

### FileWork 现状

无用量统计或成本追踪。

### 优化方向

- 记录每次会话的 token 消耗（已有 task 表，可扩展字段）
- 提供成本估算（按主流模型定价计算）
- 工具使用频率统计
- 在设置或专门页面展示统计面板

---

## 8. 记忆系统增强（Memory with Nudges）

### Hermes 的做法

`MemoryManager` 架构：

- 支持内置 + 外部记忆 provider（最多一个外部）
- 预取（prefetch）：每轮对话前加载相关记忆
- 同步（sync）：每轮对话后保存新记忆
- 使用 `<memory-context>` 标签做安全隔离，防止模型将记忆当作用户输入
- 主动提醒（nudges）：周期性提醒 agent 持久化重要信息
- FTS5 全文搜索：支持跨会话搜索历史对话

### FileWork 现状

无跨会话记忆系统。会话历史持久化在 SQLite，但没有语义记忆。

### 优化方向

- 引入持久化记忆，跨会话保留用户偏好和项目上下文
- 自动记忆管理（AI 自主决定何时保存/更新/删除记忆）
- 安全边界隔离（防止记忆内容被当作指令执行）
- 记忆检索：基于当前对话上下文自动加载相关记忆

---

## 优先级建议

按投入产出比排序：

| 优先级 | 方向 | 理由 |
|-------|------|------|
| P0 | 上下文压缩 | 直接提升长对话体验，技术可行性高 |
| P0 | 错误分类与恢复 | 显著提升稳定性，实现相对简单 |
| P1 | Prompt Caching | 成本节省明显，Vercel AI SDK 已有支持 |
| P1 | 用量洞察 | 用户可见价值高，实现简单 |
| P2 | 智能模型路由 | 自动降本提速，需要启发式调优 |
| P2 | Credential Pool | 提升高频使用场景可用性 |
| P3 | 子目录上下文发现 | 锦上添花，面向开发者用户 |
| P3 | 记忆系统 | 长期价值大，但实现复杂度高 |

---
title: 2026-04-13 AI Pipeline Optimizations (Hermes Agent Patterns)
---

# AI Pipeline Optimizations

Date: 2026-04-13
Author: AI Assistant
Type: Feature Enhancement
Reference: [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent)

## Summary

基于 Hermes Agent 的成熟模式，为 FileWork 的 AI 管道引入 4 项核心优化：错误分类与自动重试、Token 用量追踪、LLM 辅助上下文压缩、Anthropic Prompt Caching。

## Motivation

FileWork 原有的 AI 管道存在几个短板：
- 错误处理粗略，仅识别 auth error（401/403），其余错误直接抛出
- 上下文管理简单，超出 token 预算时直接丢弃旧消息，丢失重要上下文
- 无 Prompt Caching，每次请求重新发送完整 system prompt，浪费 token
- 无用量追踪，用户无法了解 token 消耗和成本

## Changes

### 1. Error Classification & Auto-Retry

**新增 `src/main/ai/error-classifier.ts`**

结构化错误分类系统，将 API 错误分为 6 类，每类有对应的恢复策略：

| 错误类型 | 触发条件 | 恢复策略 |
|---------|---------|---------|
| `auth` | 401/403/Unauthorized | 不重试，提示用户检查配置 |
| `rate_limit` | 429/rate limit/quota | 指数退避重试，最多 3 次 |
| `context_overflow` | context_length/max_tokens | 标记需压缩，重试 1 次 |
| `server_error` | 500/502/503/504 | 退避重试，最多 2 次 |
| `timeout` | ETIMEDOUT/ECONNRESET | 退避重试，最多 2 次 |
| `unknown` | 其他 | 不重试 |

提供 `withRetry(fn, opts)` 通用重试包装器：
- 指数退避（backoffMs × 2^attempt）
- 尊重 AbortSignal，可取消重试
- `onRetry` 回调通知 UI 重试状态

**修改 `src/main/ipc/ai-handlers.ts`**：
- streaming 调用包裹在 `withRetry` 中
- 发送 `ai:stream-retry` 事件通知 renderer（包含 attempt、error type、maxRetries）

**修改 `src/main/ipc/ai-models.ts`**：
- `isAuthError` 标记 `@deprecated`，内部委托给 `classifyError`

### 2. Usage Tracking

**修改 `src/main/db/schema.ts`**：
- tasks 表新增 5 个字段：`input_tokens`、`output_tokens`、`total_tokens`、`model_id`、`provider`

**修改 `src/main/db/index.ts`**：
- 添加自动迁移逻辑（`pragma table_info` 检查 + `ALTER TABLE ADD COLUMN`）
- Task 接口和 `updateTask` 函数支持新字段

**新增 `src/main/ipc/usage-handlers.ts`**：
- `usage:getTaskUsage` — 查询单个任务的 token 用量
- `usage:getAggregateUsage` — 聚合统计（支持按时间范围/provider 过滤，按 provider 和 model 分组）
- `usage:getRecentUsage` — 最近 N 条任务用量列表

**修改 `src/main/ipc/ai-handlers.ts`**：
- 流式完成后读取 Vercel AI SDK 的 `result.usage`，写入 DB
- 任务创建时记录 modelId 和 provider

### 3. Context Compression (LLM-Assisted)

**新增 `src/main/ai/context-compressor.ts`**

使用 LLM 摘要压缩长对话，替代简单的丢弃策略：

算法流程：
1. **工具输出预剪枝**（免费，无 LLM 调用）— 清理大型工具结果
2. **保护 head**（前 2 条消息）— 系统提示 + 首轮交互
3. **保护 tail**（最近 ~20K tokens）— 最新上下文
4. **LLM 摘要 middle** — 用 `generateText` 生成结构化摘要（已完成/待处理/关键上下文）
5. **组装结果** — `[head, summaryMessage, tail]`

安全措施：
- 摘要前缀标记，防止模型将其当作活跃指令执行
- LLM 调用失败时自动回退到简单丢弃策略

**修改 `src/main/ai/token-budget.ts`**：
- `compressToolResults` 导出为 public 函数
- 新增 `truncateToFitAsync` — 异步版本，支持可选 compressor 回调
- 原 `truncateToFit` 保持不变，确保向后兼容

### 4. Prompt Caching (Anthropic)

**新增 `src/main/ai/prompt-caching.ts`**

为 Anthropic 模型启用 ephemeral prompt caching：
- 通过 Vercel AI SDK 的 `providerOptions` 注入 `cacheControl: { type: "ephemeral" }`
- 缓存 system prompt 和对话前缀，降低约 75% 的输入 token 成本
- 非 Anthropic provider 返回空对象（no-op）

**修改 `src/main/ipc/ai-handlers.ts`**：
- 读取 LLM config 获取 provider
- `streamText` 调用时注入 `providerOptions`

### 5. Preload API 扩展

**修改 `src/preload/index.ts`**：
- 新增 `onStreamRetry` 事件监听（用于 UI 显示重试状态）
- 新增 `usage` API 组（getTaskUsage、getAggregateUsage、getRecentUsage）

## Files Changed

### New Files (4)
- `src/main/ai/error-classifier.ts`
- `src/main/ai/context-compressor.ts`
- `src/main/ai/prompt-caching.ts`
- `src/main/ipc/usage-handlers.ts`

### Modified Files (6)
- `src/main/ipc/ai-handlers.ts`
- `src/main/ipc/ai-models.ts`
- `src/main/db/schema.ts`
- `src/main/db/index.ts`
- `src/main/ai/token-budget.ts`
- `src/preload/index.ts`

## Verification

- `pnpm build` — 编译通过
- `pnpm lint` — 零新增错误，仅保留预存 warnings
- DB 迁移安全：使用 `ALTER TABLE ADD COLUMN`（nullable），向后兼容
- 所有新功能均有降级回退：LLM 压缩失败回退到丢弃策略、重试超限后正常抛出错误

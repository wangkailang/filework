---
title: 2026-04-18 基于 Craft Agents OSS 的六项架构优化
---

# 基于 Craft Agents OSS 的六项架构优化

Date: 2026-04-18
Author: AI Assistant
Type: Performance / UX / Architecture
Reference: https://github.com/lukilabs/craft-agents-oss

## Summary

通过对比 Craft Agents OSS 的设计模式与 filework 现有实现，落地六项优化：流式事件批处理、结构化错误恢复、权限白名单、大响应自动摘要、Provider 抽象层、会话分支。

## Changes

### 1. 流式事件批处理 (Delta Batching)

将高频 `ai:stream-delta` IPC 事件合并到 50ms 时间窗口内发送，减少 renderer 的 React 状态更新频率。

- **新增** `src/main/ai/delta-batcher.ts` — `DeltaBatcher` 类，支持 `push()`/`drain()` 接口
- **修改** `src/main/ipc/ai-handlers.ts` — 在流式循环中用 DeltaBatcher 替代逐条发送
  - tool-call / error 事件前自动 `drain()` 保证事件顺序
  - finally 块中 `drain()` 确保不丢尾部数据

### 2. 结构化错误恢复 (Error Recovery Actions)

每种错误类型携带 `recoveryActions` 数组，UI 按数据驱动渲染操作按钮，替代原有硬编码的条件判断。

- **修改** `src/main/ai/error-classifier.ts`
  - 新增 `RecoveryAction` 类型：`retry | settings | new_chat | check_network`
  - 新增 `proxy_intercepted` 错误类型，检测 Cloudflare / 防火墙 / CAPTCHA 拦截
  - `ClassifiedError` 接口新增 `recoveryActions` 字段
- **修改** `src/preload/index.ts` — `onStreamError` 透传 `recoveryActions`
- **修改** `src/renderer/components/chat/types.ts` — `ErrorPart` 新增 `recoveryActions` 字段
- **修改** `src/renderer/components/chat/useChatSession.ts` — 传递 recovery actions
- **修改** `src/renderer/components/chat/ChatPanel.tsx`
  - 新增 `RecoveryButton` 组件和 `fallbackRecoveryActions()` 函数
  - 内联错误和 fallback banner 均使用数据驱动渲染

### 3. 权限 Session 白名单

用户在一次任务中批准某类危险工具后，同任务内后续同类操作自动放行，减少审批弹窗疲劳。

- **修改** `src/main/ipc/ai-task-control.ts`
  - 新增 `taskToolWhitelist` Map 及 `whitelistToolForTask()` / `isToolWhitelistedForTask()` 函数
  - `cleanupTask()` 中清理白名单
- **修改** `src/main/ipc/ai-tools.ts`
  - `requestApproval()` 前检查白名单，命中则跳过审批
  - 用户批准后调用 `whitelistToolForTask()` 记录

### 4. 大响应自动摘要

工具结果超过 60KB 时，使用 LLM 生成结构化摘要替代简单截断，保留语义信息。

- **新增** `src/main/ai/result-summarizer.ts`
  - `summarizeLargeToolResults()` 函数，遍历 tool role 消息中的大结果
  - 30s 超时，失败回退到前 2000 字符截断
  - 最大输入 200K 字符防止喂入超长内容
- **修改** `src/main/ipc/ai-handlers.ts` — 在 `convertToCoreMessages` 后、`truncateToFitAsync` 前调用摘要

### 5. Provider 抽象层 (Adapter Pattern)

将 provider 特定逻辑从分散的多个文件收拢到统一的 adapter 类中。新增 provider 只需一个文件 + 注册一行。

- **新增** `src/main/ai/adapters/base.ts` — `ProviderAdapter` 接口、`CacheMetrics` 类型
- **新增** `src/main/ai/adapters/anthropic.ts` — Anthropic adapter（缓存控制 + 缓存指标提取）
- **新增** `src/main/ai/adapters/openai.ts` — OpenAI adapter（含 custom endpoint 逻辑）
- **新增** `src/main/ai/adapters/deepseek.ts` — DeepSeek adapter
- **新增** `src/main/ai/adapters/index.ts` — adapter 注册表，`getAdapter()` / `createModelWithAdapter()`
- **修改** `src/main/ipc/ai-models.ts` — 重构为使用 adapter 注册表，新增 `getModelAndAdapterByConfigId()`
- **修改** `src/main/ipc/ai-handlers.ts`
  - 使用 `adapter.buildProviderOptions()` 替代 `buildProviderOptions()`
  - 使用 `adapter.extractCacheMetrics()` 替代 40 行 provider 特定的元数据解析

### 6. 会话分支 (Session Branching)

支持从任意用户消息点 fork 出新对话分支，复制该消息及之前的所有历史。

- **修改** `src/main/db/schema.ts` — `chatSessions` 新增 `forkFromSessionId` / `forkFromMessageId` 列
- **修改** `src/main/db/index.ts`
  - 新增 `forkChatSession()` 函数，事务内创建新 session 并复制消息
  - 启动时自动迁移新增列
- **修改** `src/main/ipc/chat-handlers.ts` — 注册 `chat:forkSession` IPC handler
- **修改** `src/preload/index.ts` — 暴露 `forkChatSession()` 到 renderer
- **修改** `src/renderer/components/chat/useChatSession.ts` — 新增 `handleForkSession()` 方法
- **修改** `src/renderer/components/chat/ChatPanel.tsx` — 用户消息 hover 显示 GitBranch 分支按钮

## File Summary

| 类别 | 新增 | 修改 |
|------|------|------|
| Delta 批处理 | `src/main/ai/delta-batcher.ts` | `src/main/ipc/ai-handlers.ts` |
| 错误恢复 | — | `error-classifier.ts`, `ChatPanel.tsx`, `types.ts`, `useChatSession.ts`, `preload/index.ts` |
| 权限白名单 | — | `ai-task-control.ts`, `ai-tools.ts` |
| 大响应摘要 | `src/main/ai/result-summarizer.ts` | `src/main/ipc/ai-handlers.ts` |
| Provider 抽象层 | `src/main/ai/adapters/` (4 files) | `ai-models.ts`, `ai-handlers.ts` |
| 会话分支 | — | `schema.ts`, `db/index.ts`, `chat-handlers.ts`, `preload/index.ts`, `useChatSession.ts`, `ChatPanel.tsx` |

## Verification

- TypeScript: `npx tsc --noEmit` — 0 errors
- Lint: `npx biome check` — 新代码无 error
- Tests: `npx vitest run` — 12 files, 119 tests all passed

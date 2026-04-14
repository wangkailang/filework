---
title: 2026-04-14 Usage Panel & Error UX Enhancements
---

# Usage Panel & Error UX Enhancements

Date: 2026-04-14
Author: AI Assistant
Type: Feature / UX Improvement

## Summary

新增用量统计面板（UsagePanel），完善错误分类在前端的展示与交互，优化 ModelSelector 体验，统一代码格式（tab → 2-space）。

## Motivation

上一版（20260413）完成了后端的错误分类、用量追踪、上下文压缩、Prompt Caching 四项核心能力，但前端尚未消费这些数据。用户无法查看 token 用量，错误发生时也只能看到原始错误消息，缺乏分类提示和操作引导。

## Changes

### 1. UsagePanel — 用量统计面板

**新增 `src/renderer/components/settings/UsagePanel.tsx`**

设置弹窗中新增「用量统计」Tab，展示：
- 总计 Token 用量（Input / Output / Total）及任务数
- 按 Provider 分组的用量明细
- 按 Model 分组的用量明细
- 最近 10 条任务的 Token 使用记录

数据通过 `window.filework.usage` API（getAggregateUsage / getRecentUsage）获取。

**修改 `src/renderer/components/layout/SettingsModal.tsx`**：
- 新增 `usage` Tab，挂载 `UsagePanel` 组件
- Tab 类型扩展为 `"general" | "llm" | "usage"`

### 2. 错误分类 UI 展示

**修改 `src/renderer/components/chat/ChatPanel.tsx`**：
- 新增 `ErrorPart` 渲染逻辑：根据错误类型（auth / billing / rate_limit / context_overflow / server_error / timeout）显示中文标签和操作建议
- 可重试错误（server_error / timeout / rate_limit / unknown）显示「重试」按钮，自动重发最后一条用户消息
- 认证/余额错误显示「检查配置」按钮，直接跳转设置面板 LLM Tab
- 新增重试状态提示条（RetryInfo）：显示当前重试次数和原因
- 新增流式完成后的 Token 用量显示（输入/输出/总计）

**修改 `src/renderer/components/chat/types.ts`**：
- 新增 `ErrorPart` 类型定义（type: "error", message, errorType?）
- `MessagePart` 联合类型加入 `ErrorPart`

**修改 `src/renderer/components/chat/useChatSession.ts`**：
- 新增 `RetryInfo` / `UsageInfo` / `StreamErrorInfo` 接口
- 监听 `onStreamRetry` 事件，更新重试状态
- 流式完成后调用 `usage.getTaskUsage` 获取本次用量
- 错误事件携带 `type` 字段，存入 `lastError` 状态
- LLM 配置选择持久化到 `localStorage`
- 新增连接超时守卫（connectionTimeoutRef），防止 stream-start 事件丢失时 UI 卡死

### 3. 错误类型透传

**修改 `src/main/ipc/ai-handlers.ts`**：
- `ai:stream-error` 事件新增 `type` 字段（来自 `classifyError` 结果）
- 处理 AI SDK v6 的 `error` stream event：将其重新抛出以触发 withRetry / catch 分类逻辑

**修改 `src/main/ipc/ai-plan-handlers.ts`**：
- Plan 执行和任务执行的错误处理统一使用 `classifyError`，替代旧的 `isAuthError` 判断
- `ai:stream-error` 和 `ai:plan-error` 事件携带分类后的错误类型

### 4. ModelSelector 优化

**修改 `src/renderer/components/chat/ModelSelector.tsx`**：
- 移除 `isDefault` 依赖，选择逻辑简化为 `selectedConfigId || configs[0]`
- 点击展开时重新加载配置列表，确保数据实时性
- 移除列表项中的「default」标签

### 5. LlmConfigPanel 简化

**修改 `src/renderer/components/settings/LlmConfigPanel.tsx`**：
- 移除「设为默认」按钮和默认标签 UI
- 移除 `handleSetDefault` 方法
- 接口定义中移除 `isDefault` 字段

**修改 `src/main/ipc/llm-config-handlers.ts`**：
- `llm-config:update` 处理逻辑分离：常规字段更新与 `setDefaultLlmConfig` 独立调用

### 6. 设置面板跳转

**修改 `src/renderer/components/layout/Sidebar.tsx`**：
- 监听 `filework:open-settings` 自定义事件，支持从错误操作按钮程序化打开设置弹窗

### 7. 代码格式统一

以下文件从 tab 缩进统一为 2-space 缩进（内容逻辑无变化）：
- `src/main/ai/context-compressor.ts`
- `src/main/ai/error-classifier.ts`
- `src/main/ai/prompt-caching.ts`
- `src/main/ai/token-budget.ts`
- `src/main/db/index.ts`
- `src/main/db/schema.ts`
- `src/main/ipc/usage-handlers.ts`
- `src/preload/index.ts`

## Files Changed

### New Files (1)
- `src/renderer/components/settings/UsagePanel.tsx`

### Modified Files (20)
- `src/main/ai/context-compressor.ts` — 格式统一
- `src/main/ai/error-classifier.ts` — 格式统一
- `src/main/ai/prompt-caching.ts` — 格式统一
- `src/main/ai/token-budget.ts` — 格式统一
- `src/main/db/index.ts` — 格式统一
- `src/main/db/schema.ts` — 格式统一
- `src/main/ipc/ai-handlers.ts` — 错误类型透传 + SDK v6 error event 处理
- `src/main/ipc/ai-models.ts` — 无功能变化
- `src/main/ipc/ai-plan-handlers.ts` — 错误分类统一
- `src/main/ipc/llm-config-handlers.ts` — setDefault 逻辑分离
- `src/main/ipc/usage-handlers.ts` — 格式统一
- `src/preload/index.ts` — 格式统一
- `src/renderer/components/chat/ChatPanel.tsx` — 错误 UI + 用量展示 + 重试
- `src/renderer/components/chat/ModelSelector.tsx` — 简化选择逻辑
- `src/renderer/components/chat/types.ts` — ErrorPart 类型
- `src/renderer/components/chat/useChatSession.ts` — 重试/用量/错误状态管理
- `src/renderer/components/layout/SettingsModal.tsx` — 用量 Tab
- `src/renderer/components/layout/Sidebar.tsx` — 设置面板跳转事件
- `src/renderer/components/settings/LlmConfigPanel.tsx` — 移除默认标记 UI
- `tsconfig.tsbuildinfo` — 构建缓存更新

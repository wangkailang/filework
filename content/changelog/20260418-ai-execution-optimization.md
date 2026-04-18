---
title: 2026-04-18 AI Execution Optimization
---

# AI Execution Optimization

Date: 2026-04-18
Author: AI Assistant
Type: Performance / Reliability / Security

## Summary

解决复杂计划执行时长期无响应、工具审批阻塞、上下文压缩超时等问题。新增流式监控（Watchdog）、步骤级超时、计划自动审批（带路径安全校验），并在 UI 层增加耗时和卡顿指示。

## Motivation

执行多步骤计划（如批量修改 PPT）时，用户反馈任务经常"卡住"：
1. **审批阻塞**：每个 `writeFile` 调用都需要用户手动点击审批，但计划执行期间审批弹窗不明显，导致 30 秒以上的空等
2. **无进度反馈**：步骤内部长时间无数据时，UI 无法区分"正在处理"和"真的卡死"
3. **无超时保护**：LLM 调用、工具执行、审批等待均无超时机制，可无限阻塞
4. **上下文压缩阻塞**：长对话的 LLM 压缩调用无超时，可能卡住主流程

## Changes

### 1. StreamWatchdog — 流式监控

**新增 `src/main/ai/stream-watchdog.ts`**

监控流式数据活跃度，提供：
- `WatchdogEventType` 联合类型：`"stall-warning" | "stall-recovered" | "stall-timeout"`
- 空闲 30 秒触发 `stall-warning`，通知渲染端显示卡顿提示
- 恢复数据流时发送 `stall-recovered`
- 空闲超过 5 分钟触发硬超时 `stall-timeout`，自动 abort 当前流
- `createTimeoutController(timeoutMs, parentSignal?)` 工具函数：创建带超时的 AbortController，自动转发父信号，cleanup 时移除所有监听器

### 2. 步骤级超时

**修改 `src/main/planner/executor.ts`**

- 每个计划步骤使用 `createTimeoutController` 设置 5 分钟超时
- 超时后标记步骤为 `failed`，显示中文错误提示「步骤超时 (300s)，已自动跳过」
- 每个步骤启动独立的 `StreamWatchdog` 实例，`try/finally` 确保清理

### 3. 主任务流式监控

**修改 `src/main/ipc/ai-handlers.ts`**

- 主任务执行（非计划）同样启动 `StreamWatchdog`，检测 LLM 响应卡顿
- 每个流式 part 到达时调用 `watchdog.activity()` 重置空闲计时器
- `try/finally` 确保 watchdog 停止

### 4. 工具审批超时

**修改 `src/main/ipc/ai-tools.ts`**

- `requestApproval` 新增 5 分钟超时，超时自动拒绝
- 使用 `settle` 闭包保证 Promise 只 resolve 一次（防止 timeout + abort + 用户操作竞争）
- 超时时发送 `ai:approval-timeout` 事件通知渲染端

### 5. 上下文压缩超时

**修改 `src/main/ai/context-compressor.ts`**

- LLM 压缩调用使用 `createTimeoutController` 设置 60 秒超时
- 替换了之前手动实现的 AbortController + setTimeout 模式，修复了父信号监听器泄漏问题
- 新增 `taskId` / `promptSnippet` 参数，支持 Memory Debug 追踪

### 6. 计划自动审批（带安全校验）

**修改 `src/main/ipc/ai-task-control.ts`**

- 新增 `planApprovedTasks: Map<taskId, workspacePath>` — 记录已批准计划的工作区路径
- 封装为 `markPlanApproved(taskId, workspacePath)` / `getPlanApprovedWorkspace(taskId)` API
- `cleanupTask` 时自动清理

**修改 `src/main/ipc/ai-plan-handlers.ts`**

- 提取 `runApprovedPlan` 共享函数，消除 `ai:executePlan` 与 `ai:approvePlan` 约 90 行重复代码
- 执行前调用 `markPlanApproved(id, workspacePath)`

**修改 `src/main/ipc/ai-tool-permissions.ts`**

- 新增 `canAutoApproveWrite(taskId, filePath)` — 验证写入路径在工作区内（`path.resolve` + `startsWith`）
- 新增 `tryAutoApproveWrite(...)` — 共享的自动审批逻辑，发送 `ai:tool-auto-approved` 事件
- `writeFile` 的 execute 中先尝试自动审批，失败则回退到手动审批
- **安全策略**：`writeFile` 仅在路径在工作区内时自动批准；`deleteFile` / `moveFile` 始终需要手动审批

### 7. UI 层改动

**修改 `src/renderer/components/ai-elements/plan-viewer.tsx`**

- 新增 `RunningStepTimer` 组件：显示当前步骤已执行时间（秒/分:秒格式）
- 卡顿时显示 `⚠ 响应缓慢` 提示（amber 色）
- 新增 `isStalled` prop 控制卡顿状态

**修改 `src/renderer/components/chat/useChatSession.ts`**

- 新增 `isStalled` 状态，监听 `onWatchdog` 事件（按 `taskId` 过滤）
- `stall-warning` → `isStalled=true`，`stall-recovered` / `stall-timeout` → `isStalled=false`

**修改 `src/renderer/components/chat/ChatPanel.tsx`**

- 将 `isStalled` 传递给 `PlanViewer` 组件

### 8. Preload IPC 通道

**修改 `src/preload/index.ts`**

- `onWatchdog` — 卡顿检测事件（类型化为 `WatchdogEventType` 联合）
- `onApprovalTimeout` — 审批超时事件
- `onToolAutoApproved` — 工具自动批准事件
- `memoryDebug` — Memory Debug 面板 API

## Files Changed

### New Files (4)
- `src/main/ai/stream-watchdog.ts` — StreamWatchdog 类 + createTimeoutController
- `src/main/ai/memory-debug-store.ts` — Memory Debug 事件存储
- `src/main/ipc/memory-debug-handlers.ts` — Memory Debug IPC 处理
- `src/renderer/components/settings/MemoryDebugPanel.tsx` — Memory Debug 面板

### Modified Files (13)
- `src/main/ai/context-compressor.ts` — 使用 createTimeoutController，修复信号泄漏
- `src/main/ai/prompt-caching.ts` — 类型更新
- `src/main/ipc/ai-handlers.ts` — Watchdog 集成 + Memory Debug 事件 + Cache 追踪
- `src/main/ipc/ai-plan-handlers.ts` — 提取 runApprovedPlan + planApproved 标记
- `src/main/ipc/ai-task-control.ts` — planApprovedTasks Map + 封装 API
- `src/main/ipc/ai-tool-permissions.ts` — canAutoApproveWrite 路径校验 + tryAutoApproveWrite
- `src/main/ipc/ai-tools.ts` — requestApproval 超时 + settle 闭包
- `src/main/planner/executor.ts` — 步骤超时 + Watchdog + StepTimeoutError 检测
- `src/preload/index.ts` — 新增 4 个 IPC 通道
- `src/renderer/components/ai-elements/plan-viewer.tsx` — RunningStepTimer + isStalled
- `src/renderer/components/chat/ChatPanel.tsx` — isStalled 透传
- `src/renderer/components/chat/useChatSession.ts` — isStalled 状态 + watchdog 监听
- `src/renderer/components/layout/SettingsModal.tsx` — Memory Debug Tab

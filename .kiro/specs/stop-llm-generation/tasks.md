# 实现计划：停止 LLM 生成

## 概述

基于 AbortController 实现流式生成中止功能。从主进程 AbortController 注册表开始，逐步添加 IPC 通道、preload 桥接、渲染进程 Hook 集成，最后完成 UI 按钮行为变更。每一步都在前一步基础上构建，确保无孤立代码。

## 任务

- [x] 1. 主进程：AbortController 注册表与 streamText 集成
  - [x] 1.1 在 `src/main/ipc/ai-handlers.ts` 中创建 AbortController 注册表
    - 在模块顶层声明 `const abortControllers = new Map<string, AbortController>()`
    - _需求: 6.1, 7.2_

  - [x] 1.2 在 `ai:executeTask` handler 中集成 AbortController
    - 在 `streamText` 调用前创建 `new AbortController()` 并存入 Map（key 为任务 ID）
    - 将 `controller.signal` 作为 `abortSignal` 参数传递给两处 `streamText` 调用（messages 模式和 prompt 模式）
    - 在 `for await` 循环的 catch 块中检测 `AbortError`，走 completed 路径而非 error 路径
    - 在 finally 块中调用 `abortControllers.delete(id)` 清理引用
    - _需求: 1.2, 1.3, 1.4, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 1.3 为 AbortController 注册表编写属性测试
    - **属性 1: 中止操作查找与执行** — 对于任意已注册的任务 ID，调用 abort 后 signal.aborted 应为 true
    - **验证需求: 1.1, 1.2, 3.2**

  - [ ]* 1.4 为 AbortController 生命周期编写属性测试
    - **属性 6: AbortController 生命周期一致性** — 任务序列执行后注册表应为空
    - **验证需求: 6.1, 6.2, 6.4**

- [x] 2. 主进程：IPC 通道与计划执行中止
  - [x] 2.1 在 `registerAIHandlers()` 中注册 `ai:stopGeneration` IPC handler
    - 使用 `ipcMain.handle("ai:stopGeneration", ...)` 模式
    - 根据 `payload.taskId` 从 Map 中查找 AbortController 并调用 `abort()`
    - 调用后从 Map 中删除该条目
    - 任务 ID 不存在时静默返回 `{ ok: true }`
    - _需求: 1.1, 3.2, 3.3, 7.1, 7.3_

  - [x] 2.2 修改 `src/main/planner/executor.ts` 的 `executePlan` 函数，接受 `abortSignal` 参数
    - 在 `ExecutorOptions` 接口中添加可选的 `abortSignal?: AbortSignal`
    - 将 `abortSignal` 传递给 `executePlan` 内部的 `streamText` 调用
    - 在 `for await` 循环中检测 abort 信号，中止时将当前步骤标记为 completed，剩余步骤标记为 skipped，计划状态更新为 cancelled
    - _需求: 2.1, 2.2, 2.3_

  - [x] 2.3 修改 `ai:approvePlan` handler，将 AbortController 集成到计划执行流程
    - 创建 AbortController 并存入注册表
    - 将 signal 传递给 `executePlan` 调用
    - 在 catch 块中处理 AbortError
    - 在 finally 块中清理 AbortController 引用
    - _需求: 2.1, 6.1, 6.2_

  - [ ]* 2.4 为计划中止后步骤状态编写属性测试
    - **属性 3: 计划中止后步骤状态标记** — 第 K 步 completed，K+1 到 N 步 skipped，计划状态 cancelled
    - **验证需求: 2.1, 2.2, 2.3**

- [x] 3. Checkpoint - 主进程功能验证
  - 确保所有测试通过，如有疑问请向用户确认。

- [x] 4. Preload 桥接与渲染进程集成
  - [x] 4.1 在 `src/preload/index.ts` 的 `api` 对象中添加 `stopGeneration` 方法
    - 添加 `stopGeneration: (taskId: string) => ipcRenderer.invoke("ai:stopGeneration", { taskId })`
    - 放置在 AI 相关方法区域（`executeTask` 附近）
    - _需求: 3.1_

  - [x] 4.2 更新 TypeScript 类型声明以包含 `stopGeneration`
    - 确保 `FileWorkAPI` 类型（由 `typeof api` 自动推导）包含新方法
    - 如有 `window.filework` 的全局类型声明文件，同步更新
    - _需求: 3.1_

  - [x] 4.3 在 `src/renderer/components/chat/useChatSession.ts` 中添加 `handleStopGeneration` 方法
    - 使用 `useCallback` 创建 `handleStopGeneration`，从 `streamTaskIdRef.current` 获取任务 ID
    - 调用 `window.filework.stopGeneration(taskId)`
    - 将该方法添加到 Hook 的返回对象中
    - _需求: 1.1, 4.3_

  - [ ]* 4.4 为中止后内容保留编写属性测试
    - **属性 5: 中止后内容保留完整性** — 已接收的文本和工具调用结果完整保留，isLoading 为 false
    - **验证需求: 5.1, 5.2, 5.3**

- [x] 5. UI：停止按钮行为变更
  - [x] 5.1 修改 `src/renderer/components/ai-elements/prompt-input.tsx` 的 `PromptInputSubmit` 组件
    - 在 `PromptInputSubmitProps` 中添加 `onStop?: () => void` prop
    - 当 `status` 为 `streaming` 或 `submitted` 时，按钮 `type` 改为 `"button"`（而非 `"submit"`），点击时调用 `onStop`
    - 当 `status` 为 `ready` 或 `error` 时，保持 `type="submit"` 的原有行为
    - 将 `aria-label` 从 `"Stop"` 改为 `"停止生成"`（中文无障碍标签）
    - _需求: 4.1, 4.2, 4.3, 4.4_

  - [x] 5.2 修改 `src/renderer/components/chat/ChatPanel.tsx`，将 `handleStopGeneration` 传递给 `PromptInputSubmit`
    - 从 `useChatSession` 解构 `handleStopGeneration`
    - 将其作为 `onStop` prop 传递给 `PromptInputSubmit` 组件
    - _需求: 4.3_

  - [ ]* 5.3 为按钮状态驱动渲染编写属性测试
    - **属性 4: 按钮状态驱动渲染** — streaming/submitted 时显示停止图标和 "停止生成" aria-label，ready/error 时显示发送图标
    - **验证需求: 4.1, 4.2, 4.4**

  - [ ]* 5.4 为停止按钮编写单元测试
    - 测试点击停止状态按钮调用 `onStop` 而非提交表单
    - 测试 `aria-label` 在不同状态下的值
    - _需求: 4.3, 4.4_

- [x] 6. 最终 Checkpoint - 全量验证
  - 确保所有测试通过，如有疑问请向用户确认。

## 备注

- 标记 `*` 的任务为可选测试任务，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求编号，确保可追溯性
- 属性测试使用 fast-check 库，每个属性至少运行 100 次
- Checkpoint 任务用于阶段性验证，确保增量正确性

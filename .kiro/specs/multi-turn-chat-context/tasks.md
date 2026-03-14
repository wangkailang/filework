# 实现计划：多轮对话上下文

## 概述

将 FileWork 的 AI 对话从单轮模式升级为多轮对话模式。实现路径：先创建核心转换与预算模块，再修改前端收集历史，最后修改后端路由和 fork 模式，逐步集成并验证。

## 任务

- [x] 1. 创建 MessageConverter 模块
  - [x] 1.1 创建 `src/main/ai/message-converter.ts`，实现 `convertToCoreMessages` 函数
    - 定义 `HistoryMessage` 接口（`role`、`content`、`parts`）
    - 实现 user 消息 → CoreMessage `{ role: "user", content }` 的转换
    - 实现 assistant 消息中 TextPart → CoreMessage assistant 文本内容的转换
    - 实现 assistant 消息中 ToolPart → assistant `tool-call` + `tool` 角色消息的拆分转换
    - ToolPart 缺少 `result` 时使用占位文本 `"[工具执行结果未记录]"`
    - 忽略 PlanMessagePart，仅处理 TextPart 和 ToolPart
    - 保持消息时间顺序不变
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 1.2 编写 Property 2 属性测试：消息转换文本保真性
    - **Property 2: 消息转换文本保真性（Round-Trip）**
    - 使用 fast-check 生成随机 HistoryMessage[]（含 TextPart），验证转换后提取的文本内容与原始一致
    - **验证: 需求 2.1, 2.2, 2.6, 2.7**

  - [ ]* 1.3 编写 Property 3 属性测试：ToolPart 结构正确性
    - **Property 3: ToolPart 结构正确性**
    - 验证包含 ToolPart 的 assistant 消息转换后生成正确的 tool-call + tool-result 结构
    - 验证缺少 result 时使用占位文本
    - **验证: 需求 2.3, 2.4**

  - [ ]* 1.4 编写 Property 4 属性测试：PlanMessagePart 过滤
    - **Property 4: PlanMessagePart 过滤**
    - 验证包含 PlanMessagePart 的消息数组转换后不包含任何 plan 相关内容
    - **验证: 需求 2.5**

- [x] 2. 创建 TokenBudget 模块
  - [x] 2.1 创建 `src/main/ai/token-budget.ts`，实现 `truncateToFit` 和 `estimateTokens` 函数
    - 实现 `estimateTokens`：字符数 / 4（`Math.ceil`）的 token 估算
    - 实现工具结果压缩策略：超过 2000 字符的 tool-result 替换为摘要占位符
    - 实现早期消息移除策略：从最早的消息开始移除完整轮次
    - 截断后在历史开头插入系统提示说明部分早期对话已省略
    - 处理边界情况：budget 为负数或零时使用默认值 80000，单条消息超预算时截断文本
    - 导出 `DEFAULT_TOKEN_BUDGET = 80000` 常量
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 2.2 编写 Property 8 属性测试：Token 估算公式
    - **Property 8: Token 估算公式**
    - 使用 fast-check 生成随机字符串，验证 `estimateTokens` 结果等于 `Math.ceil(字符数 / 4)`
    - **验证: 需求 4.4**

  - [ ]* 2.3 编写 Property 6 属性测试：截断后符合预算并保留最近消息
    - **Property 6: 截断后符合预算并保留最近消息**
    - 验证截断后 token 数不超过预算
    - 验证输出是原始数组的后缀子序列（保留最近消息）
    - 验证截断时输出开头包含省略提示
    - **验证: 需求 4.2, 4.5**

  - [ ]* 2.4 编写 Property 7 属性测试：压缩优先于移除
    - **Property 7: 压缩优先于移除**
    - 验证仅通过压缩工具结果就能满足预算时，不移除任何消息
    - **验证: 需求 4.3**

- [x] 3. 检查点 - 核心模块验证
  - 确保所有测试通过，如有疑问请询问用户。

- [x] 4. 更新 IPC 层和 Preload Bridge
  - [x] 4.1 更新 `src/preload/index.ts` 中 `executeTask` 的类型定义
    - 在 payload 类型中新增可选字段 `history?: Array<{ role: "user" | "assistant"; content: string; parts?: unknown[] }>`
    - 确保 `FileWorkAPI` 类型自动更新
    - _需求: 6.3_

  - [x] 4.2 更新 `src/main/ipc/ai-handlers.ts` 中 `ai:executeTask` handler 的 payload 类型
    - 在 payload 解构中新增可选的 `history` 字段
    - 当 `history` 存在且非空时，调用 `convertToCoreMessages` 转换历史，再调用 `truncateToFit` 截断
    - 构建 `messages` 数组：截断后的历史 + 当前用户消息 `{ role: "user", content: prompt }`
    - 使用 `streamText({ messages, system })` 替代 `streamText({ prompt })`
    - 当 `history` 为空、不存在或类型不正确时，回退到 `streamText({ prompt })` 模式
    - 保留现有 `system` prompt 不变
    - 转换异常时捕获并回退到 prompt 模式，记录警告日志
    - _需求: 3.1, 3.2, 3.3, 3.4, 6.1, 6.2_

  - [ ]* 4.3 编写 Property 5 属性测试：messages 数组以当前用户消息结尾
    - **Property 5: messages 数组以当前用户消息结尾**
    - 验证构建的 messages 数组最后一条消息为 `{ role: "user", content: currentPrompt }`
    - **验证: 需求 3.3**

- [x] 5. 前端历史收集
  - [x] 5.1 修改 `src/renderer/components/chat/useChatSession.ts` 的 `handleSubmit` 函数
    - 在调用 `executeTask` 前，从 `messages` 中提取 history
    - 排除当前正在生成的助手占位消息（`assistantId`）
    - 每条消息仅保留 `role`、`content`、`parts` 字段，排除 `id`、`sessionId`、`timestamp`
    - 过滤掉 `parts` 中的 PlanMessagePart（`type: "plan"`）
    - 会话无历史消息时发送空数组
    - 将 `history` 字段添加到 `executeTask` 调用的 payload 中
    - _需求: 1.1, 1.2, 1.3, 1.4_

  - [ ]* 5.2 编写 Property 1 属性测试：历史提取排除占位消息并精简字段
    - **Property 1: 历史提取排除占位消息并精简字段**
    - 验证提取的 history 不包含占位消息
    - 验证每条 HistoryMessage 仅包含 `role`、`content`、`parts` 三个字段
    - **验证: 需求 1.1, 1.4**

- [x] 6. Fork 模式上下文传递
  - [x] 6.1 修改 `src/main/skills-runtime/executor.ts` 的 `ExecutionContext` 接口
    - 新增可选字段 `history?: CoreMessage[]`（已转换的对话历史）
    - _需求: 5.1_

  - [x] 6.2 修改 `executeSubagent` 函数，支持 messages 模式
    - 当 `ctx.history` 存在且非空时，使用 `streamText({ messages: [...history, { role: "user", content }], system })` 替代 `streamText({ prompt })`
    - 无历史时保持原有 `prompt` 模式不变
    - _需求: 5.2, 5.3_

  - [x] 6.3 修改 `ai-handlers.ts` 中 fork 模式技能执行路径
    - 在调用 `executeSkill` 前，将转换并截断后的 `CoreMessage[]` 历史传入 `ExecutionContext`
    - 确保 fork 模式技能能感知之前的对话历史
    - _需求: 5.1, 5.2_

- [x] 7. 检查点 - 端到端集成验证
  - 确保所有测试通过，如有疑问请询问用户。
  - 验证 `ai:generatePlan` 和 `ai:checkNeedsPlanning` 接口未被修改（需求 6.4）

## 备注

- 标记 `*` 的任务为可选，可跳过以加速 MVP 交付
- 每个任务引用了具体的需求编号以确保可追溯性
- 检查点确保增量验证
- 属性测试验证通用正确性属性，单元测试验证具体示例和边界情况

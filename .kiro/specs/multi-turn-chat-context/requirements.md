# 需求文档：多轮对话上下文

## 简介

FileWork 当前的 AI 对话为单轮模式——每次用户发送消息时，后端仅接收当前 prompt，LLM 无法感知之前的对话历史。这导致用户在连续对话中（如先让 AI 总结网页内容，再要求保存总结）时，LLM 丢失上下文，无法正确执行后续指令。

本功能将实现多轮对话上下文传递，使 LLM 能够感知完整的对话历史（包括用户消息、助手回复、工具调用及结果），从而支持连贯的多轮交互。

## 术语表

- **Frontend**：Electron 渲染进程，包含 React UI 和 `useChatSession` hook
- **Backend**：Electron 主进程，包含 `ai-handlers.ts` 中的 IPC 处理器
- **ChatMessage**：前端消息数据结构，包含 `role`、`content`、`parts`（TextPart / ToolPart / PlanMessagePart）
- **CoreMessage**：Vercel AI SDK 的消息格式，`streamText` 的 `messages` 参数所需类型
- **MessageConverter**：负责将 ChatMessage[] 转换为 CoreMessage[] 的后端模块
- **ContextWindow**：传递给 LLM 的对话历史窗口，受 token 预算限制
- **Fork_Mode_Skill**：以独立子代理模式运行的技能（如 agent-browser），拥有独立的 `streamText` 调用
- **Token_Budget**：单次 LLM 调用中分配给对话历史的最大 token 数量

## 需求

### 需求 1：前端传递对话历史

**用户故事：** 作为用户，我希望 AI 能记住之前的对话内容，以便我可以在后续消息中引用之前的结果。

#### 验收标准

1. WHEN 用户提交新消息, THE Frontend SHALL 将当前会话的完整 ChatMessage 历史（不含当前正在生成的助手占位消息）连同当前 prompt 一起发送给 Backend
2. THE Frontend SHALL 通过 IPC 通道 `ai:executeTask` 的 payload 中新增 `history` 字段传递 ChatMessage 数组
3. WHEN 会话中没有历史消息时, THE Frontend SHALL 发送空数组作为 `history` 字段值
4. THE Frontend SHALL 仅发送 `role`、`content` 和 `parts` 字段，排除 `sessionId`、`timestamp` 等非必要字段以减少传输体积

### 需求 2：消息格式转换

**用户故事：** 作为开发者，我希望有一个可靠的转换层将前端 ChatMessage 格式映射为 AI SDK CoreMessage 格式，以便 `streamText` 能正确处理多轮对话。

#### 验收标准

1. THE MessageConverter SHALL 将 ChatMessage 中 `role: "user"` 的消息转换为 CoreMessage 的 `user` 角色消息
2. THE MessageConverter SHALL 将 ChatMessage 中 `role: "assistant"` 且包含 TextPart 的消息转换为 CoreMessage 的 `assistant` 角色消息，保留文本内容
3. WHEN ChatMessage 包含 ToolPart 时, THE MessageConverter SHALL 将其转换为 CoreMessage 的 `assistant` 消息中的 `tool-call` 部分，并生成对应的 `tool` 角色消息包含工具结果
4. WHEN ToolPart 缺少 `result` 字段时, THE MessageConverter SHALL 使用占位文本 "[工具执行结果未记录]" 作为工具结果
5. THE MessageConverter SHALL 忽略 PlanMessagePart 类型的消息部分，仅处理 TextPart 和 ToolPart
6. THE MessageConverter SHALL 保持消息的时间顺序不变
7. FOR ALL 有效的 ChatMessage 数组, 经 MessageConverter 转换后再提取文本内容, SHALL 与原始消息的文本内容一致（round-trip 文本保真性）

### 需求 3：后端使用 messages 模式调用 streamText

**用户故事：** 作为用户，我希望 LLM 在回答时能参考之前的对话，而不是每次都从零开始。

#### 验收标准

1. WHEN Backend 收到包含非空 `history` 的 `ai:executeTask` 请求时, THE Backend SHALL 使用 `streamText({ messages })` 替代 `streamText({ prompt })` 进行 LLM 调用
2. WHEN Backend 收到空 `history` 或无 `history` 字段的请求时, THE Backend SHALL 回退到使用 `streamText({ prompt })` 的单轮模式
3. THE Backend SHALL 将转换后的 CoreMessage 数组（历史消息 + 当前用户消息）作为 `messages` 参数传递给 `streamText`
4. THE Backend SHALL 保留现有的 `system` prompt 不变，仅替换 `prompt` 为 `messages`

### 需求 4：对话历史 Token 预算控制

**用户故事：** 作为用户，我希望即使对话很长，AI 也能正常工作而不会因为上下文过长而报错。

#### 验收标准

1. THE Backend SHALL 为对话历史设置可配置的 Token_Budget 上限（默认值为 80000 tokens）
2. WHEN 对话历史的估算 token 数超过 Token_Budget 时, THE Backend SHALL 从最早的消息开始截断历史，保留最近的消息
3. WHILE 截断对话历史时, THE Backend SHALL 优先压缩工具调用结果的内容（将大型工具结果替换为摘要占位符），再考虑移除完整的早期消息轮次
4. THE Backend SHALL 使用字符数除以 4 的简单估算方法计算 token 数量
5. WHEN 历史被截断时, THE Backend SHALL 在截断后的历史开头插入一条系统提示，说明部分早期对话已被省略

### 需求 5：Fork 模式技能的上下文传递

**用户故事：** 作为用户，我希望使用 agent-browser 等技能后，后续对话能引用技能执行的结果。

#### 验收标准

1. WHEN Fork_Mode_Skill 执行时, THE Backend SHALL 将对话历史传递给 `executeSubagent` 函数
2. THE `executeSubagent` 函数 SHALL 使用 `streamText({ messages })` 替代 `streamText({ prompt })`，将历史上下文包含在内
3. WHEN 对话历史中包含之前 Fork_Mode_Skill 的执行结果时, THE Backend SHALL 将这些结果作为历史消息的一部分传递，使当前技能能感知之前的输出

### 需求 6：IPC 接口兼容性

**用户故事：** 作为开发者，我希望新增的历史传递功能向后兼容，不破坏现有的 IPC 接口。

#### 验收标准

1. THE Backend SHALL 将 `history` 作为 `ai:executeTask` payload 的可选字段处理
2. WHEN `history` 字段不存在时, THE Backend SHALL 以单轮模式运行，行为与修改前完全一致
3. THE Frontend SHALL 同步更新 preload bridge 的类型定义，使 `history` 字段在 TypeScript 层面可用
4. THE `ai:generatePlan` 和 `ai:checkNeedsPlanning` 接口 SHALL 保持不变，仅 `ai:executeTask` 接口新增 `history` 字段

# 需求文档

## 简介

本功能为 FileWork 聊天应用添加"停止 LLM 生成"能力。当前用户发送消息后，LLM 流式生成过程无法中断，用户必须等待生成完成。本功能允许用户在 LLM 流式输出过程中随时中止生成，立即停止接收新内容，并保留已生成的部分内容。

## 术语表

- **Chat_Panel**: 聊天面板组件，负责展示对话消息和输入区域
- **Stream_Controller**: 主进程中负责管理 LLM 流式请求生命周期的控制模块
- **Submit_Button**: 输入区域的提交/停止按钮，根据状态切换功能
- **Chat_Session_Hook**: 渲染进程中管理聊天会话状态的 React Hook（useChatSession）
- **IPC_Bridge**: 通过 Electron preload 脚本暴露的主进程与渲染进程之间的通信桥梁
- **AI_Handler**: 主进程中处理 AI 相关 IPC 请求的处理模块（ai-handlers.ts）
- **Plan_Executor**: 主进程中执行计划步骤的模块（executor.ts）

## 需求

### 需求 1：中止普通流式生成

**用户故事：** 作为用户，我希望在 LLM 流式生成回复时能够停止生成，以便节省时间或在发现回复方向不对时及时中断。

#### 验收标准

1. WHEN 用户点击停止按钮, THE Stream_Controller SHALL 中止当前正在进行的 LLM 流式请求
2. WHEN 流式请求被中止, THE AI_Handler SHALL 调用 AbortController 的 abort 方法终止底层 HTTP 连接
3. WHEN 流式请求被中止, THE AI_Handler SHALL 将该任务状态更新为 "completed" 并保存已生成的文本内容
4. WHEN 流式请求被中止, THE AI_Handler SHALL 通过 IPC_Bridge 向渲染进程发送 "ai:stream-done" 事件

### 需求 2：中止计划执行中的流式生成

**用户故事：** 作为用户，我希望在计划执行过程中也能停止当前步骤的 LLM 生成，以便在计划执行不符合预期时及时中断。

#### 验收标准

1. WHEN 用户在计划执行期间点击停止按钮, THE Plan_Executor SHALL 中止当前正在执行的步骤的流式请求
2. WHEN 计划步骤的流式请求被中止, THE Plan_Executor SHALL 将当前步骤标记为 "completed" 并将剩余步骤标记为 "skipped"
3. WHEN 计划执行被中止, THE Plan_Executor SHALL 将整体计划状态更新为 "cancelled"

### 需求 3：IPC 通信通道

**用户故事：** 作为开发者，我需要一个从渲染进程到主进程的 IPC 通道来传递停止信号，以便渲染进程能够请求主进程中止流式生成。

#### 验收标准

1. THE IPC_Bridge SHALL 暴露一个 "ai:stopGeneration" 通道，接受包含任务 ID 的请求
2. WHEN 渲染进程调用停止接口, THE AI_Handler SHALL 根据任务 ID 查找对应的 AbortController 并触发中止
3. IF 传入的任务 ID 不存在或已完成, THEN THE AI_Handler SHALL 忽略该请求并返回成功状态

### 需求 4：停止按钮 UI 交互

**用户故事：** 作为用户，我希望在 LLM 生成时看到一个明确的停止按钮，以便我知道可以中断生成并能方便地操作。

#### 验收标准

1. WHILE LLM 正在流式生成, THE Submit_Button SHALL 显示为停止图标（方形图标）并且可点击
2. WHEN LLM 未在生成, THE Submit_Button SHALL 显示为发送图标（回车图标）并恢复提交功能
3. WHEN 用户点击处于停止状态的 Submit_Button, THE Chat_Session_Hook SHALL 调用停止生成接口而非提交新消息
4. THE Submit_Button SHALL 在停止状态下提供 "停止生成" 的无障碍标签（aria-label）

### 需求 5：已生成内容保留

**用户故事：** 作为用户，我希望停止生成后已经输出的内容被保留在对话中，以便我可以查看已生成的部分回复。

#### 验收标准

1. WHEN 流式生成被中止, THE Chat_Session_Hook SHALL 保留当前助手消息中已接收的所有文本和工具调用结果
2. WHEN 流式生成被中止, THE Chat_Session_Hook SHALL 将 isLoading 状态设置为 false
3. WHEN 流式生成被中止, THE Chat_Session_Hook SHALL 触发对话历史的持久化保存
4. IF 中止时助手消息内容为空, THEN THE Chat_Session_Hook SHALL 保留空消息而非删除该消息

### 需求 6：AbortController 生命周期管理

**用户故事：** 作为开发者，我需要正确管理 AbortController 的生命周期，以便避免内存泄漏和悬挂引用。

#### 验收标准

1. WHEN 新的流式请求开始, THE AI_Handler SHALL 创建一个新的 AbortController 并将其与任务 ID 关联存储
2. WHEN 流式请求完成（正常完成或被中止）, THE AI_Handler SHALL 从存储中移除对应的 AbortController
3. THE AI_Handler SHALL 将 AbortController 的 signal 传递给 Vercel AI SDK 的 streamText 调用
4. IF 流式请求因网络错误或其他异常终止, THEN THE AI_Handler SHALL 清理对应的 AbortController 引用

### 需求 7：并发安全

**用户故事：** 作为开发者，我需要确保停止操作在并发场景下安全执行，以便避免竞态条件导致的异常行为。

#### 验收标准

1. IF 用户在流式生成完成的同一时刻点击停止按钮, THEN THE Stream_Controller SHALL 安全处理该竞态条件而不产生错误
2. THE AI_Handler SHALL 使用 Map 数据结构按任务 ID 隔离存储各请求的 AbortController
3. WHEN 停止信号到达时流式循环已自然结束, THE AI_Handler SHALL 忽略该中止操作并正常完成流程

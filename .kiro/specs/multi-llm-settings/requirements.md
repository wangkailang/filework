# 需求文档

## 简介

将当前通过 `.env` 文件硬编码的单一 LLM 配置方式，改为在应用设置界面中管理多个 LLM 渠道配置。用户可以添加、编辑、删除多个 LLM 提供商配置，并在聊天界面中选择使用哪个 LLM 渠道进行对话。

## 术语表

- **LLM_Config**: 一条 LLM 渠道配置记录，包含提供商类型、API Key、Base URL、模型名称、显示名称等字段
- **Settings_Panel**: 应用设置面板，用户在此管理 LLM 渠道配置
- **Chat_Panel**: 聊天面板组件，用户在此与 AI 对话
- **Model_Selector**: 聊天面板中的 LLM 渠道选择器组件
- **Config_Store**: 数据库中存储 LLM 配置的持久化层
- **AI_Handler**: 主进程中处理 AI 请求的 IPC 处理模块
- **Provider**: LLM 提供商类型，支持 openai、anthropic、deepseek、ollama、custom（OpenAI 兼容端点）

## 需求

### 需求 1：LLM 配置数据持久化

**用户故事：** 作为用户，我希望 LLM 配置保存在应用数据库中而非 `.env` 文件，以便在应用内管理配置且重启后不丢失。

#### 验收标准

1. THE Config_Store SHALL 在数据库中存储 LLM_Config 记录，每条记录包含以下字段：唯一 ID、显示名称、Provider 类型、API Key、Base URL（可选）、模型名称、是否为默认配置
2. WHEN 用户添加一条新的 LLM_Config 时，THE Config_Store SHALL 将该记录持久化到数据库并返回生成的唯一 ID
3. WHEN 用户修改一条 LLM_Config 时，THE Config_Store SHALL 更新数据库中对应记录的字段值
4. WHEN 用户删除一条 LLM_Config 时，THE Config_Store SHALL 从数据库中移除该记录
5. IF 数据库中不存在任何 LLM_Config 记录，THEN THE Config_Store SHALL 从现有 `.env` 文件中读取配置并自动迁移为一条默认 LLM_Config 记录
6. THE Config_Store SHALL 对 API Key 字段进行加密存储，读取时解密返回

### 需求 2：LLM 配置管理界面

**用户故事：** 作为用户，我希望在应用设置面板中添加、编辑和删除多个 LLM 渠道配置，以便灵活管理不同的 AI 服务。

#### 验收标准

1. THE Settings_Panel SHALL 展示所有已保存的 LLM_Config 记录列表，每条显示名称、Provider 类型和模型名称
2. WHEN 用户点击"添加配置"按钮时，THE Settings_Panel SHALL 显示一个表单，包含以下输入项：显示名称、Provider 类型下拉选择、API Key 输入框、Base URL 输入框（可选）、模型名称输入框
3. WHEN 用户选择不同的 Provider 类型时，THE Settings_Panel SHALL 根据 Provider 类型动态调整表单字段（例如 ollama 无需 API Key，custom 需要 Base URL）
4. WHEN 用户提交配置表单且所有必填字段已填写时，THE Settings_Panel SHALL 调用 Config_Store 保存该配置并刷新列表
5. IF 用户提交配置表单但必填字段为空，THEN THE Settings_Panel SHALL 在对应字段旁显示验证错误提示
6. WHEN 用户点击某条配置的"编辑"按钮时，THE Settings_Panel SHALL 以该配置的现有值预填充表单供用户修改
7. WHEN 用户点击某条配置的"删除"按钮时，THE Settings_Panel SHALL 显示确认对话框，确认后删除该配置
8. IF 用户尝试删除唯一的一条 LLM_Config 且该配置为默认配置，THEN THE Settings_Panel SHALL 阻止删除并提示"至少保留一条默认配置"
9. WHEN 用户将某条配置标记为"默认"时，THE Settings_Panel SHALL 将其他配置的默认标记取消，确保同一时间只有一条默认配置
10. THE Settings_Panel SHALL 支持中文、日文、英文三种语言的界面文本，通过现有 i18n 机制实现

### 需求 3：聊天面板 LLM 渠道选择

**用户故事：** 作为用户，我希望在聊天面板中选择使用哪个 LLM 渠道进行对话，以便根据不同场景切换模型。

#### 验收标准

1. WHILE 存在多条 LLM_Config 记录时，THE Chat_Panel SHALL 在输入区域附近显示 Model_Selector 组件
2. THE Model_Selector SHALL 以下拉菜单形式展示所有可用的 LLM_Config，每项显示配置的显示名称和模型名称
3. WHEN 用户未主动选择渠道时，THE Model_Selector SHALL 默认选中标记为"默认"的 LLM_Config
4. WHEN 用户通过 Model_Selector 选择一个不同的 LLM_Config 时，THE Chat_Panel SHALL 在后续消息中使用该配置对应的 Provider 和模型发送请求
5. WHILE 仅存在一条 LLM_Config 记录时，THE Chat_Panel SHALL 隐藏 Model_Selector 并自动使用该唯一配置
6. THE Model_Selector 的选择状态 SHALL 在当前聊天会话内保持一致，切换会话时重置为默认配置

### 需求 4：AI 请求路由

**用户故事：** 作为用户，我希望发送消息时系统根据我选择的 LLM 渠道配置来调用对应的 AI 服务，以便获得正确的模型响应。

#### 验收标准

1. WHEN AI_Handler 收到一条带有 LLM_Config ID 的请求时，THE AI_Handler SHALL 从 Config_Store 读取对应配置，使用该配置的 Provider、API Key、Base URL 和模型名称创建 AI 客户端实例
2. IF AI_Handler 收到的请求未指定 LLM_Config ID，THEN THE AI_Handler SHALL 使用标记为默认的 LLM_Config
3. IF 指定的 LLM_Config ID 在 Config_Store 中不存在，THEN THE AI_Handler SHALL 返回错误信息"所选 LLM 配置不存在"
4. WHEN AI_Handler 使用 Provider 类型为 custom 或 Base URL 不包含 "api.openai.com" 的配置时，THE AI_Handler SHALL 使用 Chat Completions API（openai.chat）而非默认的 Responses API
5. IF AI_Handler 调用 AI 服务时发生认证失败错误，THEN THE AI_Handler SHALL 向渲染进程返回明确的错误信息"API Key 无效或已过期，请在设置中检查该渠道配置"

### 需求 5：IPC 通信层扩展

**用户故事：** 作为开发者，我希望 IPC 通信层支持 LLM 配置的 CRUD 操作和渠道选择，以便渲染进程与主进程正确交互。

#### 验收标准

1. THE AI_Handler SHALL 注册以下 IPC 通道：`llm-config:list`（列出所有配置）、`llm-config:get`（获取单条配置）、`llm-config:create`（创建配置）、`llm-config:update`（更新配置）、`llm-config:delete`（删除配置）
2. THE Preload 层 SHALL 在 `filework` API 对象中暴露对应的 LLM 配置管理方法
3. WHEN 渲染进程调用 `executeTask` 时，THE Preload 层 SHALL 支持在 payload 中传递可选的 `llmConfigId` 字段
4. WHEN 渲染进程调用 `generatePlan` 时，THE Preload 层 SHALL 支持在 payload 中传递可选的 `llmConfigId` 字段

### 需求 6：向后兼容与迁移

**用户故事：** 作为现有用户，我希望升级后应用能自动迁移我在 `.env` 中的配置，无需手动重新配置。

#### 验收标准

1. WHEN 应用首次启动且数据库中无 LLM_Config 记录时，THE Config_Store SHALL 读取 `.env` 文件中的 `AI_PROVIDER`、`AI_MODEL` 及对应 Provider 的 API Key 和 Base URL，自动创建一条 LLM_Config 记录并标记为默认
2. WHILE `.env` 文件中存在 LLM 相关环境变量且数据库中已有 LLM_Config 记录时，THE AI_Handler SHALL 优先使用数据库中的配置，忽略 `.env` 中的值
3. IF 自动迁移过程中 `.env` 文件不存在或相关字段为空，THEN THE Config_Store SHALL 创建一条使用 openai Provider 和 gpt-4o-mini 模型的默认 LLM_Config 记录

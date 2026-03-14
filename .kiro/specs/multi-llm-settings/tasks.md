# 实现计划：多 LLM 渠道配置管理

## 概述

按照数据层 → IPC 层 → Preload 层 → 渲染层的依赖顺序，逐步将 LLM 配置从 `.env` 硬编码迁移到数据库管理，并在 UI 中提供多渠道配置管理和选择功能。使用 TypeScript 实现，测试使用 Vitest + fast-check。

## 任务

- [x] 1. 数据层：新增 llm_configs 表和加密模块
  - [x] 1.1 在 `src/main/db/schema.ts` 中新增 `llmConfigs` Drizzle schema 定义
    - 添加 `llmConfigs` sqliteTable，包含 id、name、provider（枚举 openai/anthropic/deepseek/ollama/custom）、apiKey、baseUrl、model、isDefault、createdAt、updatedAt 字段
    - 在 `src/main/db/index.ts` 的 `initDatabase` 中添加 `llm_configs` 建表 SQL
    - _需求: 1.1_

  - [x] 1.2 创建加密工具模块 `src/main/db/crypto.ts`
    - 实现 `encrypt(plaintext: string): string` 函数，使用 AES-256-GCM 加密，返回 `iv:authTag:ciphertext` 格式
    - 实现 `decrypt(encrypted: string): string` 函数
    - 密钥通过 PBKDF2 从 `app.getPath('userData')` + 固定盐值派生
    - _需求: 1.6_

  - [ ]* 1.3 编写加密模块属性测试
    - **Property 4: API Key 加密往返一致性**
    - 在 `src/main/db/__tests__/crypto.test.ts` 中使用 fast-check 生成任意非空字符串，验证 encrypt 后 decrypt 返回原始值，且密文不等于明文
    - **验证: 需求 1.6**

  - [x] 1.4 在 `src/main/db/index.ts` 中实现 LLM 配置 CRUD 函数
    - 实现 `createLlmConfig`：生成 UUID、加密 apiKey、插入记录、返回完整对象
    - 实现 `getLlmConfigs`：查询所有记录，解密 apiKey 后返回
    - 实现 `getLlmConfig(id)`：按 ID 查询单条记录，解密 apiKey
    - 实现 `updateLlmConfig(id, updates)`：更新指定字段，若含 apiKey 则加密
    - 实现 `deleteLlmConfig(id)`：删除前检查是否为唯一默认配置，是则拒绝
    - 实现 `getDefaultLlmConfig()`：查询 isDefault 为 true 的记录
    - 实现 `setDefaultLlmConfig(id)`：事务中先将所有记录 isDefault 设为 false，再将目标记录设为 true
    - 导出 `LlmConfig` 类型接口
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.6, 2.8, 2.9_

  - [ ]* 1.5 编写 Config Store CRUD 属性测试
    - 在 `src/main/db/__tests__/llm-config.test.ts` 中使用内存 SQLite 数据库
    - **Property 1: LLM 配置 CRUD 往返一致性** — 创建配置后通过 ID 读取，所有字段值一致且 ID 非空
    - **Property 2: 更新操作保留变更** — 更新部分字段后，被更新字段反映新值，未更新字段保持原值
    - **Property 3: 删除操作移除记录** — 删除后通过 ID 查询返回 null
    - **Property 6: 默认配置唯一性不变量** — setDefault 后恰好有且仅有一条 isDefault 为 true
    - **验证: 需求 1.1, 1.2, 1.3, 1.4, 2.9**

  - [x] 1.6 实现 `.env` 迁移逻辑 `migrateLlmConfigFromEnv()`
    - 在 `src/main/db/index.ts` 中实现：检查数据库中是否已有 llm_configs 记录
    - 若无记录，读取 `.env` 中的 `AI_PROVIDER`、`AI_MODEL` 及对应 API Key/Base URL，创建一条默认配置
    - 若 `.env` 不存在或字段为空，创建 openai/gpt-4o-mini 默认配置
    - 在 `initDatabase` 末尾调用此迁移函数
    - _需求: 1.5, 6.1, 6.3_

  - [ ]* 1.7 编写迁移逻辑单元测试
    - 在 `src/main/db/__tests__/llm-config.test.ts` 中测试：有 .env 变量时正确迁移、无 .env 时创建默认配置、已有记录时不重复迁移
    - _需求: 6.1, 6.3_

- [x] 2. 检查点 - 数据层验证
  - 确保所有数据层测试通过，如有问题请向用户确认。

- [x] 3. IPC 层：LLM 配置管理通道和 AI Handler 重构
  - [x] 3.1 创建 `src/main/ipc/llm-config-handlers.ts`，注册 LLM 配置 IPC 通道
    - 实现 `registerLlmConfigHandlers()` 函数
    - 注册 `llm-config:list` → 调用 `getLlmConfigs()`
    - 注册 `llm-config:get` → 调用 `getLlmConfig(id)`
    - 注册 `llm-config:create` → 调用 `createLlmConfig(data)`，包含 Provider 字段验证逻辑
    - 注册 `llm-config:update` → 调用 `updateLlmConfig(id, data)`
    - 注册 `llm-config:delete` → 调用 `deleteLlmConfig(id)`，捕获删除保护错误
    - 在 `src/main/index.ts` 中导入并调用 `registerLlmConfigHandlers()`
    - _需求: 5.1_

  - [ ]* 3.2 编写 Provider 字段验证属性测试
    - 在 `src/main/ipc/__tests__/llm-config-handlers.test.ts` 中
    - **Property 5: Provider 字段验证规则** — 使用 fast-check 生成随机 Provider 和配置输入，验证 openai/anthropic/deepseek 要求 apiKey 必填，ollama/custom 要求 baseUrl 必填，所有 Provider 要求 name 和 model 必填
    - **验证: 需求 2.3, 2.5**

  - [x] 3.3 重构 `src/main/ipc/ai-handlers.ts` 中的 `getAIModel` 为 `getAIModelByConfigId`
    - 将 `getAIModel()` 改为 `getAIModelByConfigId(configId?: string)`
    - 有 configId 时从数据库查询配置；无 configId 时使用默认配置
    - 配置不存在时抛出错误 "所选 LLM 配置不存在"
    - 根据 provider 类型创建对应 AI SDK 实例（openai → createOpenAI, anthropic → createAnthropic, deepseek → createDeepSeek）
    - provider 为 custom 或 baseUrl 不含 "api.openai.com" 时使用 `openai.chat(modelId)`
    - 捕获 401/403 认证错误，返回 "API Key 无效或已过期，请在设置中检查该渠道配置"
    - 更新所有调用点（`executeTask`、`generatePlan`、`approvePlan`）从 payload 中读取 `llmConfigId`
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.5, 6.2_

  - [ ]* 3.4 编写 AI 客户端路由属性测试
    - 在 `src/main/ipc/__tests__/ai-handlers.test.ts` 中，mock AI SDK 工厂函数
    - **Property 8: 配置驱动的 AI 客户端路由** — 验证 getAIModelByConfigId 根据 provider 字段创建对应类型的 AI SDK 实例
    - **Property 9: 自定义端点使用 Chat Completions API** — provider 为 custom 或 baseUrl 不含 "api.openai.com" 时使用 openai.chat()
    - **Property 7: 默认配置解析** — 未传 configId 时使用默认配置
    - **Property 10: 数据库配置优先于环境变量** — 数据库有记录时忽略 .env
    - **验证: 需求 4.1, 4.2, 4.4, 6.2**

- [x] 4. 检查点 - IPC 层验证
  - 确保所有 IPC 层测试通过，如有问题请向用户确认。

- [x] 5. Preload 层：暴露 LLM 配置 API
  - [x] 5.1 修改 `src/preload/index.ts`，在 api 对象中新增 `llmConfig` 命名空间
    - 添加 `llmConfig.list()`、`llmConfig.get(id)`、`llmConfig.create(data)`、`llmConfig.update(id, data)`、`llmConfig.delete(id)` 方法
    - 修改 `executeTask` 方法签名，payload 新增可选 `llmConfigId` 字段
    - 修改 `generatePlan` 方法签名，payload 新增可选 `llmConfigId` 字段
    - 更新 `FileWorkAPI` 类型导出
    - _需求: 5.2, 5.3, 5.4_

- [x] 6. 渲染层：LLM 配置管理界面
  - [x] 6.1 扩展 i18n 翻译文件
    - 在 `src/renderer/i18n/zh-CN/index.ts` 中添加 `llmConfig_*` 系列翻译键（中文）
    - 在 `src/renderer/i18n/en/index.ts` 中添加对应英文翻译
    - 在 `src/renderer/i18n/ja/index.ts` 中添加对应日文翻译
    - 更新 `src/renderer/i18n/i18n-types.ts` 类型定义（如使用 typesafe-i18n 自动生成则运行生成命令）
    - _需求: 2.10_

  - [x] 6.2 创建 `src/renderer/components/settings/LlmConfigPanel.tsx` 配置管理组件
    - 展示所有 LLM 配置列表，每条显示名称、Provider 类型、模型名称
    - 实现"添加配置"按钮和表单对话框（名称、Provider 下拉、API Key、Base URL、模型）
    - 根据 Provider 类型动态调整表单字段（ollama 隐藏 API Key，custom/ollama 显示必填 Base URL）
    - 实现表单验证：必填字段为空时显示错误提示
    - 实现编辑功能：点击编辑按钮，预填充表单
    - 实现删除功能：确认对话框，删除唯一默认配置时阻止并提示
    - 实现默认配置切换：设为默认时取消其他配置的默认标记
    - 使用 i18n 翻译键
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10_

  - [x] 6.3 将 `LlmConfigPanel` 集成到现有设置面板
    - 在设置面板中引入 `LlmConfigPanel` 组件，替换或补充现有的 AI Provider/API Key/Model 设置项
    - _需求: 2.1_

- [x] 7. 渲染层：聊天面板 Model Selector
  - [x] 7.1 创建 `src/renderer/components/chat/ModelSelector.tsx` 组件
    - 下拉菜单展示所有可用 LLM 配置，每项显示显示名称和模型名称
    - 默认选中标记为默认的配置
    - 仅在多条配置时显示，单条时隐藏
    - 通过 props/callback 将选中的 configId 传递给父组件
    - _需求: 3.1, 3.2, 3.3, 3.5_

  - [x] 7.2 修改 `src/renderer/components/chat/useChatSession.ts`，添加 LLM 配置选择状态
    - 在 hook state 中新增 `selectedLlmConfigId` 字段
    - 切换会话时重置为默认配置 ID
    - 在调用 `executeTask` 和 `generatePlan` 时传递 `llmConfigId`
    - _需求: 3.4, 3.6_

  - [x] 7.3 修改 `src/renderer/components/chat/ChatPanel.tsx`，集成 ModelSelector
    - 在输入区域附近渲染 `ModelSelector` 组件
    - 将 `useChatSession` 中的 `selectedLlmConfigId` 和 setter 传递给 ModelSelector
    - _需求: 3.1, 3.4_

- [x] 8. 最终检查点 - 全量验证
  - 确保所有测试通过，如有问题请向用户确认。

## 备注

- 标记 `*` 的子任务为可选测试任务，可跳过以加速 MVP 开发
- 每个任务引用了具体的需求编号，确保可追溯性
- 属性测试验证系统的通用正确性属性，单元测试覆盖具体边界情况
- 检查点任务确保增量验证，避免问题累积

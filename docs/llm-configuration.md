# LLM Configuration and Usage

本文总结 Workspace Agent 的 LLM 配置、连接测试、模型列表刷新、GitHub
Copilot 授权以及聊天运行时如何选择模型。

## 配置模型

LLM 配置保存在本地 SQLite 的 `llm_configs` 表中。敏感字段会在主进程
写入前加密，renderer 只通过 preload 暴露的 IPC 能力创建、更新、测试和删除配置。

主要字段如下：

| 字段 | 说明 |
| --- | --- |
| `name` | UI 中展示的配置名称 |
| `provider` | 供应商类型，例如 `openai`、`custom`、`github-copilot` |
| `apiKey` | Provider API key 或运行时 session token，落库前加密 |
| `authMetadata` | 仅主进程使用的加密授权元数据，例如 Copilot device flow token |
| `baseUrl` | Provider 基础 URL，OpenAI Compatible / Ollama / Copilot 等需要 |
| `apiPath` | 可选 API 路径，必须以 `/` 开头且以 `/chat/completions` 结尾 |
| `model` | 当前使用的模型 ID |
| `modality` | `chat`、`image` 或 `video`；聊天 AgentLoop 只接受 `chat` |
| `enabled` | 是否允许运行时选择该配置 |
| `isDefault` | 默认配置标记 |
| `lastCheckedAt` | 最近一次测试连接时间 |
| `lastCheckStatus` | 最近一次测试结果，`success` 或 `error` |
| `lastCheckMessage` | 测试连接的摘要和诊断信息 |

配置列表按 `updatedAt` 倒序展示，新建或修改过的配置会排在前面。

## 支持的 Provider

| Provider | 用途 | 关键配置 |
| --- | --- | --- |
| `openai` | OpenAI 官方 API | `apiKey`，可选 `baseUrl` |
| `anthropic` | Anthropic Messages API | `apiKey`，可选 `baseUrl` |
| `deepseek` | DeepSeek OpenAI Compatible API | `apiKey`，可选 `baseUrl` |
| `ollama` | 本地 Ollama OpenAI Compatible API | `baseUrl`，通常是 `http://localhost:11434/v1` |
| `minimax` | MiniMax OpenAI Compatible chat，以及图像/视频配置 | `apiKey`，可选 `baseUrl` |
| `xiaomi` | Xiaomi MiMo reasoning 模型 | `apiKey`、`baseUrl` |
| `custom` | 任意 OpenAI Compatible endpoint | `baseUrl`，可选 `apiKey` 和 `apiPath` |
| `github-copilot` | GitHub Copilot chat endpoint | 通过 GitHub device flow 配置 |

`custom`、`ollama`、`minimax`、`github-copilot` 默认复用 OpenAI 适配器。
`xiaomi` 使用专门适配器以保留 `reasoning_content`。

## OpenAI Compatible 配置

OpenAI Compatible 配置用于接入任意兼容 `/chat/completions` 或 Responses
风格的服务。

推荐填写方式：

| 字段 | 示例 |
| --- | --- |
| `provider` | `custom` |
| `baseUrl` | `https://api.example.com/v1` |
| `apiPath` | 留空，或 `/v1/chat/completions` |
| `model` | `gpt-5.5`、`qwen3-coder` 等 |

`apiPath` 只用于把非标准路径规范化。运行时会从 `apiPath` 中去掉
`/chat/completions` 后缀，并把路径前缀合并到 `baseUrl`，避免最终 URL
重复拼接。

例如：

| 输入 | 解析结果 |
| --- | --- |
| `baseUrl=https://api.example.com/v1`，`apiPath` 留空 | `https://api.example.com/v1/chat/completions` |
| `baseUrl=https://api.example.com`，`apiPath=/backend-api/v1/chat/completions` | `https://api.example.com/backend-api/v1/chat/completions` |

配置测试成功后，应用会尽力调用 `{baseUrl}/models` 刷新模型列表，并缓存到
`llm_model_catalog`。模型目录会记录：

- 模型 ID 和展示名
- `preferredApi`：`chat_completions` 或 `responses`
- 是否支持 reasoning、tools、vision
- context window 和 max output tokens，如果 provider 返回了这些信息

如果目录刷新后发现当前 `model` 不在列表里，UI 会提示模型不可用；聊天选择器
和运行时也会避免选择 `modelAvailable === false` 的配置。

## GitHub Copilot 配置

GitHub Copilot 通过 GitHub device authorization flow 连接。

流程如下：

1. 点击“获取授权码”，主进程请求 GitHub device code。
2. 授权码会自动复制，也可以手动复制。
3. 点击“打开授权页面”，在 GitHub 页面输入授权码并完成授权。
4. 回到应用点击“连接 GitHub”，主进程用 device code 换取 GitHub access
   token，再换取 Copilot session token。
5. 应用保存加密后的 Copilot session token 和授权元数据，并把配置标记为
   `enabled`、`lastCheckStatus=success`。

Copilot 配置的运行时维护规则：

- 请求 Copilot API 时会自动附加 `Editor-Version`、`User-Agent` 和
  `Copilot-Integration-Id` header。
- Copilot session token 接近过期时会自动刷新。
- 如果上游返回 401，fetch 包装器会强制刷新 session token 后重试一次。
- 如果本地缺少 device flow 元数据，会按顺序尝试
  `COPILOT_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN`，再尝试 `gh auth token`
  获取 GitHub access token，然后换取新的 Copilot session token。
- 环境变量或 `gh auth token` 里的 GitHub token 不会写回数据库；只会持久化
  换到的短期 Copilot session token 和 base URL。

断开 Copilot 连接会清空保存的 token、清空授权元数据、停用该配置，并允许之后
重新走授权流程。

## 测试连接

测试连接由 `llm-config:test` IPC 触发。

当前测试只支持 `chat` modality。测试请求会发送一个最小 `ping`：

- OpenAI Compatible provider：`POST .../chat/completions`
- Anthropic：`POST .../v1/messages`

测试成功后会更新：

- `lastCheckedAt`
- `lastCheckStatus`
- `lastCheckMessage`

`lastCheckMessage` 包含用户可读摘要和诊断信息：

- 请求方法和 URL
- HTTP 状态码或无 HTTP 响应
- 请求耗时
- 测试的模型 ID

测试成功后会尽力刷新模型目录。模型目录刷新失败不会把连接测试改成失败，因为有
些 provider 支持 chat completions 但不暴露 `/models`。

## 聊天运行时如何选择配置

聊天任务从 `ai:executeTask` 进入主进程。运行时选择 LLM 的流程是：

1. 根据用户选择的 `llmConfigId` 找到配置；如果没有传入，则找默认配置。
2. 检查配置是否可用于聊天：
   - `enabled !== false`
   - `modality === "chat"`
   - `lastCheckStatus === "success"`
   - `modelAvailable !== false`
3. 如果用户选择的配置不可用，则按配置列表顺序回退到最近更新的健康 chat 配置。
4. 通过 `getModelAndAdapterByConfigId` 创建 AI SDK `LanguageModel`。
5. 把模型交给 `AgentLoop` 执行聊天、工具调用、上下文压缩和反思逻辑。

这个 fallback 发生在任务开始前。已经开始输出 token 后，不会在同一条回复中
切换到另一个模型，避免生成内容混用两个 provider。

聊天选择器的 UI 也只展示可用配置：启用、连接测试成功、模型没有被最新目录标记
为不可用。运行时仍会重复检查一次，防止 renderer 状态过期。

## Chat Completions 与 Responses

模型目录中的 `capabilities.preferredApi` 会影响运行时 API 选择：

- `chat_completions`：使用 `openai.chat(model)`
- `responses`：使用 `openai(model)`

默认推断规则会把非 mini 的 `gpt-5` 系列标记为 `responses`，其它 OpenAI
Compatible 模型默认走 `chat_completions`。这解决了同一个 OpenAI Compatible
endpoint 中，不同模型需要不同 API 入口的问题。

## 常见问题

### 测试连接成功，但模型列表刷新失败

这通常说明 provider 支持 chat API，但不支持 `/models`。配置仍可使用，只是
不会得到 `modelAvailable` 和 `preferredApi` 等目录元数据。

### 模型在聊天选择器中消失

确认配置满足以下条件：

- 已启用
- 最近一次测试连接成功
- `modality` 是 `chat`
- 当前模型没有被模型目录标记为不可用

可以在设置中重新测试连接或刷新模型列表。

### Copilot 返回 401

运行时会自动刷新 session token 并重试一次。如果仍失败：

1. 在设置中点击测试连接。
2. 如果测试仍提示授权过期，断开 Copilot 后重新授权。
3. 如果本机已有 GitHub CLI 登录，也可以确认 `gh auth token` 是否可用。

### OpenAI Compatible URL 拼错

优先只在 `baseUrl` 填 provider 的基础 URL，例如 `https://host/v1`。只有
provider 的路径不是标准 `/v1/chat/completions` 时，再填写 `apiPath`。

## 代码索引

| 功能 | 文件 |
| --- | --- |
| 配置增删改查、测试连接、模型刷新 IPC | `src/main/ipc/llm-config-handlers.ts` |
| 连接测试请求构造和诊断 | `src/main/ipc/llm-config-connection.ts` |
| OpenAI Compatible 模型发现 | `src/main/ipc/llm-config-models.ts` |
| GitHub Copilot device flow 和模型发现 | `src/main/ipc/github-copilot-auth.ts` |
| GitHub Copilot session token 维护 | `src/main/ipc/github-copilot-session.ts` |
| 运行时健康配置选择和模型创建 | `src/main/ipc/ai-models.ts` |
| 主聊天任务编排 | `src/main/ipc/ai-handlers.ts` |
| Provider adapter 注册表 | `src/main/ai/adapters/index.ts` |
| OpenAI / OpenAI Compatible adapter | `src/main/ai/adapters/openai.ts` |
| LLM 配置表和模型目录表 | `src/main/db/schema.ts`、`src/main/db/index.ts` |
| 设置页编辑弹窗 | `src/renderer/components/settings/LlmConfigEditModal.tsx` |
| 聊天模型选择器 | `src/renderer/components/chat/ModelSelector.tsx` |


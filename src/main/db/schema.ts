import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
  lastOpenedAt: text("last_opened_at"),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  prompt: text("prompt").notNull(),
  status: text("status", {
    enum: ["pending", "running", "completed", "failed"],
  }).notNull(),
  result: text("result"),
  filesAffected: text("files_affected"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
  // 用量统计字段
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  modelId: text("model_id"),
  provider: text("provider"),
});

export const taskTraceEvents = sqliteTable("task_trace_events", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  type: text("type").notNull(),
  timestamp: text("timestamp").notNull(),
  toolCallId: text("tool_call_id"),
  toolName: text("tool_name"),
  detail: text("detail").notNull(), // JSON 格式
});

export const taskSummaries = sqliteTable("task_summaries", {
  taskId: text("task_id").primaryKey(),
  createdAt: text("created_at").notNull(),
  summary: text("summary").notNull(),
  originalTokens: integer("original_tokens"),
  compressedTokens: integer("compressed_tokens"),
  summaryTokens: integer("summary_tokens"),
});

export const fileOperations = sqliteTable("file_operations", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  operation: text("operation").notNull(),
  sourcePath: text("source_path").notNull(),
  targetPath: text("target_path"),
  backupPath: text("backup_path"),
  createdAt: text("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const recentWorkspaces = sqliteTable("recent_workspaces", {
  path: text("path").primaryKey(),
  name: text("name").notNull(),
  lastOpenedAt: text("last_opened_at").notNull(),
  /** 工作区类型。旧数据行默认为 "local"。 */
  kind: text("kind", { enum: ["local", "github", "gitlab"] })
    .notNull()
    .default("local"),
  /** JSON 编码的 WorkspaceRef。旧数据行为 NULL(按 local 处理)。 */
  metadata: text("metadata"),
});

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  kind: text("kind", {
    enum: ["github_pat", "gitlab_pat", "tavily_pat", "firecrawl_pat"],
  }).notNull(),
  label: text("label").notNull(),
  /** AES-256-GCM 加密后的 token(见 db/crypto.ts)。 */
  encryptedToken: text("encrypted_token").notNull(),
  /** 可选,已授予 scope 的 JSON 数组。 */
  scopes: text("scopes"),
  createdAt: text("created_at").notNull(),
  // M7: 健康监控。
  /** 最近一次测试的 ISO 8601 时间戳。NULL = 从未测试过。 */
  lastTestedAt: text("last_tested_at"),
  testStatus: text("test_status", { enum: ["unknown", "ok", "error"] }),
  /** testStatus === "error" 时的友好错误描述。 */
  lastTestError: text("last_test_error"),
  /**
   * 最近一次成功测试所针对的 host —— 驱动 gitlab_pat 自建实例的自动重测。
   * 在用户至少执行一次手动测试前为 NULL(手动测试会从 GitLab 连接流程中
   * 写入该 host)。
   */
  lastTestedHost: text("last_tested_host"),
});

// chat_sessions / chat_messages —— 已在 M3 PR 2 中移除。
// 当前后端见 `core/session/jsonl-store.ts`。

/**
 * 进行中或已完成的媒体生成任务的持久化记录。
 *
 * Phase 3 为视频生成引入此表:MiniMax 视频请求异步运行 1–5 分钟
 * (submit -> task_id -> 轮询 /v1/query/video_generation -> file_id ->
 * 下载)。持久化该任务可在 renderer 重载后保留状态,并在应用重启后
 * 呈现「上次未完成」的任务。图片生成在 Phase 2 中是同步的,不会写入
 * 此表 —— kind="image" 预留给未来的异步图片流程(或批量生成),
 * 以避免再次变更表结构。
 */
export const mediaJobs = sqliteTable("media_jobs", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  configId: text("config_id").notNull(),
  kind: text("kind", { enum: ["image", "video"] }).notNull(),
  /** 上游任务 id(MiniMax /v1/video_generation 响应)。 */
  providerJobId: text("provider_job_id"),
  prompt: text("prompt").notNull(),
  status: text("status", {
    enum: ["queued", "running", "succeeded", "failed", "canceled"],
  }).notNull(),
  /** 若 provider 返回则为 0–100。完成前通常为 null。 */
  progressPct: integer("progress_pct"),
  /** 产物下载完成后的文件系统绝对路径。 */
  resultPath: text("result_path"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
});

/**
 * 用户让 Agent 创建的自动化定义。
 *
 * 现阶段它是自动化定义的持久化入口:Agent 可通过
 * automation_update 工具创建、更新、禁用或列出定义。后台 runner/UI 可在
 * 这个表上继续演进,不需要再改变 agent 工具契约。
 */
export const automations = sqliteTable("automations", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  prompt: text("prompt").notNull(),
  type: text("type", { enum: ["thread", "standalone", "project"] }).notNull(),
  scheduleKind: text("schedule_kind", {
    enum: ["interval", "daily", "weekly", "cron"],
  }).notNull(),
  scheduleValue: text("schedule_value").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  threadId: text("thread_id"),
  workspacePaths: text("workspace_paths"),
  runMode: text("run_mode", { enum: ["local", "worktree"] }),
  modelId: text("model_id"),
  reasoningEffort: text("reasoning_effort"),
  lastRunAt: text("last_run_at"),
  nextRunAt: text("next_run_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * 自动化每一次执行的持久化记录。自动化定义可以被编辑或删除,run 行保留
 * 执行时的标题/prompt/workspace 快照,供 Triage 与历史回溯使用。
 */
export const automationRuns = sqliteTable("automation_runs", {
  id: text("id").primaryKey(),
  automationId: text("automation_id").notNull(),
  automationTitle: text("automation_title").notNull(),
  trigger: text("trigger", { enum: ["manual", "scheduled"] }).notNull(),
  status: text("status", {
    enum: [
      "queued",
      "running",
      "needs_action",
      "succeeded",
      "failed",
      "canceled",
    ],
  }).notNull(),
  triageStatus: text("triage_status", {
    enum: ["open", "handled"],
  })
    .notNull()
    .default("open"),
  needsActionReason: text("needs_action_reason"),
  chatSessionId: text("chat_session_id"),
  assistantMessageId: text("assistant_message_id"),
  taskId: text("task_id"),
  prompt: text("prompt").notNull(),
  workspacePaths: text("workspace_paths"),
  threadId: text("thread_id"),
  modelId: text("model_id"),
  output: text("output"),
  errorMessage: text("error_message"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  retryCount: integer("retry_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: text("next_retry_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
});

export const automationRunEvents = sqliteTable("automation_run_events", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  message: text("message"),
  toolName: text("tool_name"),
  detail: text("detail"),
  createdAt: text("created_at").notNull(),
});

/**
 * 用户配置的 MCP(Model Context Protocol)服务器。每一行描述一个由主进程
 * 启动或连接的服务器,使其工具可供 agent loop 使用。`env`/`headers` 中的
 * 敏感值应使用 `${env:VAR}` 占位符 —— 运行时展开见 `src/main/mcp/manager.ts`
 * (兼容 Claude Desktop / VS Code)。
 */
export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  transport: text("transport", { enum: ["stdio", "http"] }).notNull(),
  // stdio 字段(transport === "http" 时为 NULL)
  command: text("command"),
  /** JSON.stringify(string[]) —— 传给 `command` 的 CLI 参数。 */
  args: text("args"),
  /** JSON.stringify(Record<string,string>) —— 支持 `${env:VAR}`。 */
  env: text("env"),
  cwd: text("cwd"),
  // http 字段(transport === "stdio" 时为 NULL)
  url: text("url"),
  /** JSON.stringify(Record<string,string>) —— 支持 `${env:VAR}`。 */
  headers: text("headers"),
  /**
   * HTTP MCP 认证方式。`auto` 先按 MCP 认证发现流程静默探测;
   * `oauth` 走手动 OAuth 兜底;`none` 继续使用 headers / env
   * 中的静态凭据。
   */
  authType: text("auth_type", { enum: ["auto", "none", "oauth"] })
    .notNull()
    .default("auto"),
  /** JSON.stringify(string[]) —— OAuth 登录时请求的 fallback scopes。 */
  oauthScopes: text("oauth_scopes"),
  /** 预注册 OAuth client id;为空时使用服务端动态注册。 */
  oauthClientId: text("oauth_client_id"),
  /** 加密后的预注册 OAuth client secret。 */
  oauthClientSecret: text("oauth_client_secret"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /**
   * trusted=true 时,将该服务器的每个工具都视为 `safe` —— 绕过
   * `beforeToolCall` 审批门控。trusted=false 时,调用会像任何其他
   * `destructive` 工具一样走审批流程。
   */
  trusted: integer("trusted", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** MCP OAuth 登录状态:动态 client、token、PKCE verifier、discovery cache。 */
export const mcpOAuthSessions = sqliteTable("mcp_oauth_sessions", {
  serverId: text("server_id").primaryKey(),
  encryptedSession: text("encrypted_session").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** 技能信任:市场安装 / 外部 skill 审批的持久化记录。 */
export const skillTrust = sqliteTable("skill_trust", {
  skillId: text("skill_id").primaryKey(),
  sourcePath: text("source_path").notNull(),
  contentHash: text("content_hash").notNull(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
  approvedAt: text("approved_at"),
  allowCommands: integer("allow_commands", { mode: "boolean" })
    .notNull()
    .default(false),
  allowHooks: integer("allow_hooks", { mode: "boolean" })
    .notNull()
    .default(false),
});

export const llmConfigs = sqliteTable("llm_configs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider", {
    enum: [
      "openai",
      "anthropic",
      "deepseek",
      "ollama",
      "custom",
      "minimax",
      "xiaomi",
      "github-copilot",
    ],
  }).notNull(),
  apiKey: text("api_key"),
  authMetadata: text("auth_metadata"),
  baseUrl: text("base_url"),
  apiPath: text("api_path"),
  model: text("model").notNull(),
  /**
   * 该配置产出的内容类型。旧数据行默认为 "chat"。image/video 模态会绕过
   * agent loop,改由专用客户端处理(见 src/main/ai/minimax/*)。
   */
  modality: text("modality", { enum: ["chat", "image", "video"] })
    .notNull()
    .default("chat"),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastCheckedAt: text("last_checked_at"),
  lastCheckStatus: text("last_check_status", {
    enum: ["success", "error"],
  }),
  lastCheckMessage: text("last_check_message"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const llmModelCatalog = sqliteTable("llm_model_catalog", {
  id: text("id").primaryKey(),
  configId: text("config_id").notNull(),
  modelId: text("model_id").notNull(),
  label: text("label").notNull(),
  capabilities: text("capabilities").notNull(),
  contextWindow: integer("context_window"),
  maxOutputTokens: integer("max_output_tokens"),
  fetchedAt: text("fetched_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

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
  // Usage tracking fields
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
  detail: text("detail").notNull(), // JSON
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
  /** Workspace kind. Defaults to "local" for legacy rows. */
  kind: text("kind", { enum: ["local", "github", "gitlab"] })
    .notNull()
    .default("local"),
  /** JSON-encoded WorkspaceRef. NULL for legacy rows (treat as local). */
  metadata: text("metadata"),
});

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["github_pat", "gitlab_pat"] }).notNull(),
  label: text("label").notNull(),
  /** AES-256-GCM encrypted token (see db/crypto.ts). */
  encryptedToken: text("encrypted_token").notNull(),
  /** Optional JSON array of granted scopes. */
  scopes: text("scopes"),
  createdAt: text("created_at").notNull(),
});

// chat_sessions / chat_messages — REMOVED in M3 PR 2.
// See `core/session/jsonl-store.ts` for the active backend.

export const llmConfigs = sqliteTable("llm_configs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider", {
    enum: ["openai", "anthropic", "deepseek", "ollama", "custom"],
  }).notNull(),
  apiKey: text("api_key"),
  baseUrl: text("base_url"),
  model: text("model").notNull(),
  isDefault: integer("is_default", { mode: "boolean" })
    .notNull()
    .default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

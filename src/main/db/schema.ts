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
  status: text("status", { enum: ["pending", "running", "completed", "failed"] }).notNull(),
  result: text("result"),
  filesAffected: text("files_affected"),
  createdAt: text("created_at").notNull(),
  completedAt: text("completed_at"),
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
});

export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  workspacePath: text("workspace_path").notNull(),
  title: text("title").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const chatMessages = sqliteTable("chat_messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  workspacePath: text("workspace_path").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  timestamp: text("timestamp").notNull(),
  /** JSON-serialised MessagePart[] for assistant messages */
  parts: text("parts"),
});

export const llmConfigs = sqliteTable("llm_configs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  provider: text("provider", {
    enum: ["openai", "anthropic", "deepseek", "ollama", "custom"],
  }).notNull(),
  apiKey: text("api_key"),
  baseUrl: text("base_url"),
  model: text("model").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});


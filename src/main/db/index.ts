import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import { decrypt, encrypt } from "./crypto";
import * as schema from "./schema";

let db: ReturnType<typeof drizzle<typeof schema>>;

const MAX_RECENT = 20;

export const initDatabase = async () => {
  const userDataPath = app.getPath("userData");
  const dbDir = join(userDataPath, "data");
  mkdirSync(dbDir, { recursive: true });

  const sqlite = new Database(join(dbDir, "filework.db"));
  sqlite.pragma("journal_mode = WAL");

  db = drizzle(sqlite, { schema });

  // Create tables if they don't exist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_opened_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed','failed')),
      result TEXT,
      files_affected TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS task_trace_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_trace_task ON task_trace_events(task_id, timestamp);
    CREATE TABLE IF NOT EXISTS task_summaries (
      task_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      original_tokens INTEGER,
      compressed_tokens INTEGER,
      summary_tokens INTEGER
    );
    CREATE TABLE IF NOT EXISTS file_operations (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      source_path TEXT NOT NULL,
      target_path TEXT,
      backup_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_workspaces (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS llm_configs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','deepseek','ollama','custom')),
      api_key TEXT,
      base_url TEXT,
      model TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credentials (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('github_pat','gitlab_pat','tavily_pat','firecrawl_pat')),
      label TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      scopes TEXT,
      created_at TEXT NOT NULL,
      last_tested_at TEXT,
      test_status TEXT,
      last_test_error TEXT,
      last_tested_host TEXT
    );
  `);

  // Migrate: pre-Tavily DBs have a CHECK constraint limited to
  // github_pat/gitlab_pat. SQLite can't ALTER a CHECK constraint —
  // rebuild the table in place if the old constraint is still there.
  const credentialsSql = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='credentials'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (
    credentialsSql &&
    !credentialsSql.includes("tavily_pat") &&
    credentialsSql.includes("github_pat")
  ) {
    sqlite.exec(`
      BEGIN TRANSACTION;
      CREATE TABLE credentials_new (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('github_pat','gitlab_pat','tavily_pat','firecrawl_pat')),
        label TEXT NOT NULL,
        encrypted_token TEXT NOT NULL,
        scopes TEXT,
        created_at TEXT NOT NULL,
        last_tested_at TEXT,
        test_status TEXT,
        last_test_error TEXT,
        last_tested_host TEXT
      );
      INSERT INTO credentials_new SELECT * FROM credentials;
      DROP TABLE credentials;
      ALTER TABLE credentials_new RENAME TO credentials;
      COMMIT;
    `);
    console.log(
      "[db] widened credentials.kind CHECK to include tavily_pat / firecrawl_pat",
    );
  }

  // Migrate: add usage tracking columns to tasks if missing
  const taskColumns = sqlite.pragma("table_info(tasks)") as {
    name: string;
  }[];
  if (!taskColumns.some((c) => c.name === "input_tokens")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN input_tokens INTEGER");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN output_tokens INTEGER");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN total_tokens INTEGER");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN model_id TEXT");
    sqlite.exec("ALTER TABLE tasks ADD COLUMN provider TEXT");
  }

  // Migrate: create task_trace_events table if missing (older DBs)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS task_trace_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_trace_task ON task_trace_events(task_id, timestamp);
    CREATE TABLE IF NOT EXISTS task_summaries (
      task_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      original_tokens INTEGER,
      compressed_tokens INTEGER,
      summary_tokens INTEGER
    );
  `);

  // M3 PR 2: drop legacy chat tables. Existing users on M3 PR 1+ have
  // already been migrated to the JSONL store at ~/.filework/sessions/.
  // Idempotent: no-op if the tables don't exist (fresh installs).
  sqlite.exec(`
    DROP TABLE IF EXISTS chat_messages;
    DROP TABLE IF EXISTS chat_sessions;
  `);

  // Migrate: add kind/metadata columns to recent_workspaces if missing
  const recentCols = sqlite.pragma("table_info(recent_workspaces)") as {
    name: string;
  }[];
  if (!recentCols.some((c) => c.name === "kind")) {
    sqlite.exec(
      "ALTER TABLE recent_workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'local'",
    );
  }
  if (!recentCols.some((c) => c.name === "metadata")) {
    sqlite.exec("ALTER TABLE recent_workspaces ADD COLUMN metadata TEXT");
  }

  // Migrate .env LLM config to database on first run
  migrateLlmConfigFromEnv();
};

// ============================================================================
// Types (preserved for IPC handler compatibility)
// ============================================================================

interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  lastOpenedAt: string | null;
}

interface Task {
  id: string;
  workspaceId: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  result: string | null;
  filesAffected: string | null;
  createdAt: string;
  completedAt: string | null;
  // Usage tracking
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  modelId?: string | null;
  provider?: string | null;
}

export interface TaskTraceEvent {
  id: string;
  taskId: string;
  type: string;
  timestamp: string;
  toolCallId?: string | null;
  toolName?: string | null;
  detail: Record<string, unknown>;
}

export interface TaskSummary {
  taskId: string;
  createdAt: string;
  summary: string;
  originalTokens?: number | null;
  compressedTokens?: number | null;
  summaryTokens?: number | null;
}

interface FileOperation {
  id: string;
  taskId: string;
  operation: string;
  sourcePath: string;
  targetPath: string | null;
  backupPath: string | null;
  createdAt: string;
}

interface RecentWorkspace {
  path: string;
  name: string;
  lastOpenedAt: string;
  kind: "local" | "github" | "gitlab";
  /** JSON-encoded WorkspaceRef; NULL for legacy local rows. */
  metadata: string | null;
}

export type CredentialTestStatus = "unknown" | "ok" | "error";

export type CredentialKind =
  | "github_pat"
  | "gitlab_pat"
  | "tavily_pat"
  | "firecrawl_pat";

export interface Credential {
  id: string;
  kind: CredentialKind;
  label: string;
  scopes: string[] | null;
  createdAt: string;
  /** M7 — health monitor fields. NULL on credentials predating M7. */
  lastTestedAt: string | null;
  testStatus: CredentialTestStatus | null;
  lastTestError: string | null;
  lastTestedHost: string | null;
}

// ============================================================================
// Workspaces
// ============================================================================

export const addWorkspace = (ws: Workspace) => {
  db.insert(schema.workspaces)
    .values({
      id: ws.id,
      name: ws.name,
      path: ws.path,
      createdAt: ws.createdAt,
      lastOpenedAt: ws.lastOpenedAt,
    })
    .run();
};

export const getWorkspaces = () => db.select().from(schema.workspaces).all();

export const updateWorkspace = (id: string, updates: Partial<Workspace>) => {
  const mapped: Record<string, unknown> = {};
  if (updates.name !== undefined) mapped.name = updates.name;
  if (updates.path !== undefined) mapped.path = updates.path;
  if (updates.createdAt !== undefined) mapped.createdAt = updates.createdAt;
  if (updates.lastOpenedAt !== undefined)
    mapped.lastOpenedAt = updates.lastOpenedAt;
  db.update(schema.workspaces)
    .set(mapped)
    .where(eq(schema.workspaces.id, id))
    .run();
};

// ============================================================================
// Tasks
// ============================================================================

export const addTask = (task: Task) => {
  db.insert(schema.tasks)
    .values({
      id: task.id,
      workspaceId: task.workspaceId,
      prompt: task.prompt,
      status: task.status,
      result: task.result,
      filesAffected: task.filesAffected,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
    })
    .run();
};

export const getTasks = (workspaceId?: string) => {
  if (workspaceId) {
    return db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.workspaceId, workspaceId))
      .all();
  }
  return db.select().from(schema.tasks).all();
};

export const updateTask = (id: string, updates: Partial<Task>) => {
  const mapped: Record<string, unknown> = {};
  if (updates.status !== undefined) mapped.status = updates.status;
  if (updates.result !== undefined) mapped.result = updates.result;
  if (updates.filesAffected !== undefined)
    mapped.filesAffected = updates.filesAffected;
  if (updates.completedAt !== undefined)
    mapped.completedAt = updates.completedAt;
  if (updates.inputTokens !== undefined)
    mapped.inputTokens = updates.inputTokens;
  if (updates.outputTokens !== undefined)
    mapped.outputTokens = updates.outputTokens;
  if (updates.totalTokens !== undefined)
    mapped.totalTokens = updates.totalTokens;
  if (updates.modelId !== undefined) mapped.modelId = updates.modelId;
  if (updates.provider !== undefined) mapped.provider = updates.provider;
  db.update(schema.tasks).set(mapped).where(eq(schema.tasks.id, id)).run();
};

// ============================================================================
// Task Trace Events (durable task lifecycle/tool trace)
// ============================================================================

const MAX_TRACE_DETAIL_CHARS = 20_000;

const safeJsonStringify = (value: unknown): string => {
  try {
    const json = JSON.stringify(value);
    return json.length > MAX_TRACE_DETAIL_CHARS
      ? `${json.slice(0, MAX_TRACE_DETAIL_CHARS)}...(truncated)`
      : json;
  } catch {
    return JSON.stringify({ error: "unserializable_detail" });
  }
};

export const addTaskTraceEvent = (event: Omit<TaskTraceEvent, "id">) => {
  const id = crypto.randomUUID();
  if (db) {
    db.insert(schema.taskTraceEvents)
      .values({
        id,
        taskId: event.taskId,
        type: event.type,
        timestamp: event.timestamp,
        toolCallId: event.toolCallId ?? null,
        toolName: event.toolName ?? null,
        detail: safeJsonStringify(event.detail),
      })
      .run();
  }
  return { ...event, id };
};

export const getTaskTraceEvents = (taskId: string, limit = 200) => {
  if (!db) return [] as TaskTraceEvent[];
  const rows = db
    .select()
    .from(schema.taskTraceEvents)
    .where(eq(schema.taskTraceEvents.taskId, taskId))
    .all()
    .slice(-limit);
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    type: r.type,
    timestamp: r.timestamp,
    toolCallId: r.toolCallId,
    toolName: r.toolName,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : {},
  })) as TaskTraceEvent[];
};

// ============================================================================
// Task Summaries (durable conversation compression summaries)
// ============================================================================

export const upsertTaskSummary = (s: TaskSummary) => {
  if (!db) return;
  db.insert(schema.taskSummaries)
    .values({
      taskId: s.taskId,
      createdAt: s.createdAt,
      summary: s.summary,
      originalTokens: s.originalTokens ?? null,
      compressedTokens: s.compressedTokens ?? null,
      summaryTokens: s.summaryTokens ?? null,
    })
    .onConflictDoUpdate({
      target: schema.taskSummaries.taskId,
      set: {
        createdAt: s.createdAt,
        summary: s.summary,
        originalTokens: s.originalTokens ?? null,
        compressedTokens: s.compressedTokens ?? null,
        summaryTokens: s.summaryTokens ?? null,
      },
    })
    .run();
};

export const getTaskSummary = (taskId: string): TaskSummary | null => {
  if (!db) return null;
  const row = db
    .select()
    .from(schema.taskSummaries)
    .where(eq(schema.taskSummaries.taskId, taskId))
    .get();
  if (!row) return null;
  return {
    taskId: row.taskId,
    createdAt: row.createdAt,
    summary: row.summary,
    originalTokens: row.originalTokens ?? null,
    compressedTokens: row.compressedTokens ?? null,
    summaryTokens: row.summaryTokens ?? null,
  };
};

// ============================================================================
// Settings
// ============================================================================

export const getSetting = (key: string): string | null => {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return row?.value ?? null;
};

export const setSetting = (key: string, value: string) => {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
};

export const getAllSettings = (): Record<string, string> => {
  const rows = db.select().from(schema.settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
};

// ============================================================================
// Recent Workspaces (max 20)
// ============================================================================

export const getRecentWorkspaces = (): RecentWorkspace[] =>
  db
    .select()
    .from(schema.recentWorkspaces)
    .orderBy(desc(schema.recentWorkspaces.lastOpenedAt))
    .all();

export const addRecentWorkspace = (
  path: string,
  name: string,
  opts: {
    kind?: "local" | "github" | "gitlab";
    metadata?: string | null;
  } = {},
) => {
  const now = new Date().toISOString();
  const kind = opts.kind ?? "local";
  const metadata = opts.metadata ?? null;
  db.insert(schema.recentWorkspaces)
    .values({ path, name, lastOpenedAt: now, kind, metadata })
    .onConflictDoUpdate({
      target: schema.recentWorkspaces.path,
      set: { name, lastOpenedAt: now, kind, metadata },
    })
    .run();

  // Trim to MAX_RECENT
  const all = db
    .select({ path: schema.recentWorkspaces.path })
    .from(schema.recentWorkspaces)
    .orderBy(desc(schema.recentWorkspaces.lastOpenedAt))
    .all();

  if (all.length > MAX_RECENT) {
    const toDelete = all.slice(MAX_RECENT);
    for (const row of toDelete) {
      db.delete(schema.recentWorkspaces)
        .where(eq(schema.recentWorkspaces.path, row.path))
        .run();
    }
  }
};

export const removeRecentWorkspace = (path: string) => {
  db.delete(schema.recentWorkspaces)
    .where(eq(schema.recentWorkspaces.path, path))
    .run();
};

// ============================================================================
// Credentials (GitHub PATs etc.)
// ============================================================================

export const createCredential = (input: {
  kind: CredentialKind;
  label: string;
  token: string;
  scopes?: string[] | null;
}): Credential => {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.insert(schema.credentials)
    .values({
      id,
      kind: input.kind,
      label: input.label,
      encryptedToken: encrypt(input.token),
      scopes: input.scopes ? JSON.stringify(input.scopes) : null,
      createdAt,
    })
    .run();
  return {
    id,
    kind: input.kind,
    label: input.label,
    scopes: input.scopes ?? null,
    createdAt,
    lastTestedAt: null,
    testStatus: null,
    lastTestError: null,
    lastTestedHost: null,
  };
};

const mapCredentialRow = (
  row: typeof schema.credentials.$inferSelect,
): Credential => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  scopes: row.scopes ? (JSON.parse(row.scopes) as string[]) : null,
  createdAt: row.createdAt,
  lastTestedAt: row.lastTestedAt ?? null,
  testStatus: row.testStatus ?? null,
  lastTestError: row.lastTestError ?? null,
  lastTestedHost: row.lastTestedHost ?? null,
});

export const listCredentials = (): Credential[] =>
  db.select().from(schema.credentials).all().map(mapCredentialRow);

export const getCredential = (id: string): Credential | null => {
  const row = db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.id, id))
    .get();
  return row ? mapCredentialRow(row) : null;
};

/** Returns the decrypted token. Throws if the credential id is unknown. */
export const getCredentialToken = (id: string): string => {
  const row = db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.id, id))
    .get();
  if (!row) throw new Error(`Credential not found: ${id}`);
  return decrypt(row.encryptedToken);
};

export const deleteCredential = (id: string): void => {
  db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
};

/**
 * Persist the result of a credential token test (M7 health monitor).
 * `host` is recorded only on success — it tells future batch tests
 * which host to ping for self-hosted gitlab credentials.
 */
export const recordCredentialTest = (input: {
  id: string;
  status: CredentialTestStatus;
  error?: string | null;
  host?: string | null;
}): void => {
  const updates: Record<string, unknown> = {
    lastTestedAt: new Date().toISOString(),
    testStatus: input.status,
    lastTestError: input.status === "ok" ? null : (input.error ?? null),
  };
  if (input.host !== undefined) {
    updates.lastTestedHost = input.host;
  }
  db.update(schema.credentials)
    .set(updates)
    .where(eq(schema.credentials.id, input.id))
    .run();
};

// ============================================================================
// Chat Sessions / Messages — REMOVED in M3 PR 2.
//
// All chat reads/writes now go through `core/session/jsonl-store.ts`.
// The legacy SQLite tables (`chat_sessions`, `chat_messages`) and helpers
// were dropped after JSONL stability was proven across the M5/M6 series.
// See git history for the prior implementation; the one-shot migration
// helper at `db/jsonl-migration.ts` was deleted alongside.
// ============================================================================

// ============================================================================
// LLM Config Types
// ============================================================================

export interface LlmConfig {
  id: string;
  name: string;
  provider: "openai" | "anthropic" | "deepseek" | "ollama" | "custom";
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// LLM Configs
// ============================================================================

function mapRowToLlmConfig(
  row: typeof schema.llmConfigs.$inferSelect,
): LlmConfig {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    apiKey: row.apiKey ? decrypt(row.apiKey) : null,
    baseUrl: row.baseUrl,
    model: row.model,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const createLlmConfig = (
  config: Omit<LlmConfig, "id" | "createdAt" | "updatedAt">,
): LlmConfig => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const encryptedApiKey = config.apiKey ? encrypt(config.apiKey) : null;

  db.insert(schema.llmConfigs)
    .values({
      id,
      name: config.name,
      provider: config.provider,
      apiKey: encryptedApiKey,
      baseUrl: config.baseUrl ?? null,
      model: config.model,
      isDefault: config.isDefault,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return {
    id,
    name: config.name,
    provider: config.provider,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? null,
    model: config.model,
    isDefault: config.isDefault,
    createdAt: now,
    updatedAt: now,
  };
};

export const getLlmConfigs = (): LlmConfig[] =>
  db.select().from(schema.llmConfigs).all().map(mapRowToLlmConfig);

export const getLlmConfig = (id: string): LlmConfig | null => {
  const row = db
    .select()
    .from(schema.llmConfigs)
    .where(eq(schema.llmConfigs.id, id))
    .get();
  return row ? mapRowToLlmConfig(row) : null;
};

export const updateLlmConfig = (
  id: string,
  updates: Partial<Omit<LlmConfig, "id" | "createdAt">>,
): void => {
  const mapped: Record<string, unknown> = {};
  if (updates.name !== undefined) mapped.name = updates.name;
  if (updates.provider !== undefined) mapped.provider = updates.provider;
  if (updates.apiKey !== undefined)
    mapped.apiKey = updates.apiKey ? encrypt(updates.apiKey) : null;
  if (updates.baseUrl !== undefined) mapped.baseUrl = updates.baseUrl;
  if (updates.model !== undefined) mapped.model = updates.model;
  if (updates.isDefault !== undefined) mapped.isDefault = updates.isDefault;
  mapped.updatedAt = new Date().toISOString();

  db.update(schema.llmConfigs)
    .set(mapped)
    .where(eq(schema.llmConfigs.id, id))
    .run();
};

export const deleteLlmConfig = (id: string): void => {
  const config = db
    .select()
    .from(schema.llmConfigs)
    .where(eq(schema.llmConfigs.id, id))
    .get();

  if (config?.isDefault) {
    const total = db.select().from(schema.llmConfigs).all().length;
    if (total <= 1) {
      throw new Error("至少保留一条默认配置");
    }
  }

  db.delete(schema.llmConfigs).where(eq(schema.llmConfigs.id, id)).run();
};

export const getDefaultLlmConfig = (): LlmConfig | null => {
  const row = db
    .select()
    .from(schema.llmConfigs)
    .where(eq(schema.llmConfigs.isDefault, true))
    .get();
  return row ? mapRowToLlmConfig(row) : null;
};

export const setDefaultLlmConfig = (id: string): void => {
  db.transaction((tx) => {
    tx.update(schema.llmConfigs).set({ isDefault: false }).run();
    tx.update(schema.llmConfigs)
      .set({ isDefault: true })
      .where(eq(schema.llmConfigs.id, id))
      .run();
  });
};

export const migrateLlmConfigFromEnv = (): void => {
  // Skip if there are already llm_configs records in the database
  const existing = db.select().from(schema.llmConfigs).all();
  if (existing.length > 0) return;

  const provider = (process.env.AI_PROVIDER || "").toLowerCase();
  const model = process.env.AI_MODEL || "";

  // Determine provider, apiKey, and baseUrl from environment variables
  let resolvedProvider: LlmConfig["provider"] = "openai";
  let apiKey: string | null = null;
  let baseUrl: string | null = null;

  if (provider === "anthropic") {
    resolvedProvider = "anthropic";
    apiKey = process.env.ANTHROPIC_API_KEY || null;
    baseUrl = process.env.ANTHROPIC_BASE_URL || null;
  } else if (provider === "deepseek") {
    resolvedProvider = "deepseek";
    apiKey = process.env.DEEPSEEK_API_KEY || null;
  } else if (provider === "ollama") {
    resolvedProvider = "ollama";
    baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  } else if (provider === "custom") {
    resolvedProvider = "custom";
    apiKey = process.env.OPENAI_API_KEY || null;
    baseUrl =
      process.env.CUSTOM_BASE_URL || process.env.OPENAI_BASE_URL || null;
  } else {
    // Default to openai (includes provider === "openai" or empty/unknown)
    resolvedProvider = "openai";
    apiKey = process.env.OPENAI_API_KEY || null;
    baseUrl =
      process.env.OPENAI_BASE_URL || process.env.CUSTOM_BASE_URL || null;
  }

  const resolvedModel = model || "gpt-4o-mini";

  // If provider env var was empty/missing and no apiKey found, use pure defaults
  const hasEnvConfig = provider || apiKey || model;

  createLlmConfig({
    name: hasEnvConfig ? `${resolvedProvider} (migrated)` : "OpenAI Default",
    provider: hasEnvConfig ? resolvedProvider : "openai",
    apiKey: hasEnvConfig ? apiKey : null,
    baseUrl: hasEnvConfig ? baseUrl : null,
    model: hasEnvConfig ? resolvedModel : "gpt-4o-mini",
    isDefault: true,
  });
};

export type { FileOperation, RecentWorkspace, Task, Workspace };

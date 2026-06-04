import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import type { CredentialKind } from "../../shared/credentials";
import { decrypt, encrypt } from "./crypto";
import * as schema from "./schema";

export type { CredentialKind };

let db: ReturnType<typeof drizzle<typeof schema>>;

const MAX_RECENT = 20;

export const initDatabase = async () => {
  const userDataPath = app.getPath("userData");
  const dbDir = join(userDataPath, "data");
  mkdirSync(dbDir, { recursive: true });

  const sqlite = new Database(join(dbDir, "filework.db"));
  sqlite.pragma("journal_mode = WAL");

  db = drizzle(sqlite, { schema });

  // 表不存在时创建
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
      provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','deepseek','ollama','custom','minimax','xiaomi')),
      api_key TEXT,
      base_url TEXT,
      model TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      config_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('image','video')),
      provider_job_id TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')),
      progress_pct INTEGER,
      result_path TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_media_jobs_session ON media_jobs(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_media_jobs_status ON media_jobs(status);
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
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
      command TEXT,
      args TEXT,
      env TEXT,
      cwd TEXT,
      url TEXT,
      headers TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      trusted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_trust (
      skill_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      approved_at TEXT,
      allow_commands INTEGER NOT NULL DEFAULT 0,
      allow_hooks INTEGER NOT NULL DEFAULT 0
    );
  `);

  // 迁移:Tavily 之前的数据库 CHECK 约束仅限
  // github_pat/gitlab_pat。SQLite 无法 ALTER 一个 CHECK 约束 ——
  // 若旧约束仍在,则就地重建该表。
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
    // better-sqlite3 的 transaction() 会把函数体包进 BEGIN/COMMIT,并在
    // 任何抛错时自动回滚 —— 比在 exec() 中裸写 `BEGIN ... COMMIT` 更安全:
    // 后者一旦 INSERT 未通过约束检查、COMMIT 又没执行,就会遗留半提交状态。
    try {
      sqlite.transaction(() => {
        sqlite.exec(`
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
        `);
      })();
      console.log(
        "[db] widened credentials.kind CHECK to include tavily_pat / firecrawl_pat",
      );
    } catch (err) {
      // 不让应用启动崩溃 —— 保留旧约束。新的
      // tavily/firecrawl 凭据行会在插入时以明确的 CHECK 违例失败,
      // 至少是可观测的。
      console.error(
        "[db] failed to widen credentials.kind CHECK; existing creds remain usable, new tavily/firecrawl kinds will fail:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 迁移:tasks 缺少用量追踪列时补充
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

  // 迁移:task_trace_events 表缺失时创建(旧版数据库)
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

  // M3 PR 2:删除旧版聊天表。M3 PR 1+ 上的现有用户已经
  // 迁移到 ~/.filework/sessions/ 的 JSONL 存储。
  // 幂等:表不存在时为空操作(全新安装)。
  sqlite.exec(`
    DROP TABLE IF EXISTS chat_messages;
    DROP TABLE IF EXISTS chat_sessions;
  `);

  // 迁移 llm_configs:(1)为图像/视频工作的第一阶段新增 `modality` 列 ——
  // 默认 'chat',使旧行仍被路由到 agent loop。(2)放宽 provider CHECK 约束
  // 以纳入 'minimax'。SQLite 无法就地 ALTER 一个 CHECK,因此当现有表仍是
  // 旧约束时重建该表(与上面 credentials.kind 的做法一致)。
  const llmCols = sqlite.pragma("table_info(llm_configs)") as {
    name: string;
  }[];
  if (!llmCols.some((c) => c.name === "modality")) {
    sqlite.exec(
      "ALTER TABLE llm_configs ADD COLUMN modality TEXT NOT NULL DEFAULT 'chat'",
    );
  }
  const llmConfigsSql = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_configs'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (llmConfigsSql && !llmConfigsSql.includes("minimax")) {
    try {
      sqlite.transaction(() => {
        sqlite.exec(`
          CREATE TABLE llm_configs_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','deepseek','ollama','custom','minimax')),
            api_key TEXT,
            base_url TEXT,
            model TEXT NOT NULL,
            modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO llm_configs_new (id, name, provider, api_key, base_url, model, modality, is_default, created_at, updated_at)
            SELECT id, name, provider, api_key, base_url, model,
                   COALESCE(modality, 'chat'),
                   is_default, created_at, updated_at
              FROM llm_configs;
          DROP TABLE llm_configs;
          ALTER TABLE llm_configs_new RENAME TO llm_configs;
        `);
      })();
      console.log("[db] widened llm_configs.provider CHECK to include minimax");
    } catch (err) {
      console.error(
        "[db] failed to widen llm_configs.provider CHECK; existing configs remain usable, new minimax provider rows will fail:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  // 第二轮放宽:向 provider CHECK 加入 'xiaomi'。与上面 minimax 迁移
  // 同样的做法 —— SQLite 无法就地 ALTER 一个 CHECK。一旦表已列出
  // 'xiaomi',这便是空操作。
  const llmConfigsSqlV2 = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_configs'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (llmConfigsSqlV2 && !llmConfigsSqlV2.includes("xiaomi")) {
    try {
      sqlite.transaction(() => {
        sqlite.exec(`
          CREATE TABLE llm_configs_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','deepseek','ollama','custom','minimax','xiaomi')),
            api_key TEXT,
            base_url TEXT,
            model TEXT NOT NULL,
            modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO llm_configs_new (id, name, provider, api_key, base_url, model, modality, is_default, created_at, updated_at)
            SELECT id, name, provider, api_key, base_url, model,
                   COALESCE(modality, 'chat'),
                   is_default, created_at, updated_at
              FROM llm_configs;
          DROP TABLE llm_configs;
          ALTER TABLE llm_configs_new RENAME TO llm_configs;
        `);
      })();
      console.log("[db] widened llm_configs.provider CHECK to include xiaomi");
    } catch (err) {
      console.error(
        "[db] failed to widen llm_configs.provider CHECK; existing configs remain usable, new xiaomi provider rows will fail:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 迁移:recent_workspaces 缺少 kind/metadata 列时补充
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

  // 首次运行时把 .env 的 LLM 配置迁移进数据库
  migrateLlmConfigFromEnv();
};

// ============================================================================
// 类型(为兼容 IPC 处理器而保留)
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
  // 用量追踪
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
  /** JSON 编码的 WorkspaceRef;旧版 local 行为 NULL。 */
  metadata: string | null;
}

export type CredentialTestStatus = "unknown" | "ok" | "error";

export interface Credential {
  id: string;
  kind: CredentialKind;
  label: string;
  scopes: string[] | null;
  createdAt: string;
  /** M7 —— 健康监控字段。早于 M7 的凭据为 NULL。 */
  lastTestedAt: string | null;
  testStatus: CredentialTestStatus | null;
  lastTestError: string | null;
  lastTestedHost: string | null;
}

// ============================================================================
// 工作区
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
// 任务
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
// 任务跟踪事件(持久化的任务生命周期/工具跟踪)
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
// 任务摘要(持久化的对话压缩摘要)
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
// 设置
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
// 最近工作区(最多 20 个)
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

  // 裁剪到 MAX_RECENT
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
// 凭据(GitHub PAT 等)
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

/** 返回解密后的 token。凭据 id 未知时抛错。 */
export const getCredentialToken = (id: string): string => {
  const row = db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.id, id))
    .get();
  if (!row) throw new Error(`Credential not found: ${id}`);
  return decrypt(row.encryptedToken);
};

/**
 * 返回 `kind` 下最近创建的凭据的解密 token,不存在时返回 null。
 * 供需要「用户的 <provider> 密钥」却不想暴露凭据 id 的 agent 工具使用。
 */
export const getLatestCredentialToken = (
  kind: CredentialKind,
): string | null => {
  const row = db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.kind, kind))
    .orderBy(desc(schema.credentials.createdAt))
    .get();
  return row ? decrypt(row.encryptedToken) : null;
};

export const deleteCredential = (id: string): void => {
  db.delete(schema.credentials).where(eq(schema.credentials.id, id)).run();
};

/**
 * 持久化一次凭据 token 测试的结果(M7 健康监控)。
 * `host` 仅在成功时记录 —— 它告诉后续的批量测试,对自托管 gitlab
 * 凭据该 ping 哪个主机。
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
// 聊天会话 / 消息 —— 在 M3 PR 2 中移除。
//
// 所有聊天读写现在都走 `core/session/jsonl-store.ts`。
// 旧版 SQLite 表(`chat_sessions`、`chat_messages`)及相关辅助函数
// 在 M5/M6 系列验证了 JSONL 的稳定性后被删除。
// 旧实现见 git 历史;一次性迁移辅助 `db/jsonl-migration.ts` 也已一并删除。
// ============================================================================

// ============================================================================
// LLM 配置类型
// ============================================================================

export type LlmProvider =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "ollama"
  | "custom"
  | "minimax"
  | "xiaomi";

export type LlmModality = "chat" | "image" | "video";

export interface LlmConfig {
  id: string;
  name: string;
  provider: LlmProvider;
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  /** 该配置的产出类型。为向后兼容默认 "chat"。 */
  modality: LlmModality;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// LLM 配置
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
    modality: row.modality,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const createLlmConfig = (
  config: Omit<LlmConfig, "id" | "createdAt" | "updatedAt" | "modality"> & {
    modality?: LlmModality;
  },
): LlmConfig => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const encryptedApiKey = config.apiKey ? encrypt(config.apiKey) : null;

  const modality: LlmModality = config.modality ?? "chat";
  db.insert(schema.llmConfigs)
    .values({
      id,
      name: config.name,
      provider: config.provider,
      apiKey: encryptedApiKey,
      baseUrl: config.baseUrl ?? null,
      model: config.model,
      modality,
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
    modality,
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
  if (updates.modality !== undefined) mapped.modality = updates.modality;
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
  // 若数据库中已有 llm_configs 记录则跳过
  const existing = db.select().from(schema.llmConfigs).all();
  if (existing.length > 0) return;

  const provider = (process.env.AI_PROVIDER || "").toLowerCase();
  const model = process.env.AI_MODEL || "";

  // 从环境变量确定 provider、apiKey 和 baseUrl
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
    // 默认 openai(涵盖 provider === "openai" 或为空/未知的情况)
    resolvedProvider = "openai";
    apiKey = process.env.OPENAI_API_KEY || null;
    baseUrl =
      process.env.OPENAI_BASE_URL || process.env.CUSTOM_BASE_URL || null;
  }

  const resolvedModel = model || "gpt-4o-mini";

  // 若 provider 环境变量为空/缺失且未找到 apiKey,则使用纯默认值
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

// ============================================================================
// 媒体任务(第三阶段 —— 视频生成 + 未来的异步媒体)
// ============================================================================

export type MediaJobKind = "image" | "video";
export type MediaJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export interface MediaJob {
  id: string;
  sessionId: string;
  configId: string;
  kind: MediaJobKind;
  providerJobId: string | null;
  prompt: string;
  status: MediaJobStatus;
  progressPct: number | null;
  resultPath: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

function mapRowToMediaJob(row: typeof schema.mediaJobs.$inferSelect): MediaJob {
  return {
    id: row.id,
    sessionId: row.sessionId,
    configId: row.configId,
    kind: row.kind,
    providerJobId: row.providerJobId,
    prompt: row.prompt,
    status: row.status,
    progressPct: row.progressPct,
    resultPath: row.resultPath,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export const createMediaJob = (
  job: Omit<
    MediaJob,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "completedAt"
    | "progressPct"
    | "resultPath"
    | "errorMessage"
    | "providerJobId"
  > & {
    id?: string;
    providerJobId?: string | null;
    progressPct?: number | null;
    resultPath?: string | null;
    errorMessage?: string | null;
  },
): MediaJob => {
  const id = job.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(schema.mediaJobs)
    .values({
      id,
      sessionId: job.sessionId,
      configId: job.configId,
      kind: job.kind,
      providerJobId: job.providerJobId ?? null,
      prompt: job.prompt,
      status: job.status,
      progressPct: job.progressPct ?? null,
      resultPath: job.resultPath ?? null,
      errorMessage: job.errorMessage ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    })
    .run();
  return {
    id,
    sessionId: job.sessionId,
    configId: job.configId,
    kind: job.kind,
    providerJobId: job.providerJobId ?? null,
    prompt: job.prompt,
    status: job.status,
    progressPct: job.progressPct ?? null,
    resultPath: job.resultPath ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
};

export const getMediaJob = (id: string): MediaJob | null => {
  const row = db
    .select()
    .from(schema.mediaJobs)
    .where(eq(schema.mediaJobs.id, id))
    .get();
  return row ? mapRowToMediaJob(row) : null;
};

export const updateMediaJob = (
  id: string,
  updates: Partial<
    Omit<MediaJob, "id" | "sessionId" | "configId" | "kind" | "createdAt">
  >,
): void => {
  const mapped: Record<string, unknown> = {};
  if (updates.providerJobId !== undefined)
    mapped.providerJobId = updates.providerJobId;
  if (updates.status !== undefined) mapped.status = updates.status;
  if (updates.progressPct !== undefined)
    mapped.progressPct = updates.progressPct;
  if (updates.resultPath !== undefined) mapped.resultPath = updates.resultPath;
  if (updates.errorMessage !== undefined)
    mapped.errorMessage = updates.errorMessage;
  if (updates.completedAt !== undefined)
    mapped.completedAt = updates.completedAt;
  mapped.updatedAt = new Date().toISOString();
  db.update(schema.mediaJobs)
    .set(mapped)
    .where(eq(schema.mediaJobs.id, id))
    .run();
};

/** 可能仍在运行的任务。在应用启动时用于暴露遗留任务。 */
export const listActiveMediaJobs = (): MediaJob[] => {
  return db
    .select()
    .from(schema.mediaJobs)
    .all()
    .map(mapRowToMediaJob)
    .filter((j) => j.status === "queued" || j.status === "running");
};

export const listMediaJobsBySession = (sessionId: string): MediaJob[] => {
  return db
    .select()
    .from(schema.mediaJobs)
    .where(eq(schema.mediaJobs.sessionId, sessionId))
    .all()
    .map(mapRowToMediaJob);
};

// ============================================================================
// MCP 服务器
// ============================================================================

export type McpTransport = "stdio" | "http";

export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  cwd: string | null;
  url: string | null;
  headers: Record<string, string>;
  enabled: boolean;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

const parseJsonArray = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
};

const parseJsonRecord = (raw: string | null): Record<string, string> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
};

const mapMcpRow = (row: typeof schema.mcpServers.$inferSelect): McpServer => ({
  id: row.id,
  name: row.name,
  transport: row.transport,
  command: row.command,
  args: parseJsonArray(row.args),
  env: parseJsonRecord(row.env),
  cwd: row.cwd,
  url: row.url,
  headers: parseJsonRecord(row.headers),
  enabled: row.enabled,
  trusted: row.trusted,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const listMcpServers = (): McpServer[] =>
  db.select().from(schema.mcpServers).all().map(mapMcpRow);

export const getMcpServer = (id: string): McpServer | null => {
  const row = db
    .select()
    .from(schema.mcpServers)
    .where(eq(schema.mcpServers.id, id))
    .get();
  return row ? mapMcpRow(row) : null;
};

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  url?: string | null;
  headers?: Record<string, string>;
  enabled?: boolean;
  trusted?: boolean;
}

export const createMcpServer = (input: McpServerInput): McpServer => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    name: input.name,
    transport: input.transport,
    command: input.command ?? null,
    args: input.args ? JSON.stringify(input.args) : null,
    env: input.env ? JSON.stringify(input.env) : null,
    cwd: input.cwd ?? null,
    url: input.url ?? null,
    headers: input.headers ? JSON.stringify(input.headers) : null,
    enabled: input.enabled ?? true,
    trusted: input.trusted ?? false,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.mcpServers).values(row).run();
  return mapMcpRow(row as typeof schema.mcpServers.$inferSelect);
};

export const updateMcpServer = (
  id: string,
  updates: Partial<McpServerInput>,
): void => {
  const mapped: Record<string, unknown> = {};
  if (updates.name !== undefined) mapped.name = updates.name;
  if (updates.transport !== undefined) mapped.transport = updates.transport;
  if (updates.command !== undefined) mapped.command = updates.command;
  if (updates.args !== undefined) mapped.args = JSON.stringify(updates.args);
  if (updates.env !== undefined) mapped.env = JSON.stringify(updates.env);
  if (updates.cwd !== undefined) mapped.cwd = updates.cwd;
  if (updates.url !== undefined) mapped.url = updates.url;
  if (updates.headers !== undefined)
    mapped.headers = JSON.stringify(updates.headers);
  if (updates.enabled !== undefined) mapped.enabled = updates.enabled;
  if (updates.trusted !== undefined) mapped.trusted = updates.trusted;
  mapped.updatedAt = new Date().toISOString();
  db.update(schema.mcpServers)
    .set(mapped)
    .where(eq(schema.mcpServers.id, id))
    .run();
};

export const deleteMcpServer = (id: string): void => {
  db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id)).run();
};

export type { FileOperation, RecentWorkspace, Task, Workspace };

// ============================================================================
// 技能信任(持久化外部 skill / 市场安装的审批结果)
// ============================================================================

export interface SkillTrustRow {
  skillId: string;
  sourcePath: string;
  contentHash: string;
  approved: boolean;
  approvedAt: string | null;
  allowCommands: boolean;
  allowHooks: boolean;
}

export const getSkillTrust = (skillId: string): SkillTrustRow | null => {
  const row = db
    .select()
    .from(schema.skillTrust)
    .where(eq(schema.skillTrust.skillId, skillId))
    .get();
  return row ?? null;
};

/** 读取全部信任记录(供启动时灌入内存信任缓存)。 */
export const listSkillTrust = (): SkillTrustRow[] =>
  db.select().from(schema.skillTrust).all();

export const upsertSkillTrust = (rec: SkillTrustRow): void => {
  db.insert(schema.skillTrust)
    .values(rec)
    .onConflictDoUpdate({
      target: schema.skillTrust.skillId,
      set: {
        sourcePath: rec.sourcePath,
        contentHash: rec.contentHash,
        approved: rec.approved,
        approvedAt: rec.approvedAt,
        allowCommands: rec.allowCommands,
        allowHooks: rec.allowHooks,
      },
    })
    .run();
};

export const deleteSkillTrust = (skillId: string): void => {
  db.delete(schema.skillTrust)
    .where(eq(schema.skillTrust.skillId, skillId))
    .run();
};

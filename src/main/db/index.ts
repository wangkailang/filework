import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq, isNotNull, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { app } from "electron";
import type { CredentialKind } from "../../shared/credentials";
import {
  decrypt,
  decryptWithKeychain,
  encrypt,
  encryptWithKeychain,
  isKeychainEncryptedValue,
  isKeychainEncryptionAvailable,
} from "./crypto";
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
      provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','deepseek','ollama','custom','minimax','xiaomi','github-copilot')),
      api_key TEXT,
      base_url TEXT,
      api_path TEXT,
      model TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
      is_default INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      last_check_status TEXT,
      last_check_message TEXT,
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
    CREATE TABLE IF NOT EXISTS automations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('thread','standalone','project')),
      schedule_kind TEXT NOT NULL CHECK(schedule_kind IN ('interval','daily','weekly','cron')),
      schedule_value TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      thread_id TEXT,
      workspace_paths TEXT,
      run_mode TEXT CHECK(run_mode IN ('local','worktree')),
      model_id TEXT,
      reasoning_effort TEXT,
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automations_enabled_next_run ON automations(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_automations_thread ON automations(thread_id);
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      automation_title TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','needs_action','succeeded','failed','canceled')),
      triage_status TEXT NOT NULL DEFAULT 'open' CHECK(triage_status IN ('open','handled')),
      needs_action_reason TEXT,
      chat_session_id TEXT,
      assistant_message_id TEXT,
      task_id TEXT,
      prompt TEXT NOT NULL,
      workspace_paths TEXT,
      thread_id TEXT,
      model_id TEXT,
      output TEXT,
      error_message TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status, updated_at);
    CREATE TABLE IF NOT EXISTS automation_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      tool_name TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_run_events_run ON automation_run_events(run_id, sequence);
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
      auth_type TEXT NOT NULL DEFAULT 'auto' CHECK(auth_type IN ('auto','none','oauth')),
      oauth_scopes TEXT,
      oauth_client_id TEXT,
      oauth_client_secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      trusted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_oauth_sessions (
      server_id TEXT PRIMARY KEY,
      encrypted_session TEXT NOT NULL,
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

  const automationRunsSql = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='automation_runs'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (
    automationRunsSql &&
    (!automationRunsSql.includes("needs_action") ||
      !automationRunsSql.includes("triage_status") ||
      !automationRunsSql.includes("needs_action_reason") ||
      !automationRunsSql.includes("chat_session_id") ||
      !automationRunsSql.includes("assistant_message_id") ||
      !automationRunsSql.includes("task_id"))
  ) {
    sqlite.exec(`
      DROP INDEX IF EXISTS idx_automation_runs_automation;
      DROP INDEX IF EXISTS idx_automation_runs_status;
      DROP INDEX IF EXISTS idx_automation_runs_triage;
      CREATE TABLE automation_runs_new (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        automation_title TEXT NOT NULL,
        trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','needs_action','succeeded','failed','canceled')),
        triage_status TEXT NOT NULL DEFAULT 'open' CHECK(triage_status IN ('open','handled')),
        needs_action_reason TEXT,
        chat_session_id TEXT,
        assistant_message_id TEXT,
        task_id TEXT,
        prompt TEXT NOT NULL,
        workspace_paths TEXT,
        thread_id TEXT,
        model_id TEXT,
        output TEXT,
        error_message TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        total_tokens INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );
      INSERT INTO automation_runs_new (
        id,
        automation_id,
        automation_title,
        trigger,
        status,
        triage_status,
        needs_action_reason,
        chat_session_id,
        assistant_message_id,
        task_id,
        prompt,
        workspace_paths,
        thread_id,
        model_id,
        output,
        error_message,
        input_tokens,
        output_tokens,
        total_tokens,
        retry_count,
        max_attempts,
        next_retry_at,
        created_at,
        updated_at,
        started_at,
        completed_at
      )
      SELECT
        id,
        automation_id,
        automation_title,
        trigger,
        status,
        CASE WHEN status IN ('succeeded','canceled') THEN 'handled' ELSE 'open' END,
        NULL,
        NULL,
        NULL,
        NULL,
        prompt,
        workspace_paths,
        thread_id,
        model_id,
        output,
        error_message,
        input_tokens,
        output_tokens,
        total_tokens,
        0,
        3,
        NULL,
        created_at,
        updated_at,
        started_at,
        completed_at
      FROM automation_runs;
      DROP TABLE automation_runs;
      ALTER TABLE automation_runs_new RENAME TO automation_runs;
      CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_status ON automation_runs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_automation_runs_triage ON automation_runs(triage_status, updated_at);
    `);
  }
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_automation_runs_triage ON automation_runs(triage_status, updated_at)",
  );
  const automationRunColumns = new Set(
    (
      (sqlite.pragma("table_info(automation_runs)") as
        | Array<{ name: string }>
        | undefined) ?? []
    ).map((column) => column.name),
  );
  if (!automationRunColumns.has("retry_count")) {
    sqlite.exec(
      "ALTER TABLE automation_runs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!automationRunColumns.has("max_attempts")) {
    sqlite.exec(
      "ALTER TABLE automation_runs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3",
    );
  }
  if (!automationRunColumns.has("next_retry_at")) {
    sqlite.exec("ALTER TABLE automation_runs ADD COLUMN next_retry_at TEXT");
  }
  sqlite.exec(
    "CREATE INDEX IF NOT EXISTS idx_automation_runs_retry ON automation_runs(next_retry_at)",
  );
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS automation_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      tool_name TEXT,
      detail TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_automation_run_events_run ON automation_run_events(run_id, sequence);
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

  // 迁移:MCP HTTP OAuth 认证字段。SQLite 的 CREATE TABLE IF NOT
  // EXISTS 不会补列,老库需要显式 ALTER。
  const mcpColumns = sqlite.pragma("table_info(mcp_servers)") as {
    name: string;
  }[];
  const hasMcpColumn = (name: string) =>
    mcpColumns.some((c) => c.name === name);
  if (!hasMcpColumn("auth_type")) {
    sqlite.exec(
      "ALTER TABLE mcp_servers ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none' CHECK(auth_type IN ('auto','none','oauth'))",
    );
  }
  if (!hasMcpColumn("oauth_scopes")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_scopes TEXT");
  }
  if (!hasMcpColumn("oauth_client_id")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_client_id TEXT");
  }
  if (!hasMcpColumn("oauth_client_secret")) {
    sqlite.exec("ALTER TABLE mcp_servers ADD COLUMN oauth_client_secret TEXT");
  }
  const mcpServersSql = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='mcp_servers'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (mcpServersSql && !mcpServersSql.includes("'auto'")) {
    try {
      sqlite.transaction(() => {
        sqlite.exec(`
          CREATE TABLE mcp_servers_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            transport TEXT NOT NULL CHECK(transport IN ('stdio','http')),
            command TEXT,
            args TEXT,
            env TEXT,
            cwd TEXT,
            url TEXT,
            headers TEXT,
            auth_type TEXT NOT NULL DEFAULT 'auto' CHECK(auth_type IN ('auto','none','oauth')),
            oauth_scopes TEXT,
            oauth_client_id TEXT,
            oauth_client_secret TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            trusted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO mcp_servers_new (
            id, name, transport, command, args, env, cwd, url, headers,
            auth_type, oauth_scopes, oauth_client_id, oauth_client_secret,
            enabled, trusted, created_at, updated_at
          )
            SELECT
              id, name, transport, command, args, env, cwd, url, headers,
              CASE
                WHEN auth_type IN ('none','oauth') THEN auth_type
                ELSE 'none'
              END,
              oauth_scopes, oauth_client_id, oauth_client_secret,
              enabled, trusted, created_at, updated_at
            FROM mcp_servers;
          DROP TABLE mcp_servers;
          ALTER TABLE mcp_servers_new RENAME TO mcp_servers;
        `);
      })();
      console.log("[db] widened mcp_servers.auth_type CHECK to include auto");
    } catch (err) {
      console.error(
        "[db] failed to widen mcp_servers.auth_type CHECK; existing MCP servers remain usable, new auto auth rows will fail:",
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
  if (!llmCols.some((c) => c.name === "api_path")) {
    sqlite.exec("ALTER TABLE llm_configs ADD COLUMN api_path TEXT");
  }
  if (!llmCols.some((c) => c.name === "enabled")) {
    sqlite.exec(
      "ALTER TABLE llm_configs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
    );
  }
  if (!llmCols.some((c) => c.name === "last_checked_at")) {
    sqlite.exec("ALTER TABLE llm_configs ADD COLUMN last_checked_at TEXT");
  }
  if (!llmCols.some((c) => c.name === "last_check_status")) {
    sqlite.exec("ALTER TABLE llm_configs ADD COLUMN last_check_status TEXT");
  }
  if (!llmCols.some((c) => c.name === "last_check_message")) {
    sqlite.exec("ALTER TABLE llm_configs ADD COLUMN last_check_message TEXT");
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
            api_path TEXT,
            model TEXT NOT NULL,
            modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
            is_default INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_checked_at TEXT,
            last_check_status TEXT,
            last_check_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO llm_configs_new (id, name, provider, api_key, base_url, api_path, model, modality, is_default, enabled, last_checked_at, last_check_status, last_check_message, created_at, updated_at)
            SELECT id, name, provider, api_key, base_url, api_path, model,
                   COALESCE(modality, 'chat'),
                   is_default,
                   COALESCE(enabled, 1),
                   last_checked_at, last_check_status, last_check_message,
                   created_at, updated_at
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
            api_path TEXT,
            model TEXT NOT NULL,
            modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
            is_default INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_checked_at TEXT,
            last_check_status TEXT,
            last_check_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO llm_configs_new (id, name, provider, api_key, base_url, api_path, model, modality, is_default, enabled, last_checked_at, last_check_status, last_check_message, created_at, updated_at)
            SELECT id, name, provider, api_key, base_url, api_path, model,
                   COALESCE(modality, 'chat'),
                   is_default,
                   COALESCE(enabled, 1),
                   last_checked_at, last_check_status, last_check_message,
                   created_at, updated_at
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
  // 第三轮放宽:向 provider CHECK 加入 'github-copilot'。
  const llmConfigsSqlV3 = (
    sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='llm_configs'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (llmConfigsSqlV3 && !llmConfigsSqlV3.includes("github-copilot")) {
    try {
      sqlite.transaction(() => {
        sqlite.exec(`
          CREATE TABLE llm_configs_new (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('openai','anthropic','deepseek','ollama','custom','minimax','xiaomi','github-copilot')),
            api_key TEXT,
            base_url TEXT,
            api_path TEXT,
            model TEXT NOT NULL,
            modality TEXT NOT NULL DEFAULT 'chat' CHECK(modality IN ('chat','image','video')),
            is_default INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            last_checked_at TEXT,
            last_check_status TEXT,
            last_check_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO llm_configs_new (id, name, provider, api_key, base_url, api_path, model, modality, is_default, enabled, last_checked_at, last_check_status, last_check_message, created_at, updated_at)
            SELECT id, name, provider, api_key, base_url, api_path, model,
                   COALESCE(modality, 'chat'),
                   is_default,
                   COALESCE(enabled, 1),
                   last_checked_at, last_check_status, last_check_message,
                   created_at, updated_at
              FROM llm_configs;
          DROP TABLE llm_configs;
          ALTER TABLE llm_configs_new RENAME TO llm_configs;
        `);
      })();
      console.log(
        "[db] widened llm_configs.provider CHECK to include github-copilot",
      );
    } catch (err) {
      console.error(
        "[db] failed to widen llm_configs.provider CHECK; existing configs remain usable, new github-copilot provider rows will fail:",
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

export type AutomationType = "thread" | "standalone" | "project";
export type AutomationScheduleKind = "interval" | "daily" | "weekly" | "cron";
export type AutomationRunMode = "local" | "worktree";
export type AutomationRunTrigger = "manual" | "scheduled";
export type AutomationRunStatus =
  | "queued"
  | "running"
  | "needs_action"
  | "succeeded"
  | "failed"
  | "canceled";
export type AutomationRunTriageStatus = "open" | "handled";

export interface AutomationRecord {
  id: string;
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled: boolean;
  threadId: string | null;
  workspacePaths: string[] | null;
  runMode: AutomationRunMode | null;
  modelId: string | null;
  reasoningEffort: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunRecord {
  id: string;
  automationId: string;
  automationTitle: string;
  trigger: AutomationRunTrigger;
  status: AutomationRunStatus;
  triageStatus: AutomationRunTriageStatus;
  needsActionReason: string | null;
  chatSessionId: string | null;
  assistantMessageId: string | null;
  taskId: string | null;
  prompt: string;
  workspacePaths: string[] | null;
  threadId: string | null;
  modelId: string | null;
  output: string | null;
  errorMessage: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  retryCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AutomationRunEventRecord {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  message: string | null;
  toolName: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
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
// 自动化定义
// ============================================================================

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

const parseTimeOfDay = (value: string): { hour: number; minute: number } => {
  const match = value.trim().match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) throw new Error(`Invalid time of day: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid time of day: ${value}`);
  }
  return { hour, minute };
};

const CRON_MONTH_NAMES: Record<string, number> = {
  apr: 4,
  aug: 8,
  dec: 12,
  feb: 2,
  jan: 1,
  jul: 7,
  jun: 6,
  mar: 3,
  may: 5,
  nov: 11,
  oct: 10,
  sep: 9,
};

const CRON_WEEKDAY_NAMES: Record<string, number> = {
  fri: 5,
  mon: 1,
  sat: 6,
  sun: 0,
  thu: 4,
  tue: 2,
  wed: 3,
};

const parseCronNumber = (
  value: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): number | null => {
  const normalized = value.trim().toLowerCase();
  const aliased = aliases?.[normalized];
  const parsed = aliased ?? Number(normalized);
  if (!Number.isInteger(parsed)) return null;
  if (max === 6 && parsed === 7) return 0;
  if (parsed < min || parsed > max) return null;
  return parsed;
};

const parseCronField = (
  field: string,
  min: number,
  max: number,
  aliases?: Record<string, number>,
): Set<number> | null => {
  const values = new Set<number>();

  for (const rawPart of field.split(",")) {
    const part = rawPart.trim();
    if (!part) return null;

    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;

    let start: number;
    let end: number;

    if (rangePart === "*" || rangePart === "?") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [rawStart, rawEnd] = rangePart.split("-");
      const parsedStart = parseCronNumber(rawStart, min, max, aliases);
      const parsedEnd = parseCronNumber(rawEnd, min, max, aliases);
      if (parsedStart === null || parsedEnd === null || parsedStart > parsedEnd)
        return null;
      start = parsedStart;
      end = parsedEnd;
    } else {
      const parsed = parseCronNumber(rangePart, min, max, aliases);
      if (parsed === null) return null;
      start = parsed;
      end = parsed;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  return values;
};

const isCronWildcard = (field: string): boolean => {
  const value = field.trim();
  return value === "*" || value === "?";
};

const computeCronNextRunAt = (value: string, now: Date): string | null => {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minuteField, hourField, dayField, monthField, weekdayField] = parts;
  const minutes = parseCronField(minuteField, 0, 59);
  const hours = parseCronField(hourField, 0, 23);
  const days = parseCronField(dayField, 1, 31);
  const months = parseCronField(monthField, 1, 12, CRON_MONTH_NAMES);
  const weekdays = parseCronField(weekdayField, 0, 6, CRON_WEEKDAY_NAMES);
  if (!minutes || !hours || !days || !months || !weekdays) return null;

  const dayWildcard = isCronWildcard(dayField);
  const weekdayWildcard = isCronWildcard(weekdayField);
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    const dayMatches = days.has(next.getDate());
    const weekdayMatches = weekdays.has(next.getDay());
    const calendarDayMatches =
      dayWildcard && weekdayWildcard
        ? true
        : dayWildcard
          ? weekdayMatches
          : weekdayWildcard
            ? dayMatches
            : dayMatches || weekdayMatches;

    if (
      minutes.has(next.getMinutes()) &&
      hours.has(next.getHours()) &&
      months.has(next.getMonth() + 1) &&
      calendarDayMatches
    ) {
      return next.toISOString();
    }

    next.setMinutes(next.getMinutes() + 1);
  }

  return null;
};

export const computeAutomationNextRunAt = (
  scheduleKind: AutomationScheduleKind,
  scheduleValue: string,
  now: Date = new Date(),
): string | null => {
  const value = scheduleValue.trim();
  if (!value) return null;

  if (scheduleKind === "interval") {
    const match = value.match(
      /^(\d+)\s*(m|min|minute|minutes|h|hour|hours|d|day|days)$/i,
    );
    if (!match) {
      throw new Error(`Invalid interval schedule value: ${scheduleValue}`);
    }
    const amount = Number(match[1]);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`Invalid interval schedule value: ${scheduleValue}`);
    }
    const unit = match[2].toLowerCase();
    const multiplier = unit.startsWith("m")
      ? 60_000
      : unit.startsWith("h")
        ? 60 * 60_000
        : 24 * 60 * 60_000;
    return new Date(now.getTime() + amount * multiplier).toISOString();
  }

  if (scheduleKind === "daily") {
    const { hour, minute } = parseTimeOfDay(value);
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  if (scheduleKind === "weekly") {
    const weekdayMatch = value
      .toLowerCase()
      .match(
        /\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/,
      );
    if (!weekdayMatch) return null;
    const targetDay = WEEKDAY_INDEX[weekdayMatch[1]];
    const { hour, minute } = parseTimeOfDay(value);
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    const daysAhead = (targetDay - next.getDay() + 7) % 7;
    next.setDate(next.getDate() + daysAhead);
    if (next <= now) next.setDate(next.getDate() + 7);
    return next.toISOString();
  }

  return computeCronNextRunAt(value, now);
};

export const previewAutomationSchedule = (
  scheduleKind: AutomationScheduleKind,
  scheduleValue: string,
  now: Date = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Local",
): { nextRunAt: string; timeZone: string } => {
  const nextRunAt = computeAutomationNextRunAt(
    scheduleKind,
    scheduleValue,
    now,
  );
  if (!nextRunAt) {
    throw new Error(`Invalid automation schedule: ${scheduleValue}`);
  }
  return { nextRunAt, timeZone };
};

const mapAutomationRow = (
  row: typeof schema.automations.$inferSelect,
): AutomationRecord => ({
  id: row.id,
  title: row.title,
  prompt: row.prompt,
  type: row.type,
  scheduleKind: row.scheduleKind,
  scheduleValue: row.scheduleValue,
  enabled: row.enabled,
  threadId: row.threadId ?? null,
  workspacePaths: row.workspacePaths
    ? (JSON.parse(row.workspacePaths) as string[])
    : null,
  runMode: row.runMode ?? null,
  modelId: row.modelId ?? null,
  reasoningEffort: row.reasoningEffort ?? null,
  lastRunAt: row.lastRunAt ?? null,
  nextRunAt: row.nextRunAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const listAutomations = (filter?: {
  enabled?: boolean;
  type?: AutomationType;
  threadId?: string;
}): AutomationRecord[] => {
  let rows = db.select().from(schema.automations).all();
  if (filter?.enabled !== undefined) {
    rows = rows.filter((row) => row.enabled === filter.enabled);
  }
  if (filter?.type) rows = rows.filter((row) => row.type === filter.type);
  if (filter?.threadId) {
    rows = rows.filter((row) => row.threadId === filter.threadId);
  }
  return rows
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    .map(mapAutomationRow);
};

export const getAutomation = (id: string): AutomationRecord | null => {
  const row = db
    .select()
    .from(schema.automations)
    .where(eq(schema.automations.id, id))
    .get();
  return row ? mapAutomationRow(row) : null;
};

export const createAutomation = (input: {
  title: string;
  prompt: string;
  type: AutomationType;
  scheduleKind: AutomationScheduleKind;
  scheduleValue: string;
  enabled?: boolean;
  threadId?: string | null;
  workspacePaths?: string[] | null;
  runMode?: AutomationRunMode | null;
  modelId?: string | null;
  reasoningEffort?: string | null;
}): AutomationRecord => {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const nextRunAt =
    input.enabled === false
      ? null
      : computeAutomationNextRunAt(input.scheduleKind, input.scheduleValue);
  db.insert(schema.automations)
    .values({
      id,
      title: input.title,
      prompt: input.prompt,
      type: input.type,
      scheduleKind: input.scheduleKind,
      scheduleValue: input.scheduleValue,
      enabled: input.enabled ?? true,
      threadId: input.threadId ?? null,
      workspacePaths: input.workspacePaths
        ? JSON.stringify(input.workspacePaths)
        : null,
      runMode: input.runMode ?? null,
      modelId: input.modelId ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      lastRunAt: null,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = getAutomation(id);
  if (!created) throw new Error(`Automation not found after create: ${id}`);
  return created;
};

export const updateAutomation = (
  id: string,
  updates: Partial<
    Omit<AutomationRecord, "id" | "createdAt" | "updatedAt" | "nextRunAt">
  >,
): AutomationRecord => {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);

  const scheduleKind = updates.scheduleKind ?? existing.scheduleKind;
  const scheduleValue = updates.scheduleValue ?? existing.scheduleValue;
  const enabled = updates.enabled ?? existing.enabled;
  const mapped: Record<string, unknown> = {
    updatedAt: new Date().toISOString(),
  };
  if (updates.title !== undefined) mapped.title = updates.title;
  if (updates.prompt !== undefined) mapped.prompt = updates.prompt;
  if (updates.type !== undefined) mapped.type = updates.type;
  if (updates.scheduleKind !== undefined)
    mapped.scheduleKind = updates.scheduleKind;
  if (updates.scheduleValue !== undefined)
    mapped.scheduleValue = updates.scheduleValue;
  if (updates.enabled !== undefined) mapped.enabled = updates.enabled;
  if (updates.threadId !== undefined) mapped.threadId = updates.threadId;
  if (updates.workspacePaths !== undefined) {
    mapped.workspacePaths = updates.workspacePaths
      ? JSON.stringify(updates.workspacePaths)
      : null;
  }
  if (updates.runMode !== undefined) mapped.runMode = updates.runMode;
  if (updates.modelId !== undefined) mapped.modelId = updates.modelId;
  if (updates.reasoningEffort !== undefined)
    mapped.reasoningEffort = updates.reasoningEffort;
  if (updates.lastRunAt !== undefined) mapped.lastRunAt = updates.lastRunAt;
  if (
    updates.enabled !== undefined ||
    updates.scheduleKind !== undefined ||
    updates.scheduleValue !== undefined
  ) {
    mapped.nextRunAt = enabled
      ? computeAutomationNextRunAt(scheduleKind, scheduleValue)
      : null;
  }

  db.update(schema.automations)
    .set(mapped)
    .where(eq(schema.automations.id, id))
    .run();
  const updated = getAutomation(id);
  if (!updated) throw new Error(`Automation not found after update: ${id}`);
  return updated;
};

export const deleteAutomation = (id: string): boolean => {
  const existing = getAutomation(id);
  if (!existing) return false;
  db.delete(schema.automations).where(eq(schema.automations.id, id)).run();
  return true;
};

export const triggerAutomation = (
  id: string,
  now = new Date(),
): AutomationRecord => {
  const existing = getAutomation(id);
  if (!existing) throw new Error(`Automation not found: ${id}`);

  const lastRunAt = now.toISOString();
  const nextRunAt = existing.enabled
    ? computeAutomationNextRunAt(
        existing.scheduleKind,
        existing.scheduleValue,
        now,
      )
    : null;

  db.update(schema.automations)
    .set({
      lastRunAt,
      nextRunAt,
      updatedAt: lastRunAt,
    })
    .where(eq(schema.automations.id, id))
    .run();

  const updated = getAutomation(id);
  if (!updated) throw new Error(`Automation not found after trigger: ${id}`);
  return updated;
};

// ============================================================================
// 自动化执行记录
// ============================================================================

const ACTIVE_AUTOMATION_RUN_STATUSES: AutomationRunStatus[] = [
  "queued",
  "running",
];
const AUTOMATION_RETRY_BASE_DELAY_MS = 5 * 60_000;
const AUTOMATION_RETRY_MAX_DELAY_MS = 60 * 60_000;

const computeAutomationRetryAt = (
  retryCount: number,
  now = new Date(),
): string => {
  const delay = Math.min(
    AUTOMATION_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount),
    AUTOMATION_RETRY_MAX_DELAY_MS,
  );
  return new Date(now.getTime() + delay).toISOString();
};

const mapAutomationRunRow = (
  row: typeof schema.automationRuns.$inferSelect,
): AutomationRunRecord => ({
  id: row.id,
  automationId: row.automationId,
  automationTitle: row.automationTitle,
  trigger: row.trigger,
  status: row.status,
  triageStatus: row.triageStatus,
  needsActionReason: row.needsActionReason ?? null,
  chatSessionId: row.chatSessionId ?? null,
  assistantMessageId: row.assistantMessageId ?? null,
  taskId: row.taskId ?? null,
  prompt: row.prompt,
  workspacePaths: row.workspacePaths
    ? (JSON.parse(row.workspacePaths) as string[])
    : null,
  threadId: row.threadId ?? null,
  modelId: row.modelId ?? null,
  output: row.output ?? null,
  errorMessage: row.errorMessage ?? null,
  inputTokens: row.inputTokens ?? null,
  outputTokens: row.outputTokens ?? null,
  totalTokens: row.totalTokens ?? null,
  retryCount: row.retryCount ?? 0,
  maxAttempts: row.maxAttempts ?? 3,
  nextRetryAt: row.nextRetryAt ?? null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  startedAt: row.startedAt ?? null,
  completedAt: row.completedAt ?? null,
});

export const listAutomationRuns = (filter?: {
  automationId?: string;
  status?: AutomationRunStatus;
  triageStatus?: AutomationRunTriageStatus;
  limit?: number;
  offset?: number;
}): AutomationRunRecord[] => {
  let rows = db.select().from(schema.automationRuns).all();
  if (filter?.automationId) {
    rows = rows.filter((row) => row.automationId === filter.automationId);
  }
  if (filter?.status) {
    rows = rows.filter((row) => row.status === filter.status);
  }
  if (filter?.triageStatus) {
    rows = rows.filter((row) => row.triageStatus === filter.triageStatus);
  }
  const sorted = rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const offset =
    typeof filter?.offset === "number" && filter.offset > 0 ? filter.offset : 0;
  const offsetRows = offset > 0 ? sorted.slice(offset) : sorted;
  const limited =
    typeof filter?.limit === "number" && filter.limit > 0
      ? offsetRows.slice(0, filter.limit)
      : offsetRows;
  return limited.map(mapAutomationRunRow);
};

export const getAutomationRun = (id: string): AutomationRunRecord | null => {
  const row = db
    .select()
    .from(schema.automationRuns)
    .where(eq(schema.automationRuns.id, id))
    .get();
  return row ? mapAutomationRunRow(row) : null;
};

export const getActiveAutomationRun = (
  automationId: string,
): AutomationRunRecord | null => {
  const run = listAutomationRuns({ automationId }).find((row) =>
    ACTIVE_AUTOMATION_RUN_STATUSES.includes(row.status),
  );
  return run ?? null;
};

export const queueAutomationRun = (
  automationId: string,
  input: {
    assistantMessageId?: string | null;
    chatSessionId?: string | null;
    trigger: AutomationRunTrigger;
    now?: Date;
  },
): AutomationRunRecord => {
  const existingActive = getActiveAutomationRun(automationId);
  if (existingActive) return existingActive;

  const automation = getAutomation(automationId);
  if (!automation) throw new Error(`Automation not found: ${automationId}`);

  const id = crypto.randomUUID();
  const now = (input.now ?? new Date()).toISOString();
  db.insert(schema.automationRuns)
    .values({
      id,
      automationId,
      automationTitle: automation.title,
      trigger: input.trigger,
      status: "queued",
      triageStatus: "open",
      needsActionReason: null,
      chatSessionId: input.chatSessionId ?? null,
      assistantMessageId: input.assistantMessageId ?? null,
      taskId: null,
      prompt: automation.prompt,
      workspacePaths: automation.workspacePaths
        ? JSON.stringify(automation.workspacePaths)
        : null,
      threadId: automation.threadId,
      modelId: automation.modelId,
      output: null,
      errorMessage: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      retryCount: 0,
      maxAttempts: 3,
      nextRetryAt: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    })
    .run();

  if (input.trigger === "scheduled") {
    db.update(schema.automations)
      .set({
        nextRunAt: automation.enabled
          ? computeAutomationNextRunAt(
              automation.scheduleKind,
              automation.scheduleValue,
              new Date(now),
            )
          : null,
        updatedAt: now,
      })
      .where(eq(schema.automations.id, automation.id))
      .run();
  }

  const queued = getAutomationRun(id);
  if (!queued) throw new Error(`Automation run not found after queue: ${id}`);
  return queued;
};

export const startAutomationRun = (
  id: string,
  input: { now?: Date; taskId?: string | null } = {},
): AutomationRunRecord => {
  const existing = getAutomationRun(id);
  if (!existing) throw new Error(`Automation run not found: ${id}`);
  if (existing.status === "canceled") return existing;

  const now = (input.now ?? new Date()).toISOString();
  db.update(schema.automationRuns)
    .set({
      status: "running",
      taskId: input.taskId ?? existing.taskId,
      startedAt: existing.startedAt ?? now,
      updatedAt: now,
    })
    .where(eq(schema.automationRuns.id, id))
    .run();

  const automation = getAutomation(existing.automationId);
  if (automation) {
    db.update(schema.automations)
      .set({
        lastRunAt: now,
        nextRunAt: automation.enabled
          ? computeAutomationNextRunAt(
              automation.scheduleKind,
              automation.scheduleValue,
              new Date(now),
            )
          : null,
        updatedAt: now,
      })
      .where(eq(schema.automations.id, automation.id))
      .run();
  }

  const started = getAutomationRun(id);
  if (!started) throw new Error(`Automation run not found after start: ${id}`);
  return started;
};

export const finishAutomationRun = (
  id: string,
  input: {
    status: Extract<
      AutomationRunStatus,
      "needs_action" | "succeeded" | "failed" | "canceled"
    >;
    output?: string | null;
    errorMessage?: string | null;
    needsActionReason?: string | null;
    usage?: {
      inputTokens?: number | null;
      outputTokens?: number | null;
      totalTokens?: number | null;
    };
    now?: Date;
  },
): AutomationRunRecord => {
  const existing = getAutomationRun(id);
  if (!existing) throw new Error(`Automation run not found: ${id}`);
  if (existing.status === "canceled") return existing;

  const now = (input.now ?? new Date()).toISOString();
  const nextRetryAt =
    input.status === "failed" && existing.retryCount < existing.maxAttempts - 1
      ? computeAutomationRetryAt(existing.retryCount, new Date(now))
      : null;
  const triageStatus =
    input.status === "failed" || input.status === "needs_action"
      ? "open"
      : "handled";
  db.update(schema.automationRuns)
    .set({
      status: input.status,
      triageStatus,
      needsActionReason: input.needsActionReason ?? null,
      output: input.output ?? null,
      errorMessage: input.errorMessage ?? null,
      inputTokens: input.usage?.inputTokens ?? null,
      outputTokens: input.usage?.outputTokens ?? null,
      totalTokens: input.usage?.totalTokens ?? null,
      nextRetryAt,
      updatedAt: now,
      completedAt: now,
    })
    .where(eq(schema.automationRuns.id, id))
    .run();

  const finished = getAutomationRun(id);
  if (!finished)
    throw new Error(`Automation run not found after finish: ${id}`);
  return finished;
};

export const markAutomationRunHandled = (
  id: string,
  input: { now?: Date } = {},
): AutomationRunRecord => {
  const existing = getAutomationRun(id);
  if (!existing) throw new Error(`Automation run not found: ${id}`);
  const now = (input.now ?? new Date()).toISOString();
  db.update(schema.automationRuns)
    .set({
      triageStatus: "handled",
      updatedAt: now,
    })
    .where(eq(schema.automationRuns.id, id))
    .run();
  const updated = getAutomationRun(id);
  if (!updated)
    throw new Error(`Automation run not found after triage update: ${id}`);
  return updated;
};

export const cancelAutomationRun = (
  id: string,
  input: { now?: Date } = {},
): AutomationRunRecord => {
  const existing = getAutomationRun(id);
  if (!existing) throw new Error(`Automation run not found: ${id}`);
  if (existing.status === "succeeded" || existing.status === "failed") {
    return markAutomationRunHandled(id, input);
  }
  const now = (input.now ?? new Date()).toISOString();
  db.update(schema.automationRuns)
    .set({
      status: "canceled",
      triageStatus: "handled",
      updatedAt: now,
      completedAt: existing.completedAt ?? now,
    })
    .where(eq(schema.automationRuns.id, id))
    .run();
  const updated = getAutomationRun(id);
  if (!updated) throw new Error(`Automation run not found after cancel: ${id}`);
  return updated;
};

export const continueAutomationRun = (
  id: string,
  input: { now?: Date } = {},
): AutomationRunRecord => {
  const existing = getAutomationRun(id);
  if (!existing) throw new Error(`Automation run not found: ${id}`);
  if (existing.status !== "needs_action") {
    throw new Error(`Automation run is not waiting for action: ${id}`);
  }
  const now = (input.now ?? new Date()).toISOString();
  db.update(schema.automationRuns)
    .set({
      status: "queued",
      triageStatus: "open",
      needsActionReason: null,
      errorMessage: null,
      nextRetryAt: null,
      updatedAt: now,
      completedAt: null,
    })
    .where(eq(schema.automationRuns.id, id))
    .run();
  const continued = getAutomationRun(id);
  if (!continued)
    throw new Error(`Automation run not found after continue: ${id}`);
  return continued;
};

export const listDueAutomationRunRetries = (
  now = new Date(),
): AutomationRunRecord[] => {
  const nowIso = now.toISOString();
  return db
    .select()
    .from(schema.automationRuns)
    .where(
      and(
        eq(schema.automationRuns.status, "failed"),
        isNotNull(schema.automationRuns.nextRetryAt),
        lte(schema.automationRuns.nextRetryAt, nowIso),
      ),
    )
    .all()
    .map(mapAutomationRunRow)
    .filter((run) => run.retryCount < run.maxAttempts - 1);
};

export const queueAutomationRunRetry = (
  id: string,
  input: { now?: Date } = {},
): AutomationRunRecord => {
  const existing = getAutomationRun(id);
  if (!existing) throw new Error(`Automation run not found: ${id}`);
  if (existing.status !== "failed") {
    throw new Error(`Automation run is not retryable: ${id}`);
  }
  const now = (input.now ?? new Date()).toISOString();
  db.update(schema.automationRuns)
    .set({
      status: "queued",
      retryCount: existing.retryCount + 1,
      nextRetryAt: null,
      updatedAt: now,
      completedAt: null,
    })
    .where(eq(schema.automationRuns.id, id))
    .run();
  const retried = getAutomationRun(id);
  if (!retried) throw new Error(`Automation run not found after retry: ${id}`);
  return retried;
};

export const recordAutomationRunEvent = (
  runId: string,
  input: {
    detail?: Record<string, unknown> | null;
    message?: string | null;
    now?: Date;
    toolName?: string | null;
    type: string;
  },
): AutomationRunEventRecord => {
  const last = db
    .select()
    .from(schema.automationRunEvents)
    .where(eq(schema.automationRunEvents.runId, runId))
    .all()
    .reduce((max, row) => Math.max(max, row.sequence), 0);
  const id = crypto.randomUUID();
  const createdAt = (input.now ?? new Date()).toISOString();
  db.insert(schema.automationRunEvents)
    .values({
      id,
      runId,
      sequence: last + 1,
      type: input.type,
      message: input.message ?? null,
      toolName: input.toolName ?? null,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      createdAt,
    })
    .run();
  const event = listAutomationRunEvents(runId).find((item) => item.id === id);
  if (!event)
    throw new Error(`Automation run event not found after create: ${id}`);
  return event;
};

export const listAutomationRunEvents = (
  runId: string,
): AutomationRunEventRecord[] =>
  db
    .select()
    .from(schema.automationRunEvents)
    .where(eq(schema.automationRunEvents.runId, runId))
    .all()
    .sort((a, b) => a.sequence - b.sequence)
    .map((row) => ({
      id: row.id,
      runId: row.runId,
      sequence: row.sequence,
      type: row.type,
      message: row.message ?? null,
      toolName: row.toolName ?? null,
      detail: row.detail
        ? (JSON.parse(row.detail) as Record<string, unknown>)
        : null,
      createdAt: row.createdAt,
    }));

export const cleanupAutomationRuns = (
  input: {
    olderThanDays?: number;
    triageStatus?: AutomationRunTriageStatus;
    now?: Date;
  } = {},
): { deleted: number } => {
  const triageStatus = input.triageStatus ?? "handled";
  const cutoff =
    typeof input.olderThanDays === "number" && input.olderThanDays > 0
      ? new Date(
          (input.now ?? new Date()).getTime() -
            input.olderThanDays * 24 * 60 * 60_000,
        ).toISOString()
      : null;
  const runsToDelete = listAutomationRuns({ triageStatus }).filter((run) =>
    cutoff ? run.updatedAt < cutoff : true,
  );

  for (const run of runsToDelete) {
    db.delete(schema.automationRuns)
      .where(eq(schema.automationRuns.id, run.id))
      .run();
  }

  return { deleted: runsToDelete.length };
};

export const recoverInterruptedAutomationRuns = (
  now: Date = new Date(),
): AutomationRunRecord[] => {
  const interrupted = listAutomationRuns().filter((run) =>
    ACTIVE_AUTOMATION_RUN_STATUSES.includes(run.status),
  );
  return interrupted.map((run) =>
    finishAutomationRun(run.id, {
      status: "failed",
      errorMessage: "Automation run interrupted before completion.",
      now,
    }),
  );
};

export const listDueAutomations = (now = new Date()): AutomationRecord[] => {
  const nowIso = now.toISOString();
  return listAutomations({ enabled: true }).filter((automation) => {
    if (!automation.nextRunAt || automation.nextRunAt > nowIso) return false;
    return !getActiveAutomationRun(automation.id);
  });
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

export const updateCredential = (input: {
  id: string;
  kind: CredentialKind;
  label: string;
  token?: string;
  scopes?: string[] | null;
}): Credential => {
  const existing = db
    .select()
    .from(schema.credentials)
    .where(eq(schema.credentials.id, input.id))
    .get();
  if (!existing) throw new Error(`Credential not found: ${input.id}`);

  const tokenChanged = input.token != null && input.token.length > 0;
  const kindChanged = input.kind !== existing.kind;
  const updates: Partial<typeof schema.credentials.$inferInsert> = {
    kind: input.kind,
    label: input.label,
  };
  if (tokenChanged) {
    updates.encryptedToken = encrypt(input.token ?? "");
  }
  if (input.scopes !== undefined) {
    updates.scopes = input.scopes ? JSON.stringify(input.scopes) : null;
  }
  if (tokenChanged || kindChanged) {
    updates.lastTestedAt = null;
    updates.testStatus = null;
    updates.lastTestError = null;
    updates.lastTestedHost = null;
  }

  db.update(schema.credentials)
    .set(updates)
    .where(eq(schema.credentials.id, input.id))
    .run();

  const updated = getCredential(input.id);
  if (!updated) throw new Error(`Credential not found: ${input.id}`);
  return updated;
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
  | "xiaomi"
  | "github-copilot";

export type LlmModality = "chat" | "image" | "video";
export type LlmCheckStatus = "success" | "error";

export interface LlmConfig {
  id: string;
  name: string;
  provider: LlmProvider;
  apiKey: string | null;
  baseUrl: string | null;
  apiPath: string | null;
  model: string;
  /** 该配置的产出类型。为向后兼容默认 "chat"。 */
  modality: LlmModality;
  isDefault: boolean;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastCheckStatus: LlmCheckStatus | null;
  lastCheckMessage: string | null;
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
    apiPath: row.apiPath,
    model: row.model,
    modality: row.modality,
    isDefault: row.isDefault,
    enabled: row.enabled,
    lastCheckedAt: row.lastCheckedAt,
    lastCheckStatus: row.lastCheckStatus,
    lastCheckMessage: row.lastCheckMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const createLlmConfig = (
  config: Omit<
    LlmConfig,
    | "id"
    | "createdAt"
    | "updatedAt"
    | "modality"
    | "apiPath"
    | "enabled"
    | "lastCheckedAt"
    | "lastCheckStatus"
    | "lastCheckMessage"
  > & {
    apiPath?: string | null;
    enabled?: boolean;
    lastCheckedAt?: string | null;
    lastCheckStatus?: LlmCheckStatus | null;
    lastCheckMessage?: string | null;
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
      apiPath: config.apiPath ?? null,
      model: config.model,
      modality,
      isDefault: config.isDefault,
      enabled: config.enabled ?? true,
      lastCheckedAt: config.lastCheckedAt ?? null,
      lastCheckStatus: config.lastCheckStatus ?? null,
      lastCheckMessage: config.lastCheckMessage ?? null,
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
    apiPath: config.apiPath ?? null,
    model: config.model,
    modality,
    isDefault: config.isDefault,
    enabled: config.enabled ?? true,
    lastCheckedAt: config.lastCheckedAt ?? null,
    lastCheckStatus: config.lastCheckStatus ?? null,
    lastCheckMessage: config.lastCheckMessage ?? null,
    createdAt: now,
    updatedAt: now,
  };
};

export const getLlmConfigs = (): LlmConfig[] =>
  db
    .select()
    .from(schema.llmConfigs)
    .orderBy(desc(schema.llmConfigs.updatedAt))
    .all()
    .map(mapRowToLlmConfig);

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
  if (updates.apiPath !== undefined) mapped.apiPath = updates.apiPath;
  if (updates.model !== undefined) mapped.model = updates.model;
  if (updates.modality !== undefined) mapped.modality = updates.modality;
  if (updates.isDefault !== undefined) mapped.isDefault = updates.isDefault;
  if (updates.enabled !== undefined) mapped.enabled = updates.enabled;
  if (updates.lastCheckedAt !== undefined)
    mapped.lastCheckedAt = updates.lastCheckedAt;
  if (updates.lastCheckStatus !== undefined)
    mapped.lastCheckStatus = updates.lastCheckStatus;
  if (updates.lastCheckMessage !== undefined)
    mapped.lastCheckMessage = updates.lastCheckMessage;
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
    .where(
      and(
        eq(schema.llmConfigs.isDefault, true),
        eq(schema.llmConfigs.enabled, true),
      ),
    )
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
export type McpAuthType = "auto" | "none" | "oauth";

export interface McpOAuthSession {
  clientInformation?: unknown;
  tokens?: unknown;
  codeVerifier?: string;
  discoveryState?: unknown;
  authorizationState?: string;
  authorizationUrl?: string;
}

export type McpOAuthSessionCredentialsStore = "database" | "keychain";

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
  authType: McpAuthType;
  oauthScopes: string[];
  oauthClientId: string | null;
  oauthClientSecret: string | null;
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

const parseMcpAuthType = (
  transport: McpTransport,
  value: string | null,
): McpAuthType => {
  if (transport === "stdio") return "none";
  if (value === "auto" || value === "none" || value === "oauth") return value;
  return "auto";
};

const defaultMcpAuthType = (transport: McpTransport): McpAuthType =>
  transport === "http" ? "auto" : "none";

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
  authType: parseMcpAuthType(row.transport, row.authType),
  oauthScopes: parseJsonArray(row.oauthScopes),
  oauthClientId: row.oauthClientId,
  oauthClientSecret: row.oauthClientSecret
    ? decrypt(row.oauthClientSecret)
    : null,
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
  authType?: McpAuthType;
  oauthScopes?: string[];
  oauthClientId?: string | null;
  oauthClientSecret?: string | null;
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
    authType:
      input.transport === "http"
        ? (input.authType ?? defaultMcpAuthType(input.transport))
        : "none",
    oauthScopes: input.oauthScopes ? JSON.stringify(input.oauthScopes) : null,
    oauthClientId: input.oauthClientId ?? null,
    oauthClientSecret: input.oauthClientSecret
      ? encrypt(input.oauthClientSecret)
      : null,
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
  if (updates.authType !== undefined) mapped.authType = updates.authType;
  if (updates.transport === "stdio" && updates.authType === undefined)
    mapped.authType = "none";
  if (updates.oauthScopes !== undefined)
    mapped.oauthScopes = JSON.stringify(updates.oauthScopes);
  if (updates.oauthClientId !== undefined)
    mapped.oauthClientId = updates.oauthClientId;
  if (updates.oauthClientSecret !== undefined)
    mapped.oauthClientSecret = updates.oauthClientSecret
      ? encrypt(updates.oauthClientSecret)
      : null;
  if (updates.enabled !== undefined) mapped.enabled = updates.enabled;
  if (updates.trusted !== undefined) mapped.trusted = updates.trusted;
  mapped.updatedAt = new Date().toISOString();
  db.update(schema.mcpServers)
    .set(mapped)
    .where(eq(schema.mcpServers.id, id))
    .run();
};

export const deleteMcpServer = (id: string): void => {
  db.delete(schema.mcpOAuthSessions)
    .where(eq(schema.mcpOAuthSessions.serverId, id))
    .run();
  db.delete(schema.mcpServers).where(eq(schema.mcpServers.id, id)).run();
};

export const getMcpOAuthSession = (serverId: string): McpOAuthSession => {
  const row = db
    .select()
    .from(schema.mcpOAuthSessions)
    .where(eq(schema.mcpOAuthSessions.serverId, serverId))
    .get();
  if (!row) return {};
  try {
    const plaintext = isKeychainEncryptedValue(row.encryptedSession)
      ? decryptWithKeychain(row.encryptedSession)
      : decrypt(row.encryptedSession);
    const parsed = JSON.parse(plaintext);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export const saveMcpOAuthSession = (
  serverId: string,
  session: McpOAuthSession,
  options: { credentialsStore?: McpOAuthSessionCredentialsStore } = {},
): void => {
  const now = new Date().toISOString();
  const serialized = JSON.stringify(session);
  const encryptSession = () =>
    options.credentialsStore === "keychain" && isKeychainEncryptionAvailable()
      ? encryptWithKeychain(serialized)
      : encrypt(serialized);
  db.insert(schema.mcpOAuthSessions)
    .values({
      serverId,
      encryptedSession: encryptSession(),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.mcpOAuthSessions.serverId,
      set: {
        encryptedSession: encryptSession(),
        updatedAt: now,
      },
    })
    .run();
};

export const deleteMcpOAuthSession = (serverId: string): void => {
  db.delete(schema.mcpOAuthSessions)
    .where(eq(schema.mcpOAuthSessions.serverId, serverId))
    .run();
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

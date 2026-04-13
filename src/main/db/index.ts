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
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace ON chat_sessions(workspace_path, updated_at);
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      parts TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_chat_workspace ON chat_messages(workspace_path, timestamp);
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
  `);

	// Migrate: add parts column if missing (for existing databases)
	const columns = sqlite.pragma("table_info(chat_messages)") as {
		name: string;
	}[];
	if (!columns.some((c) => c.name === "parts")) {
		sqlite.exec("ALTER TABLE chat_messages ADD COLUMN parts TEXT");
	}
	// Migrate: add session_id column if missing
	if (!columns.some((c) => c.name === "session_id")) {
		sqlite.exec(
			"ALTER TABLE chat_messages ADD COLUMN session_id TEXT DEFAULT ''",
		);
	}

	// Create session_id index after ensuring column exists
	sqlite.exec(
		"CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_messages(session_id, timestamp)",
	);

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

	// Migrate orphan messages (no session_id) into auto-created sessions
	const orphans = sqlite
		.prepare(
			"SELECT DISTINCT workspace_path FROM chat_messages WHERE session_id = '' OR session_id IS NULL",
		)
		.all() as { workspace_path: string }[];
	for (const { workspace_path } of orphans) {
		const sessionId = crypto.randomUUID();
		const now = new Date().toISOString();
		sqlite
			.prepare(
				"INSERT INTO chat_sessions (id, workspace_path, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(sessionId, workspace_path, "历史对话", now, now);
		sqlite
			.prepare(
				"UPDATE chat_messages SET session_id = ? WHERE workspace_path = ? AND (session_id = '' OR session_id IS NULL)",
			)
			.run(sessionId, workspace_path);
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
}

interface ChatMessage {
	id: string;
	sessionId: string;
	role: "user" | "assistant";
	content: string;
	timestamp: string;
	parts?: unknown[];
}

interface ChatSession {
	id: string;
	workspacePath: string;
	title: string;
	createdAt: string;
	updatedAt: string;
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

export const addRecentWorkspace = (path: string, name: string) => {
	const now = new Date().toISOString();
	db.insert(schema.recentWorkspaces)
		.values({ path, name, lastOpenedAt: now })
		.onConflictDoUpdate({
			target: schema.recentWorkspaces.path,
			set: { name, lastOpenedAt: now },
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
// Chat Sessions
// ============================================================================

export const createChatSession = (
	workspacePath: string,
	title = "新对话",
): ChatSession => {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	db.insert(schema.chatSessions)
		.values({ id, workspacePath, title, createdAt: now, updatedAt: now })
		.run();
	return { id, workspacePath, title, createdAt: now, updatedAt: now };
};

export const getChatSessions = (workspacePath: string): ChatSession[] =>
	db
		.select()
		.from(schema.chatSessions)
		.where(eq(schema.chatSessions.workspacePath, workspacePath))
		.orderBy(desc(schema.chatSessions.updatedAt))
		.all();

export const updateChatSession = (
	sessionId: string,
	updates: Partial<Pick<ChatSession, "title" | "updatedAt">>,
) => {
	const mapped: Record<string, unknown> = {};
	if (updates.title !== undefined) mapped.title = updates.title;
	mapped.updatedAt = updates.updatedAt ?? new Date().toISOString();
	db.update(schema.chatSessions)
		.set(mapped)
		.where(eq(schema.chatSessions.id, sessionId))
		.run();
};

export const deleteChatSession = (sessionId: string) => {
	db.transaction((tx) => {
		tx.delete(schema.chatMessages)
			.where(eq(schema.chatMessages.sessionId, sessionId))
			.run();
		tx.delete(schema.chatSessions)
			.where(eq(schema.chatSessions.id, sessionId))
			.run();
	});
};

// ============================================================================
// Chat Messages (session-scoped)
// ============================================================================

export const getChatHistory = (sessionId: string): ChatMessage[] =>
	db
		.select({
			id: schema.chatMessages.id,
			sessionId: schema.chatMessages.sessionId,
			role: schema.chatMessages.role,
			content: schema.chatMessages.content,
			timestamp: schema.chatMessages.timestamp,
			parts: schema.chatMessages.parts,
		})
		.from(schema.chatMessages)
		.where(eq(schema.chatMessages.sessionId, sessionId))
		.orderBy(schema.chatMessages.timestamp)
		.all()
		.map((row) => ({
			...row,
			parts: row.parts ? JSON.parse(row.parts) : undefined,
		}));

export const saveChatHistory = (
	sessionId: string,
	workspacePath: string,
	messages: ChatMessage[],
) => {
	db.transaction((tx) => {
		tx.delete(schema.chatMessages)
			.where(eq(schema.chatMessages.sessionId, sessionId))
			.run();
		for (const msg of messages) {
			tx.insert(schema.chatMessages)
				.values({
					id: msg.id,
					sessionId,
					workspacePath,
					role: msg.role,
					content: msg.content,
					timestamp: msg.timestamp,
					parts: msg.parts ? JSON.stringify(msg.parts) : null,
				})
				.run();
		}
	});
	// Touch session updated_at
	updateChatSession(sessionId, { updatedAt: new Date().toISOString() });
};

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

export type {
	ChatMessage,
	ChatSession,
	FileOperation,
	RecentWorkspace,
	Task,
	Workspace,
};

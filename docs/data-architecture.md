# Data Architecture

## Database Schema (Drizzle + SQLite)

**Location:** `src/main/db/schema.ts`

```typescript
// Key tables
export const chatSessions = sqliteTable("chat_sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  workspacePath: text("workspace_path"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").references(() => chatSessions.id),
  role: text("role").notNull(),
  content: text("content").notNull(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // Encrypted for sensitive values
});
```

## Database Operations

```bash
# Database is automatically initialized on first run
# SQLite file location: userData/filework.db
# Schema defined in: src/main/db/schema.ts
```

## Type Safety Pattern

**Use Zod schemas for runtime validation:**

```typescript
// Define schema
const MyDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().min(0)
});

// Infer type
type MyData = z.infer<typeof MyDataSchema>;

// Validate at runtime
const validated = MyDataSchema.parse(untrustedData);
```

## IPC Handler Pattern

**All main process functionality exposed via IPC handlers:**

```typescript
// src/main/ipc/{feature}-handlers.ts
import { ipcMain } from "electron";

export function register{Feature}Handlers() {
  ipcMain.handle("feature:action", async (event, params) => {
    // Implementation
    return result;
  });
}

// Called in src/main/index.ts
registerFeatureHandlers();
```

**Handler Categories:**
- `ai-handlers.ts` - AI chat, skill execution, LLM interactions
- `file-handlers.ts` - File system operations
- `settings-handlers.ts` - User preferences
- `workspace-handlers.ts` - Directory/workspace management

## Database Inspection

**Database Inspection:**
- SQLite browser or similar tools
- Database location: `userData/filework.db`
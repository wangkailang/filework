/**
 * Cross-layer MCP types shared between the manager, tool-bridge, IPC
 * handlers, and (via preload) the renderer panel.
 *
 * `McpServer` itself lives in `src/main/db/index.ts` since it mirrors a
 * SQLite row — re-exported here for convenience so consumers in the MCP
 * subsystem only need one import path.
 */

export type {
  McpServer,
  McpServerInput,
  McpTransport,
} from "../db";

/** Snapshot of one server's runtime state for the renderer status UI. */
export interface McpServerStatus {
  id: string;
  connected: boolean;
  connecting: boolean;
  toolCount: number;
  lastError: string | null;
  lastConnectedAt: string | null;
}

/** A single MCP-side tool descriptor surfaced to the renderer. */
export interface McpToolSummary {
  name: string;
  description: string;
  /** `mcp__<serverSlug>__<tool>` — what the model will see. */
  fullName: string;
}

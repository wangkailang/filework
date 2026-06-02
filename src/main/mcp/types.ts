/**
 * 跨层共享的 MCP 类型,供 manager、tool-bridge、IPC
 * 处理器以及(经由 preload)渲染进程面板共用。
 *
 * `McpServer` 本身定义在 `src/main/db/index.ts`,因为它对应
 * 一行 SQLite 记录 —— 在此重新导出以方便 MCP 子系统的
 * 使用方只需一条导入路径。
 */

export type {
  McpServer,
  McpServerInput,
  McpTransport,
} from "../db";

/** 供渲染进程状态 UI 使用的单个服务器运行时状态快照。 */
export interface McpServerStatus {
  id: string;
  connected: boolean;
  connecting: boolean;
  toolCount: number;
  lastError: string | null;
  lastConnectedAt: string | null;
}

/** 暴露给渲染进程的单个 MCP 侧工具描述符。 */
export interface McpToolSummary {
  name: string;
  description: string;
  /** `mcp__<serverSlug>__<tool>` —— 模型实际看到的名称。 */
  fullName: string;
}

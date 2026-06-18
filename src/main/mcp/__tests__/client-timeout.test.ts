import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  closeTransport: vi.fn(),
  listTools: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(function Client() {
    return {
      connect: mocks.connect,
      close: vi.fn(),
      listTools: mocks.listTools,
    };
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi
    .fn()
    .mockImplementation(function StreamableHTTPClientTransport() {
      return {
        close: mocks.closeTransport,
        onclose: null,
        onerror: null,
      };
    }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi
    .fn()
    .mockImplementation(function StdioClientTransport() {
      return {
        close: vi.fn(),
        onclose: null,
        onerror: null,
      };
    }),
}));

import { McpClient } from "../client";
import type { McpServer } from "../types";

const pending = Symbol("pending");

const promiseState = async <T>(promise: Promise<T>) =>
  Promise.race([promise, Promise.resolve(pending as typeof pending)]);

const server = {
  id: "server-1",
  name: "slow",
  transport: "http",
  command: null,
  args: [],
  env: {},
  cwd: null,
  url: "https://slow.example/mcp",
  headers: {},
  authType: "none",
  oauthScopes: [],
  oauthClientId: null,
  oauthClientSecret: null,
  enabled: true,
  trusted: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
} satisfies McpServer;

describe("McpClient connection timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.connect.mockReset();
    mocks.closeTransport.mockReset();
    mocks.listTools.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects and closes the transport when the initial connection hangs", async () => {
    mocks.connect.mockReturnValue(new Promise(() => undefined));
    const client = new McpClient(server, { connectTimeoutMs: 10 });

    const result = client.connect().then(
      () => "connected",
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );

    await vi.advanceTimersByTimeAsync(11);

    expect(await promiseState(result)).toBe(
      'MCP server "slow" connection timed out after 10ms',
    );
    expect(mocks.closeTransport).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });
});

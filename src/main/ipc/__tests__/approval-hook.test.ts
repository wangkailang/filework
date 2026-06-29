import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BeforeToolCallHook,
  ToolContext,
} from "../../core/agent/tool-registry";
import { LocalWorkspace } from "../../core/workspace/local-workspace";
import { cleanupTask, setTaskWorkspace } from "../ai-task-control";
import { __resetBatcherForTests } from "../approval-batcher";
import { buildApprovalHook } from "../approval-hook";

const pending = Symbol("pending");
const withShortTimeout = <T>(
  promise: Promise<T>,
): Promise<T | typeof pending> =>
  Promise.race([
    promise,
    new Promise<typeof pending>((resolve) => {
      setTimeout(() => resolve(pending), 100);
    }),
  ]);

describe("buildApprovalHook chat permission overrides", () => {
  let root: string;
  let outsideRoot: string;
  let workspace: LocalWorkspace;
  let sender: { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-approval-hook-"));
    outsideRoot = await mkdtemp(path.join(tmpdir(), "fw-approval-outside-"));
    workspace = new LocalWorkspace(root);
    sender = { isDestroyed: () => false, send: vi.fn() };
    __resetBatcherForTests();
  });

  afterEach(async () => {
    cleanupTask("task-chat-permission");
    __resetBatcherForTests();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  const makeHook = (
    approvalPolicy: "on-request" | "never",
    sandboxMode: "workspace-write" | "danger-full-access",
  ): BeforeToolCallHook =>
    buildApprovalHook({
      approvalPolicy,
      sandboxMode,
      sender: sender as unknown as WebContents,
      taskId: "task-chat-permission",
      workspace,
    });

  const ctx = (): ToolContext => ({
    signal: new AbortController().signal,
    toolCallId: "call-1",
    workspace,
  });

  it("auto mode approves workspace destructive tools without emitting an approval request", async () => {
    const target = path.join(root, "remove-me.txt");
    await writeFile(target, "x");
    setTaskWorkspace("task-chat-permission", root);

    const hook = makeHook("never", "workspace-write");
    const result = await withShortTimeout(
      hook(
        {
          args: { path: target },
          toolCallId: "call-delete",
          toolName: "deleteFile",
        },
        ctx(),
      ),
    );

    expect(result).toEqual({ allow: true });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("auto mode does not silently grant runCommand escalation", async () => {
    setTaskWorkspace("task-chat-permission", root);

    const hook = makeHook("never", "workspace-write");
    const result = await Promise.race([
      hook(
        {
          args: {
            command: "curl https://example.com",
            escalatePermissions: true,
          },
          toolCallId: "call-run",
          toolName: "runCommand",
        },
        ctx(),
      ),
      Promise.resolve(pending),
    ]);

    expect(result).toMatchObject({ allow: false });
    expect(String((result as { reason?: string }).reason)).toContain(
      "完全访问权限",
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("full mode allows commands to run outside the workspace without approval", async () => {
    setTaskWorkspace("task-chat-permission", root);

    const hook = makeHook("never", "danger-full-access");
    const result = await Promise.race([
      hook(
        {
          args: { command: "pwd", cwd: outsideRoot },
          toolCallId: "call-run-full",
          toolName: "runCommand",
        },
        ctx(),
      ),
      Promise.resolve(pending),
    ]);

    expect(result).toEqual({ allow: true });
    expect(sender.send).not.toHaveBeenCalled();
  });
});

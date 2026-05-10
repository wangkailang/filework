import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isToolWhitelistedForTask,
  pendingApprovals,
  toolCallToTaskMap,
} from "../ai-task-control";
import { requestApproval } from "../ai-tools";

/**
 * Asserts the M6 PR 2 approval routing: `gitCommit` follows the
 * whitelist-after-first-ok pattern; `gitPush` and `openPullRequest`
 * never get whitelisted (they always re-prompt).
 *
 * Doesn't reach into IPC — `requestApproval` only checks
 * `sender.isDestroyed()` to gate the send, so a stub WebContents is
 * sufficient.
 */
const stubSender = (): Electron.WebContents =>
  ({
    isDestroyed: () => false,
    send: () => {},
  }) as unknown as Electron.WebContents;

const settle = async (toolCallId: string, approved: boolean): Promise<void> => {
  // Yield once so requestApproval has a chance to register the resolver.
  await Promise.resolve();
  const resolve = pendingApprovals.get(toolCallId);
  if (!resolve) throw new Error(`no pending approval for ${toolCallId}`);
  resolve(approved);
};

describe("requestApproval — whitelist routing", () => {
  beforeEach(() => {
    pendingApprovals.clear();
    toolCallToTaskMap.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gitCommit auto-approves the second invocation after the first user OK", async () => {
    const taskId = "t-commit";
    const sender = stubSender();

    const p1 = requestApproval(sender, taskId, "tc-1", "gitCommit", {
      message: "x",
    });
    await settle("tc-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitCommit")).toBe(true);

    // Second call: short-circuited; no pendingApprovals entry created.
    const p2 = requestApproval(sender, taskId, "tc-2", "gitCommit", {
      message: "y",
    });
    expect(pendingApprovals.has("tc-2")).toBe(false);
    expect(await p2).toBe(true);
  });

  it("gitPush re-prompts every time even after the user has approved once", async () => {
    const taskId = "t-push";
    const sender = stubSender();

    const p1 = requestApproval(sender, taskId, "tp-1", "gitPush", {});
    await settle("tp-1", true);
    expect(await p1).toBe(true);
    // Critical: NOT whitelisted.
    expect(isToolWhitelistedForTask(taskId, "gitPush")).toBe(false);

    const p2 = requestApproval(sender, taskId, "tp-2", "gitPush", {});
    expect(pendingApprovals.has("tp-2")).toBe(true);
    await settle("tp-2", true);
    expect(await p2).toBe(true);
  });

  it("openPullRequest also never enters the whitelist", async () => {
    const taskId = "t-pr";
    const sender = stubSender();

    const p1 = requestApproval(sender, taskId, "tpr-1", "openPullRequest", {
      title: "x",
    });
    await settle("tpr-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "openPullRequest")).toBe(false);
  });

  it("githubCommentIssue re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-comment-issue";
    const sender = stubSender();
    const p1 = requestApproval(sender, taskId, "tci-1", "githubCommentIssue", {
      number: 5,
      body: "thanks!",
    });
    await settle("tci-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubCommentIssue")).toBe(false);
    // Second call must register a fresh approval (no auto-approve).
    const p2 = requestApproval(sender, taskId, "tci-2", "githubCommentIssue", {
      number: 6,
      body: "again",
    });
    expect(pendingApprovals.has("tci-2")).toBe(true);
    await settle("tci-2", true);
    expect(await p2).toBe(true);
  });

  it("githubCommentPullRequest also never enters the whitelist", async () => {
    const taskId = "t-comment-pr";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tcp-1",
      "githubCommentPullRequest",
      { number: 42, body: "ok" },
    );
    await settle("tcp-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubCommentPullRequest")).toBe(
      false,
    );
  });

  it("control: writeFile still whitelists (regression guard)", async () => {
    const taskId = "t-write";
    const sender = stubSender();
    const p = requestApproval(sender, taskId, "tw-1", "writeFile", {
      path: "/a",
    });
    await settle("tw-1", true);
    expect(await p).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "writeFile")).toBe(true);
  });
});

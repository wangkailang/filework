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

  it("gitlabCommentIssue re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gl-issue";
    const sender = stubSender();
    const p1 = requestApproval(sender, taskId, "tgi-1", "gitlabCommentIssue", {
      number: 5,
      body: "hi",
    });
    await settle("tgi-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabCommentIssue")).toBe(false);

    const p2 = requestApproval(sender, taskId, "tgi-2", "gitlabCommentIssue", {
      number: 6,
      body: "again",
    });
    expect(pendingApprovals.has("tgi-2")).toBe(true);
    await settle("tgi-2", true);
    expect(await p2).toBe(true);
  });

  it("gitlabCommentMergeRequest also never enters the whitelist", async () => {
    const taskId = "t-gl-mr";
    const sender = stubSender();
    const p = requestApproval(
      sender,
      taskId,
      "tgm-1",
      "gitlabCommentMergeRequest",
      { number: 42, body: "ok" },
    );
    await settle("tgm-1", true);
    expect(await p).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabCommentMergeRequest")).toBe(
      false,
    );
  });

  // ── M9: re-run tools never enter the whitelist ──────────────────────

  it("githubRerunWorkflowRun re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-rerun";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "trr-1",
      "githubRerunWorkflowRun",
      { runId: "1" },
    );
    await settle("trr-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubRerunWorkflowRun")).toBe(
      false,
    );

    const p2 = requestApproval(
      sender,
      taskId,
      "trr-2",
      "githubRerunWorkflowRun",
      { runId: "1" },
    );
    expect(pendingApprovals.has("trr-2")).toBe(true);
    await settle("trr-2", true);
    expect(await p2).toBe(true);
  });

  it("githubRerunFailedJobs also never enters the whitelist", async () => {
    const taskId = "t-gh-rerun-failed";
    const sender = stubSender();
    const p = requestApproval(
      sender,
      taskId,
      "trf-1",
      "githubRerunFailedJobs",
      { runId: "1" },
    );
    await settle("trf-1", true);
    expect(await p).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubRerunFailedJobs")).toBe(
      false,
    );
  });

  it("gitlabRetryPipeline also never enters the whitelist", async () => {
    const taskId = "t-gl-retry";
    const sender = stubSender();
    const p = requestApproval(sender, taskId, "tgr-1", "gitlabRetryPipeline", {
      runId: "1",
    });
    await settle("tgr-1", true);
    expect(await p).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabRetryPipeline")).toBe(false);
  });

  // ── M10: PR/MR review tools never enter the whitelist ───────────────

  it("githubReviewPullRequest re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-review";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "trv-1",
      "githubReviewPullRequest",
      { number: 7, body: "ok" },
    );
    await settle("trv-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubReviewPullRequest")).toBe(
      false,
    );

    const p2 = requestApproval(
      sender,
      taskId,
      "trv-2",
      "githubReviewPullRequest",
      { number: 7, body: "more thoughts" },
    );
    expect(pendingApprovals.has("trv-2")).toBe(true);
    await settle("trv-2", true);
    expect(await p2).toBe(true);
  });

  it("gitlabReviewMergeRequest also never enters the whitelist", async () => {
    const taskId = "t-gl-review";
    const sender = stubSender();
    const p = requestApproval(
      sender,
      taskId,
      "tglr-1",
      "gitlabReviewMergeRequest",
      { number: 7, body: "ok" },
    );
    await settle("tglr-1", true);
    expect(await p).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabReviewMergeRequest")).toBe(
      false,
    );
  });

  // ── M11: dispatch ALWAYS prompts; cancel whitelists after first OK ──

  it("githubDispatchWorkflow re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-dispatch";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tdsp-1",
      "githubDispatchWorkflow",
      { workflowFile: "ci.yml", ref: "main" },
    );
    await settle("tdsp-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubDispatchWorkflow")).toBe(
      false,
    );

    const p2 = requestApproval(
      sender,
      taskId,
      "tdsp-2",
      "githubDispatchWorkflow",
      { workflowFile: "ci.yml", ref: "main" },
    );
    expect(pendingApprovals.has("tdsp-2")).toBe(true);
    await settle("tdsp-2", true);
    expect(await p2).toBe(true);
  });

  it("githubCancelWorkflowRun whitelists after first OK (auto-approves second call)", async () => {
    const taskId = "t-gh-cancel";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tcc-1",
      "githubCancelWorkflowRun",
      { runId: "1" },
    );
    await settle("tcc-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubCancelWorkflowRun")).toBe(
      true,
    );

    // Second call: short-circuited; no pendingApprovals entry created.
    const p2 = requestApproval(
      sender,
      taskId,
      "tcc-2",
      "githubCancelWorkflowRun",
      { runId: "2" },
    );
    expect(pendingApprovals.has("tcc-2")).toBe(false);
    expect(await p2).toBe(true);
  });

  it("gitlabCancelPipeline also whitelists after first OK", async () => {
    const taskId = "t-gl-cancel";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tgc-1",
      "gitlabCancelPipeline",
      { runId: "1" },
    );
    await settle("tgc-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabCancelPipeline")).toBe(true);

    const p2 = requestApproval(
      sender,
      taskId,
      "tgc-2",
      "gitlabCancelPipeline",
      { runId: "2" },
    );
    expect(pendingApprovals.has("tgc-2")).toBe(false);
    expect(await p2).toBe(true);
  });

  // ── M14: gitlabCreatePipeline always prompts ───────────────────────

  it("gitlabCreatePipeline re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gl-create";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tgcp-1",
      "gitlabCreatePipeline",
      { ref: "main" },
    );
    await settle("tgcp-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabCreatePipeline")).toBe(
      false,
    );

    const p2 = requestApproval(
      sender,
      taskId,
      "tgcp-2",
      "gitlabCreatePipeline",
      { ref: "main", variables: { ENV: "staging" } },
    );
    expect(pendingApprovals.has("tgcp-2")).toBe(true);
    await settle("tgcp-2", true);
    expect(await p2).toBe(true);
  });

  // ── M15: review lifecycle tools always prompt ──────────────────────

  it("githubDismissReview re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-dismiss";
    const sender = stubSender();
    const p1 = requestApproval(sender, taskId, "tgd-1", "githubDismissReview", {
      number: 7,
      reviewId: "999",
      message: "hasty",
    });
    await settle("tgd-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubDismissReview")).toBe(false);

    const p2 = requestApproval(sender, taskId, "tgd-2", "githubDismissReview", {
      number: 7,
      reviewId: "1000",
      message: "again",
    });
    expect(pendingApprovals.has("tgd-2")).toBe(true);
    await settle("tgd-2", true);
    expect(await p2).toBe(true);
  });

  it("githubEditReviewBody re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-edit";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tge-1",
      "githubEditReviewBody",
      { number: 7, reviewId: "42", body: "final" },
    );
    await settle("tge-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "githubEditReviewBody")).toBe(
      false,
    );

    const p2 = requestApproval(
      sender,
      taskId,
      "tge-2",
      "githubEditReviewBody",
      { number: 7, reviewId: "42", body: "final v2" },
    );
    expect(pendingApprovals.has("tge-2")).toBe(true);
    await settle("tge-2", true);
    expect(await p2).toBe(true);
  });

  // ── M16: GitLab MR Approve / Unapprove always prompt ───────────────

  it("gitlabApproveMergeRequest re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gl-approve";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tga-1",
      "gitlabApproveMergeRequest",
      { number: 7 },
    );
    await settle("tga-1", true);
    expect(await p1).toBe(true);
    expect(isToolWhitelistedForTask(taskId, "gitlabApproveMergeRequest")).toBe(
      false,
    );

    const p2 = requestApproval(
      sender,
      taskId,
      "tga-2",
      "gitlabApproveMergeRequest",
      { number: 7 },
    );
    expect(pendingApprovals.has("tga-2")).toBe(true);
    await settle("tga-2", true);
    expect(await p2).toBe(true);
  });

  it("gitlabUnapproveMergeRequest re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gl-unapprove";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tgu-1",
      "gitlabUnapproveMergeRequest",
      { number: 9 },
    );
    await settle("tgu-1", true);
    expect(await p1).toBe(true);
    expect(
      isToolWhitelistedForTask(taskId, "gitlabUnapproveMergeRequest"),
    ).toBe(false);

    const p2 = requestApproval(
      sender,
      taskId,
      "tgu-2",
      "gitlabUnapproveMergeRequest",
      { number: 9 },
    );
    expect(pendingApprovals.has("tgu-2")).toBe(true);
    await settle("tgu-2", true);
    expect(await p2).toBe(true);
  });

  // ── M17: PR inline-comment edit / delete always prompt ─────────────

  it("githubEditPullRequestReviewComment re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-edit-com";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tgec-1",
      "githubEditPullRequestReviewComment",
      { commentId: "12345", body: "fix" },
    );
    await settle("tgec-1", true);
    expect(await p1).toBe(true);
    expect(
      isToolWhitelistedForTask(taskId, "githubEditPullRequestReviewComment"),
    ).toBe(false);

    const p2 = requestApproval(
      sender,
      taskId,
      "tgec-2",
      "githubEditPullRequestReviewComment",
      { commentId: "12345", body: "fix v2" },
    );
    expect(pendingApprovals.has("tgec-2")).toBe(true);
    await settle("tgec-2", true);
    expect(await p2).toBe(true);
  });

  it("githubDeletePullRequestReviewComment re-prompts every time (never whitelisted)", async () => {
    const taskId = "t-gh-del-com";
    const sender = stubSender();
    const p1 = requestApproval(
      sender,
      taskId,
      "tgdc-1",
      "githubDeletePullRequestReviewComment",
      { commentId: "12346" },
    );
    await settle("tgdc-1", true);
    expect(await p1).toBe(true);
    expect(
      isToolWhitelistedForTask(taskId, "githubDeletePullRequestReviewComment"),
    ).toBe(false);

    const p2 = requestApproval(
      sender,
      taskId,
      "tgdc-2",
      "githubDeletePullRequestReviewComment",
      { commentId: "12347" },
    );
    expect(pendingApprovals.has("tgdc-2")).toBe(true);
    await settle("tgdc-2", true);
    expect(await p2).toBe(true);
  });
});

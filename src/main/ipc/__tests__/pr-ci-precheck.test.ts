/**
 * approval-hook (M8) — pre-PR CI heads-up check.
 *
 * The hook fetches the latest CI run on the head branch when the agent
 * calls `openPullRequest`. If the run is failed/cancelled, it builds a
 * warning string and threads it as `extraContext` into requestApproval
 * (which then forwards it to the renderer). All other tools, success
 * runs, and CI lookup failures must NOT add a warning.
 */

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestApproval = vi.fn(
  async (..._args: unknown[]): Promise<boolean> => true,
);
vi.mock("../ai-tools", () => ({
  requestApproval: (...args: unknown[]) => requestApproval(...args),
}));

vi.mock("../approval-utils", () => ({
  canAutoApproveWrite: vi.fn(async () => false),
  isInWorkspace: vi.fn(async () => true),
}));

import { buildApprovalHook } from "../approval-hook";

const stubSender = (): WebContents =>
  ({ isDestroyed: () => false, send: () => {} }) as unknown as WebContents;

const buildCtx = (overrides: {
  currentBranch?: () => Promise<string>;
  listCIRuns?: (...args: unknown[]) => Promise<unknown>;
  noScm?: boolean;
}) => ({
  workspace: {
    id: "github:acme/app@main",
    kind: "github",
    root: "/tmp/clone",
    fs: {} as never,
    exec: {} as never,
    scm: overrides.noScm
      ? undefined
      : {
          currentBranch: overrides.currentBranch,
          listCIRuns: overrides.listCIRuns,
        },
  },
  signal: new AbortController().signal,
  toolCallId: "tc-1",
});

describe("buildApprovalHook — pre-PR CI heads-up", () => {
  beforeEach(() => {
    requestApproval.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches extraContext when latest run conclusion is failure", async () => {
    const hook = buildApprovalHook({ sender: stubSender(), taskId: "t-1" });
    const listCIRuns = vi.fn(async () => [
      {
        id: "1",
        name: "CI",
        status: "completed",
        conclusion: "failure",
        ref: "feat/x",
        commitSha: "abc",
        url: "https://gh/runs/1",
        startedAt: "2026-05-10T10:00:00Z",
        completedAt: "2026-05-10T10:05:00Z",
      },
    ]);
    const ctx = buildCtx({
      currentBranch: async () => "feat/x",
      listCIRuns,
      // biome-ignore lint/suspicious/noExplicitAny: ctx.workspace stub
    }) as any;

    await hook(
      { toolName: "openPullRequest", toolCallId: "tc-1", args: { title: "x" } },
      ctx,
    );

    expect(listCIRuns).toHaveBeenCalledWith({ ref: "feat/x", limit: 1 });
    const lastCall = requestApproval.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const extraContext = lastCall?.[6] as string | undefined;
    expect(extraContext).toContain("CI");
    expect(extraContext).toContain("failure");
    expect(extraContext).toContain("https://gh/runs/1");
  });

  it("does NOT attach extraContext when latest run is success", async () => {
    const hook = buildApprovalHook({ sender: stubSender(), taskId: "t-1" });
    const ctx = buildCtx({
      currentBranch: async () => "feat/x",
      listCIRuns: async () => [
        {
          id: "1",
          name: "CI",
          status: "completed",
          conclusion: "success",
          ref: "feat/x",
          commitSha: "abc",
          url: "https://gh/runs/1",
          startedAt: "2026-05-10T10:00:00Z",
          completedAt: "2026-05-10T10:05:00Z",
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: ctx.workspace stub
    }) as any;

    await hook(
      { toolName: "openPullRequest", toolCallId: "tc-1", args: { title: "x" } },
      ctx,
    );
    expect(requestApproval.mock.calls.at(-1)?.[6]).toBeUndefined();
  });

  it("does NOT attach extraContext for non-PR tools", async () => {
    const hook = buildApprovalHook({ sender: stubSender(), taskId: "t-1" });
    const listCIRuns = vi.fn();
    const ctx = buildCtx({
      currentBranch: async () => "feat/x",
      listCIRuns,
      // biome-ignore lint/suspicious/noExplicitAny: ctx.workspace stub
    }) as any;

    await hook({ toolName: "gitPush", toolCallId: "tc-2", args: {} }, ctx);

    expect(listCIRuns).not.toHaveBeenCalled();
    expect(requestApproval.mock.calls.at(-1)?.[6]).toBeUndefined();
  });

  it("absorbs listCIRuns errors silently and still calls requestApproval", async () => {
    const hook = buildApprovalHook({ sender: stubSender(), taskId: "t-1" });
    const ctx = buildCtx({
      currentBranch: async () => "feat/x",
      listCIRuns: async () => {
        throw new Error("rate limited");
      },
      // biome-ignore lint/suspicious/noExplicitAny: ctx.workspace stub
    }) as any;

    const result = await hook(
      { toolName: "openPullRequest", toolCallId: "tc-3", args: { title: "x" } },
      ctx,
    );
    expect(result).toEqual({ allow: true });
    expect(requestApproval.mock.calls.at(-1)?.[6]).toBeUndefined();
  });

  it("skips the CI lookup entirely when scm.listCIRuns is missing", async () => {
    const hook = buildApprovalHook({ sender: stubSender(), taskId: "t-1" });
    const ctx = buildCtx({
      noScm: true,
      // biome-ignore lint/suspicious/noExplicitAny: ctx.workspace stub
    }) as any;

    const result = await hook(
      { toolName: "openPullRequest", toolCallId: "tc-4", args: { title: "x" } },
      ctx,
    );
    expect(result).toEqual({ allow: true });
    expect(requestApproval.mock.calls.at(-1)?.[6]).toBeUndefined();
  });
});

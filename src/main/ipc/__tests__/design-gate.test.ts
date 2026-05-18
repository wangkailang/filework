import { beforeEach, describe, expect, it } from "vitest";

import type { ToolContext } from "../../core/agent/tool-registry";
import {
  __resetAllWorkflowStateForTests,
  recordDesignDecision,
  recordPendingDesign,
} from "../../state/chat-workflow-state";
import { buildApprovalHook } from "../approval-hook";

const stubSender = (): Electron.WebContents =>
  ({
    isDestroyed: () => false,
    send: () => {},
  }) as unknown as Electron.WebContents;

const stubCtx = (): ToolContext =>
  ({
    workspace: { kind: "local", root: "/tmp" } as never,
    signal: new AbortController().signal,
    toolCallId: "tc-1",
  }) as ToolContext;

const call = (toolName: string, args: unknown = {}) => ({
  toolName,
  toolCallId: "tc-1",
  args,
});

describe("design gate (approval-hook)", () => {
  beforeEach(() => {
    __resetAllWorkflowStateForTests();
  });

  describe("enforceDesignGate: false (default)", () => {
    it("does NOT short-circuit with the design-gate reason when disabled", async () => {
      const hook = buildApprovalHook({
        sender: stubSender(),
        taskId: "t-1",
        sessionId: "sess-1",
        // enforceDesignGate defaults to false
      });
      // deleteFile with an out-of-workspace path: the next layer
      // (workspace-bounds check) will deny with its own reason. Proof
      // that the design gate did not intercept.
      const decision = await hook(
        call("deleteFile", { path: "/etc/passwd" }),
        stubCtx(),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).not.toMatch(/Design not approved/);
    });
  });

  describe("enforceDesignGate: true", () => {
    it("blocks destructive tools when no design has been approved", async () => {
      const hook = buildApprovalHook({
        sender: stubSender(),
        taskId: "t-2",
        sessionId: "sess-2",
        enforceDesignGate: true,
      });
      const decision = await hook(
        call("deleteFile", { path: "/tmp/foo" }),
        stubCtx(),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toMatch(/Design not approved/);
    });

    it("blocks destructive tools after a rejected design", async () => {
      recordPendingDesign("sess-3", "draft");
      recordDesignDecision("sess-3", {
        approved: false,
        reason: "scope too wide",
      });
      const hook = buildApprovalHook({
        sender: stubSender(),
        taskId: "t-3",
        sessionId: "sess-3",
        enforceDesignGate: true,
      });
      const decision = await hook(
        call("deleteFile", { path: "/tmp/foo" }),
        stubCtx(),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).toMatch(/Design not approved/);
    });

    it("falls through to the standard approval flow once a design is approved", async () => {
      recordPendingDesign("sess-4", "draft");
      recordDesignDecision("sess-4", { approved: true });
      const hook = buildApprovalHook({
        sender: stubSender(),
        taskId: "t-4",
        sessionId: "sess-4",
        enforceDesignGate: true,
      });
      const decision = await hook(
        call("deleteFile", { path: "/etc/passwd" }),
        stubCtx(),
      );
      expect(decision.allow).toBe(false);
      expect(decision.reason).not.toMatch(/Design not approved/);
    });

    it("isolates the gate per workflow key (different sessionId)", async () => {
      recordPendingDesign("sess-a", "a");
      recordDesignDecision("sess-a", { approved: true });
      // sess-b never approves.

      const hookB = buildApprovalHook({
        sender: stubSender(),
        taskId: "t-b",
        sessionId: "sess-b",
        enforceDesignGate: true,
      });
      const decisionB = await hookB(
        call("deleteFile", { path: "/tmp/x" }),
        stubCtx(),
      );
      expect(decisionB.allow).toBe(false);
      expect(decisionB.reason).toMatch(/Design not approved/);
    });

    it("falls back to taskId as the workflow key when no sessionId is provided", async () => {
      recordPendingDesign("t-5", "design");
      recordDesignDecision("t-5", { approved: true });
      const hook = buildApprovalHook({
        sender: stubSender(),
        taskId: "t-5",
        enforceDesignGate: true,
      });
      const decision = await hook(
        call("deleteFile", { path: "/etc/passwd" }),
        stubCtx(),
      );
      expect(decision.reason).not.toMatch(/Design not approved/);
    });
  });
});

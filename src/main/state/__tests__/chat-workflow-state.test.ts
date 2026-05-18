import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetAllWorkflowStateForTests,
  clearWorkflowState,
  getWorkflowState,
  isDesignApproved,
  recordDesignDecision,
  recordPendingDesign,
  resolveWorkflowKey,
} from "../chat-workflow-state";

describe("chat-workflow-state", () => {
  beforeEach(() => {
    __resetAllWorkflowStateForTests();
  });

  describe("resolveWorkflowKey", () => {
    it("prefers sessionId when present", () => {
      expect(resolveWorkflowKey("sess_1", "task_42")).toBe("sess_1");
    });

    it("falls back to taskId when sessionId is undefined", () => {
      expect(resolveWorkflowKey(undefined, "task_42")).toBe("task_42");
    });
  });

  describe("default state", () => {
    it("returns designApproved=false for unknown chats", () => {
      expect(getWorkflowState("chat_x")).toEqual({ designApproved: false });
      expect(isDesignApproved("chat_x")).toBe(false);
    });
  });

  describe("recordPendingDesign", () => {
    it("stores the design but keeps approval false", () => {
      recordPendingDesign("chat_1", "# Design\nDo X then Y.");
      const s = getWorkflowState("chat_1");
      expect(s.designApproved).toBe(false);
      expect(s.pendingDesignDoc).toBe("# Design\nDo X then Y.");
    });

    it("clears any previous decision when a new design is sent", () => {
      recordPendingDesign("chat_1", "first design");
      recordDesignDecision("chat_1", { approved: true });
      expect(isDesignApproved("chat_1")).toBe(true);

      recordPendingDesign("chat_1", "second design");
      expect(isDesignApproved("chat_1")).toBe(false);
      expect(getWorkflowState("chat_1").pendingDesignDoc).toBe("second design");
    });
  });

  describe("recordDesignDecision", () => {
    it("flips designApproved to true on approval", () => {
      recordPendingDesign("chat_1", "design");
      recordDesignDecision("chat_1", { approved: true });
      expect(isDesignApproved("chat_1")).toBe(true);
      expect(getWorkflowState("chat_1").decidedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    });

    it("keeps designApproved false on rejection and stores the reason", () => {
      recordPendingDesign("chat_1", "design");
      recordDesignDecision("chat_1", {
        approved: false,
        reason: "scope too wide",
      });
      const s = getWorkflowState("chat_1");
      expect(s.designApproved).toBe(false);
      expect(s.lastRejectReason).toBe("scope too wide");
    });

    it("isolates state by workflow key", () => {
      recordPendingDesign("chat_a", "a");
      recordDesignDecision("chat_a", { approved: true });
      recordPendingDesign("chat_b", "b");
      expect(isDesignApproved("chat_a")).toBe(true);
      expect(isDesignApproved("chat_b")).toBe(false);
    });
  });

  describe("clearWorkflowState", () => {
    it("resets state for a single chat without touching others", () => {
      recordPendingDesign("chat_a", "a");
      recordDesignDecision("chat_a", { approved: true });
      recordPendingDesign("chat_b", "b");
      recordDesignDecision("chat_b", { approved: true });

      clearWorkflowState("chat_a");

      expect(isDesignApproved("chat_a")).toBe(false);
      expect(isDesignApproved("chat_b")).toBe(true);
    });
  });
});

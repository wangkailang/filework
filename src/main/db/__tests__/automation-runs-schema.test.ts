import { describe, expect, it } from "vitest";

import {
  automationRunEvents,
  automationRuns,
  contextMemoryChunks,
  tasks,
} from "../schema";

describe("automation run schema", () => {
  it("defines the persisted run table used by scheduler and triage", () => {
    expect(automationRuns).toBeDefined();
    expect(automationRuns.automationId).toBeDefined();
    expect(automationRuns.status).toBeDefined();
    expect(automationRuns.triageStatus).toBeDefined();
    expect(automationRuns.needsActionReason).toBeDefined();
    expect(automationRuns.chatSessionId).toBeDefined();
    expect(automationRuns.assistantMessageId).toBeDefined();
    expect(automationRuns.taskId).toBeDefined();
    expect(automationRuns.output).toBeDefined();
    expect(automationRuns.errorMessage).toBeDefined();
    expect(automationRuns.retryCount).toBeDefined();
    expect(automationRuns.maxAttempts).toBeDefined();
    expect(automationRuns.nextRetryAt).toBeDefined();
    expect(automationRuns.completedAt).toBeDefined();
  });

  it("defines persisted run events for live detail replay", () => {
    expect(automationRunEvents).toBeDefined();
    expect(automationRunEvents.runId).toBeDefined();
    expect(automationRunEvents.sequence).toBeDefined();
    expect(automationRunEvents.type).toBeDefined();
    expect(automationRunEvents.message).toBeDefined();
    expect(automationRunEvents.toolName).toBeDefined();
    expect(automationRunEvents.detail).toBeDefined();
  });

  it("defines task runtime bindings for session reattach and recovery", () => {
    expect(tasks).toBeDefined();
    expect(tasks.sessionId).toBeDefined();
    expect(tasks.assistantMessageId).toBeDefined();
    expect(tasks.updatedAt).toBeDefined();
  });

  it("defines context memory chunks for layered compression recall", () => {
    expect(contextMemoryChunks).toBeDefined();
    expect(contextMemoryChunks.scopeId).toBeDefined();
    expect(contextMemoryChunks.text).toBeDefined();
    expect(contextMemoryChunks.embedding).toBeDefined();
    expect(contextMemoryChunks.source).toBeDefined();
  });
});

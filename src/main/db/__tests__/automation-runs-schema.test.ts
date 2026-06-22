import { describe, expect, it } from "vitest";

import { automationRuns } from "../schema";

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
    expect(automationRuns.completedAt).toBeDefined();
  });
});

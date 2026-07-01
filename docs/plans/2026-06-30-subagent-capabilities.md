# Subagent Capabilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve Filework subagents so the main agent can safely delegate parallel, read-heavy specialist work with durable traceability.

**Architecture:** Keep the current lead-agent `spawnSubagent` fan-out model, including max 6 tasks, max concurrency 4, and no recursive delegation. Add specialist profiles at the contract/system-prompt boundary first, then harden persistence and write-safety without introducing autonomous long-lived agent teams.

**Tech Stack:** Electron main process, TypeScript, Vercel AI SDK `AgentLoop`, Vitest, JSONL chat/run-event persistence.

---

### Task 1: Subagent Role Templates

**Files:**
- Modify: `src/main/ipc/agent-tools.ts`
- Modify: `src/main/ipc/system-prompt.ts`
- Test: `src/main/ipc/__tests__/agent-tools.test.ts`
- Test: `src/main/ipc/__tests__/system-prompt.test.ts`

**Steps:**
1. Write failing tests proving `spawnSubagent` accepts `profile` values for researcher, code reviewer, test analyst, and document summarizer.
2. Write failing tests proving each profile injects focused guidance into the subagent system prompt while preserving the no-recursive-delegation rule.
3. Implement the profile enum and prompt guidance with no change to task count, concurrency, or child tool inheritance.
4. Run targeted Vitest for the two test files.

### Task 2: Durable Subagent Trace

**Files:**
- Modify: `src/main/core/run/event-log.ts`
- Modify: `src/main/core/run/recovery.ts`
- Modify: `src/main/core/session/jsonl-store.ts`
- Test: `src/main/core/run/__tests__/event-log.test.ts`
- Test: `src/main/core/run/__tests__/recovery.test.ts`
- Test: `src/main/core/__tests__/jsonl-store.test.ts`

**Steps:**
1. Write failing tests for preserving subagent delta/tool/result/report events after app restart without misclassifying terminal tasks as interrupted.
2. Add either terminal run-event metadata or session-side subagent trace materialization.
3. Verify completed tasks are not recovered as interrupted and interrupted tasks retain partial subagent trace.

### Task 3: Write Safety

**Files:**
- Modify: `src/main/ipc/agent-tools.ts`
- Modify: `src/main/ipc/fork-skill-runner.ts`
- Test: `src/main/ipc/__tests__/agent-tools.test.ts`
- Test: `src/main/ipc/__tests__/fork-skill-runner.test.ts`

**Steps:**
1. Write failing tests proving subagents default to read-only tools.
2. Add an explicit patch-artifact/write-mode escape hatch without granting direct workspace writes by default.
3. Verify parent agent remains the single writer unless the user explicitly enables a safe write mode.

### Task 4: Product Polish

**Files:**
- Modify: `src/renderer/components/chat/SubagentCard.tsx`
- Modify: `src/renderer/components/chat/SubagentTracePanel.tsx`
- Test: `src/renderer/components/chat/__tests__/SubagentTracePanel.test.tsx`

**Steps:**
1. Show the selected subagent profile in the progress card and trace panel.
2. Verify summaries, failures, token usage, and tool counts remain visible after reload.

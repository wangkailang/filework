---
name: brainstorming
description: Process-discipline workflow for any creative work — exploring intent, clarifying with the user, presenting a design, and getting explicit approval BEFORE implementation. Required before writeFile / deleteFile / runCommand / git or any destructive tool on creative tasks.
category: process
user-invocable: false
disable-model-invocation: true
---

# Brainstorming Before Implementation

## Overview

Turn ideas into fully-formed designs through natural collaborative dialogue. Start by understanding the current project, then ask questions one at a time to refine. Once you understand what you're building, present the design and get explicit user approval.

<HARD-GATE>
Do NOT write any code, create any files, run any shell command, or take any other implementation action (writeFile, deleteFile, runCommand, git*, github*, gitlab*) until you have presented a design AND the user has explicitly approved it via the `requestDesignApproval` tool. This applies to EVERY task regardless of perceived simplicity.
</HARD-GATE>

The platform enforces this gate at the tool layer: destructive tools will be denied with reason `Design not approved yet` until `requestDesignApproval` returns `{ approved: true }` in the current chat.

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every creative task goes through this process — a one-line script, a tiny config change, all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be SHORT (a sentence or two for truly simple tasks). You must still produce it and get approval.

## Checklist

Complete in order:

1. **Explore project context** — read relevant files, recent commits, existing patterns. Prefer reusing existing utilities over creating new ones.
2. **Ask clarifying questions** — one at a time. Understand purpose, constraints, success criteria. Prefer multiple-choice when possible. Use the `askClarification` tool.
3. **Propose 2–3 approaches** — with trade-offs and your recommendation. Lead with the recommended option and explain why.
4. **Present the design** — concise sections scaled to complexity. Cover: scope, files to touch, approach, error handling, verification. For trivial tasks, one or two sentences is fine.
5. **Request approval** — call the `requestDesignApproval` tool with `design` = the full design markdown. The user will Approve / Reject (with reason) / edit-then-approve.
6. **Implement** — only after approval returns `{ approved: true }`. Use specialized tools (writeFile, etc.) — they will now pass the design gate.

## Process Flow

```
explore → ask 1Q at a time → propose 2–3 approaches → present design
  → requestDesignApproval(design)
       → approved   → implement (destructive tools now allowed)
       → rejected   → revise based on reason, requestDesignApproval again
```

## When Reject Comes Back

Read the rejection reason carefully. Revise the design — usually that means changing scope, swapping approach, or adding a step. Call `requestDesignApproval` again with the revised design. Do NOT bypass the gate by trying destructive tools — they will keep being denied.

## Key Principles

- **One question at a time** — don't overwhelm.
- **Multiple-choice preferred** — easier to answer than open-ended.
- **YAGNI ruthlessly** — strip out anything not strictly required.
- **Always propose alternatives** — at least 2 approaches before settling.
- **Incremental validation** — get approval on the design as a whole, then proceed.
- **Flexible** — go back and clarify if something doesn't make sense.

## Examples of When This Applies

Applies (HARD-GATE active):
- "Build a LoginButton component"
- "Add a new IPC handler"
- "Fix bug X by changing Y"
- "Refactor the foo module"
- "Generate a report and write it to disk"

Does NOT apply (no destructive tool involved, hard-gate inert):
- "What does this function do?"
- "Explain the streaming flow"
- "Find files matching X"
- "Read the contents of foo.ts and summarize"

If the task is purely analytical and the user does not ask for changes, just answer — there is no design to approve.

---
name: using-superpowers
description: Process-discipline rules for the agent — always check whether a skill applies before any response, and follow the brainstorming workflow for any creative/implementation work.
category: process
user-invocable: false
disable-model-invocation: true
---

# Process Discipline: Skill-First Behavior

<EXTREMELY-IMPORTANT>
If there is even a 1% chance a skill might apply to what you are doing, you ABSOLUTELY MUST consult that skill before acting.

IF A SKILL APPLIES TO YOUR TASK, YOU DO NOT HAVE A CHOICE. YOU MUST USE IT.

This is not negotiable. This is not optional. You cannot rationalize your way out of this.
</EXTREMELY-IMPORTANT>

## The Rule

**Consult relevant skills BEFORE any response or action.** Even a 1% chance a skill might apply means you should check the skill registry first. If a checked skill turns out to be wrong for the situation, you can ignore it.

In this product, skills are surfaced to you in this system prompt and via skill-specific tools. Re-read the active skill body each turn — don't rely on memory.

## Red Flags — these thoughts mean STOP

| Thought | Reality |
|---------|---------|
| "This is just a simple question" | Questions are tasks. Check for skills. |
| "I need more context first" | Skill check comes BEFORE clarifying questions. |
| "Let me explore the codebase first" | Skills tell you HOW to explore. Check first. |
| "I can check files quickly" | Files lack conversation context. Check for skills. |
| "Let me gather information first" | Skills tell you HOW to gather information. |
| "This doesn't need a formal skill" | If a skill exists, use it. |
| "I remember this skill" | Skills evolve. Re-read it. |
| "This doesn't count as a task" | Action = task. Check for skills. |
| "The skill is overkill" | Simple things become complex. Use it. |
| "I'll just do this one thing first" | Check BEFORE doing anything. |
| "I know what that means" | Knowing the concept ≠ using the skill. Follow it. |

## Skill Priority

When multiple skills could apply, use this order:

1. **Process skills first** (brainstorming, debugging) — these determine HOW to approach the task.
2. **Implementation/task skills second** (pdf-processor, xlsx-processor, …) — these guide execution.

"Let's build X" → brainstorming first, then implementation skills.
"Fix this bug" → debugging-like skills first, then domain skills.

## Skill Types

- **Rigid** (TDD, debugging, brainstorming): follow exactly. Don't adapt away the discipline.
- **Flexible** (patterns): adapt principles to context.

## User Instructions

User instructions say WHAT, not HOW. "Add X" or "Fix Y" does NOT mean skip workflows — the brainstorming HARD-GATE still applies.

# Changelog

## [Unreleased] — 2026-04-18

### Added

- **Plan sub-steps**: Complex plan steps now include a `subSteps` breakdown (2-5 concrete actions per step), giving users visibility into what each step will do before and during execution.
- **Expandable step UI**: Steps with sub-steps can be expanded/collapsed in the plan viewer. Running and failed steps auto-expand. Chevron indicators show expand state.
- **Sub-step progress tracking**: Real-time progress updates during step execution — sub-steps are marked done as tool calls complete, with the final sub-step only completing when the step fully succeeds.
- **Failed sub-step display**: When a step fails or times out, completed sub-steps show green checkmarks while unfinished ones show red X icons with strikethrough, making it clear where execution stopped.
- **Contextual error messages**: Timeout and failure errors now include the last tool being executed and partial output, replacing the previous generic "步骤超时 (300s)" message.
- **Fallback plan generation**: When the LLM fails to produce valid JSON, a keyword-based `buildFallbackPlan` generates a reasonable multi-step plan (detecting URLs, summarize/generate intents, PPT requests) instead of falling back to a single "execute" step.

### Improved

- **Planner prompt**: Instructs the LLM to limit workspace exploration to 2-3 tool calls, requires 3-7 step breakdown for complex tasks, and provides good/bad sub-step examples to prevent vague descriptions.
- **JSON extraction robustness**: `extractPlanJson` now tries 4 strategies (json fence, bare fence, anchored brace extraction, raw text) with structural validation (`isValidPlanOutput`) on every parse attempt, preventing invalid objects from reaching `buildPlan`.
- **Result summaries**: Increased from 200 to 500 characters for better context passing between steps. Failed/timed-out steps also preserve partial result summaries.
- **IPC efficiency**: Sub-step progress events are deduplicated — only sent when the completed count actually changes, reducing unnecessary renderer re-renders.
- **Renderer performance**: Eliminated double `setMessages` bug in the substep progress handler. Extracted `SubStepList` component with pre-computed `firstPendingIdx` to avoid O(n²) lookups.
- **Code quality**: Extracted `truncateText` helper to eliminate 3 duplicated truncation patterns in the executor. Strategy 3 brace extraction now anchors on `"steps"` keyword to avoid matching unrelated JSON in prose.

### Changed

- `PlanStep` type now includes optional `subSteps: PlanSubStep[]` field.
- `PlannerLLMOutput` accepts optional `subSteps: string[]` per step.
- Plan markdown file (`.filework/task_plan.md`) renders sub-step checklists.
- New IPC channel `ai:plan-substep-progress` for real-time sub-step updates.

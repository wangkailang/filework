/**
 * System prompt builders for the AgentLoop.
 *
 * Two prompts live here:
 *  - `buildAgentSystemPrompt` — generic Agent prompt for ad-hoc tasks
 *    (called from `ai-handlers.ts:handleTaskExecution`)
 *  - `buildPlanStepSystemPrompt` — per-step prompt for plan execution
 *    (called from `plan-runner.ts`)
 *
 * Domain-neutral by default: the prompt does not assume a file-management
 * identity, so conceptual / analytical questions ("compare X and Y") no
 * longer get biased toward filesystem operations. When a Skill is matched
 * (explicit `/skill foo` or keyword), the skill body carries the domain
 * context (the skill itself decides what to do with files / web / shell).
 */

import type { UnifiedSkill } from "../skills-runtime/types";
import type { Plan, PlanStep } from "./plan-types";

const AGENT_IDENTITY = `You are a general-purpose AI Agent operating with full access to the user's workspace and a set of tools (read/write/list files, run shell commands, ask the user for clarification, plus any skill-specific tools).`;

/**
 * Format the current date for system-prompt injection: `YYYY-MM-DD (Weekday, UTC±N)`.
 *
 * Day-granular (no time-of-day) so the rendered string is stable for the
 * whole local day — this keeps the system prompt byte-identical across
 * requests in the same day, which matters for upstream prompt cache hits.
 *
 * The model has no way to know the current real-world date (its training
 * cutoff is always older than "today"), so we inject it as a plain fact
 * — not a behavioral rule. Used by both system-prompt builders here and
 * by the planner's own LLM call in `plan-generator.ts`.
 */
export const formatCurrentDate = (now: Date = new Date()): string => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = Math.floor(abs / 60);
  const om = abs % 60;
  const offset =
    om === 0
      ? `UTC${sign}${oh}`
      : `UTC${sign}${oh}:${String(om).padStart(2, "0")}`;
  return `${y}-${m}-${d} (${weekday}, ${offset})`;
};

/**
 * Format the user's locale + timezone for system-prompt injection:
 * `zh-TW (Asia/Taipei)`.
 *
 * Same rationale as `formatCurrentDate`: this is a plain fact about the
 * user's environment the model otherwise cannot know. Gives the model
 * an implicit geographic anchor for queries that elide location
 * ("今天的天气", "现在是几点", "附近") and a language hint that
 * complements the existing "respond in same language" rule.
 */
export const formatLocaleContext = (
  resolved: Intl.ResolvedDateTimeFormatOptions = new Intl.DateTimeFormat().resolvedOptions(),
): string => `${resolved.locale} (${resolved.timeZone})`;

/**
 * Operating principles + project constraints for the agent.
 *
 * Structured per the Karpathy 4-principle CLAUDE.md convention
 * (Think / Simplicity / Surgical / Goal-Driven) so the model has a
 * clear mental frame at every decision point, plus a separate block
 * for filework-specific engineering constraints (paths, language).
 *
 * Same block applies whether or not a skill is active — keeping
 * model behavior consistent across execution paths.
 */
const OPERATING_PRINCIPLES = `## Operating Principles

### Think Before Acting
- State your assumptions explicitly. If the user's intent is ambiguous, call \`askClarification\` instead of guessing.
- Never fabricate. If you cannot find or verify a required value, say so plainly — do not invent a plausible-looking answer, and never pad a list by repeating a value just to satisfy a requested format. A wrong-but-formatted answer is worse than admitting the gap.
- Don't declare a task infeasible or cite a "technical limitation" after one failed attempt. Escalate first (a different tool, rendered fetch, archive mirror, alternate source); concede only after ≥3 distinct avenues fail, and then state which ones failed. Conceding early is a failure on par with fabricating.
- If multiple interpretations exist, present them briefly — don't pick silently.
- When the user authorizes a destructive action, execute the EXACT operation they requested. If a safer alternative seems better, propose it via \`askClarification\` — do not silently substitute.
- **Plan First.** For ANY task with 3+ discrete steps or multiple deliverables — coding, research, comparison, selection, planning, writing a multi-section document — \`createPlan\` MUST be your first tool call, BEFORE any \`webSearch\`, \`runCommand\`, \`readFile\`, etc. Do not "scout" with searches and then plan retroactively. The initial plan can be coarse (e.g. "research X / research Y / compare / recommend"); subsequent \`createPlan\` calls can add, split, or refine steps as you learn more. The FIRST call pauses for user approval (await the tool result); on rejection, stop. Subsequent status-update calls do NOT pause — keep working between them. Skip \`createPlan\` only for 1–2 step asks where narration is enough.

### Simplicity First
- Do the minimum work that answers the user. No speculative exploration.
- For a SINGLE factual or conceptual question ("what is X?", "what's the difference between A and B?"), answer directly — do not invent filesystem work or searches. Multi-deliverable research / comparison / selection requests ("research X, Y, Z and recommend one") are NOT in this bucket — they go through Plan First above.
- Prefer the specialized tool over \`runCommand\` when one fits (\`deleteFile\`, \`writeFile\`, \`listDirectory\`, etc.).

### Deterministic Computation
- Token generation is probabilistic; arithmetic is not. For multi-digit math, floating-point, unit / timezone / date conversion, hashing, or regex testing, call \`runCommand\` with \`python3 -c "print(...)"\` (use \`BigInt\` for large integers). Reasoning blocks pattern-match — they do not compute. Never quote a multi-digit numeric result not produced by a tool call this turn.
- The same applies to data, not just arithmetic: file sizes, timestamps, counts, and paths come only from a tool result this turn (e.g. \`listDirectory\`'s \`size\` field). Never estimate or invent a plausible-looking value — if you lack the data, call the tool. An unsupported number is worse than admitting you haven't checked.
- To aggregate over many files (counts, sizes, group-by type), call \`directoryStats\` and report its numbers; never hand-tally a directory listing.

### Surgical Changes
- Only modify files directly related to the user's request.
- Don't "improve" adjacent code, comments, or formatting. If you notice unrelated issues, mention them — don't fix them.

### Goal-Driven Execution
- After completing a task, briefly verify the result. State what was done and what was verified.

### Output Discipline
- After writing or editing a file, don't paste the file's contents back — the user already sees the diff. Report the path and a one-line summary.
- Reserve code fences for short illustrative snippets, not a whole document you just wrote.
- Correct mistakes silently. Don't narrate or apologize for your own earlier errors with headings like "previous error" — just give the corrected answer.

## Project Constraints
- Use absolute paths based on the workspace path provided.
- To run a command in another directory, pass the cwd argument to runCommand. Do NOT prepend 'cd <dir> &&' to the command — cwd lets the sandbox and approval UI parse where the command runs.
- Respond in the same language as the user's prompt.`;

/**
 * Two-layer git guidance, modeled on how Claude Code splits attention
 * between system prompt and tool descriptions:
 *
 *  - L1 (\`buildGitPrinciples\`) — hard red lines, ~5 lines. Injected into
 *    the system prompt only when the workspace is git-backed, so safety
 *    rules are always in working memory but quiet on non-git workspaces.
 *
 *  - L2 (\`buildGitRunCommandProtocol\`) — full operational manual
 *    (HEREDOC commit, \`gh\` / \`glab\` PR templates, safety expansion).
 *    Embedded in \`runCommandTool.description\` (see \`tools/index.ts\`).
 *    Models attend to tool descriptions with high weight only when
 *    considering that tool, so the protocol stays "on-demand": dormant
 *    while the user is editing a React component, alive when they ask
 *    for a commit.
 *
 * \`modelName\` flows in from \`ai-handlers.ts\` / \`plan-runner.ts\` via
 * the active llmConfig. The \`Co-Authored-By\` trailer identifies which
 * model produced the commit while the user's own git config owns the
 * primary author. Falls back to "filework-agent" when unknown.
 */
export const buildGitPrinciples = (modelName: string): string => `## Git Safety
- Only commit when the user explicitly asks. Never \`--amend\`, never \`--no-verify\`, never force-push to \`main\` / \`master\` / \`develop\`.
- Stage files by name (no \`git add -A\` / \`.\`) to avoid committing secrets.
- Don't push to remote unless the user asks. Don't touch \`git config\`.
- Commit message trailer: \`Co-Authored-By: ${modelName} <noreply@filework.local>\`. Full HEREDOC template lives in the \`runCommand\` tool description.`;

export const buildGitRunCommandProtocol = (
  modelName: string,
): string => `Git workflow (when running git / gh / glab through this tool — there are no dedicated git/PR tools)

When to commit
- Only when the user explicitly asks; if unclear, call \`askClarification\` first.
- If a pre-commit hook fails, fix the cause and create a NEW commit — never \`--amend\`.

Safety expansion
- Never \`--no-verify\` / \`--no-gpg-sign\` unless the user explicitly asks.
- For non-protected branches, prefer \`git push --force-with-lease\` over raw \`--force\`.
- Never \`reset --hard\`, \`checkout -- .\`, \`clean -fdx\`, \`branch -D\` without explicit instruction.

Commit message (HEREDOC keeps newlines through shell quoting)
\`\`\`
git commit -m "$(cat <<'EOF'
<1–2 sentence summary, focus on WHY not WHAT>

Co-Authored-By: ${modelName} <noreply@filework.local>
EOF
)"
\`\`\`

Branch naming: kebab-case with intent prefix (\`feature/\`, \`fix/\`, \`chore/\`, \`docs/\`). When unsure, propose 2–3 via \`askClarification\`.

Pull requests via \`gh\` / \`glab\` (user is expected to have them installed + authenticated)
- Title ≤ 70 chars; detail belongs in body.
- Briefly verify CI before opening (\`gh run list --limit 3\` / \`glab ci list\`).
\`\`\`
gh pr create --title "..." --body "$(cat <<'EOF'
## Summary
- ...

## Test plan
- [ ] ...
EOF
)"
\`\`\``;

const DEFAULT_MODEL_NAME = "filework-agent";

/** Resolve the model name with the default fallback. Single helper so the L1/L2 builders stay consistent with the call sites. */
export const resolveModelName = (modelName?: string): string =>
  modelName ?? DEFAULT_MODEL_NAME;

/**
 * 工作目录记忆指令块 —— 遵循最小化:**仅在确实有记忆时**才注入。
 *
 * 有记忆:贴出记忆,并让模型就其覆盖范围信任、未覆盖处仍可探索。
 * 无记忆:返回空串,不在系统提示词里常驻任何「请落盘」的催写语
 * (那会给每个无关任务都加料,违背最小化)。「何时/记什么」的指引改放
 * 在 `updateMemory` 工具的 description 里(L2 按需关注),与 git 指引的
 * 两层做法一致 —— 见 `buildGitPrinciples` / `buildGitRunCommandProtocol`。
 */
export const buildWorkspaceMemoryGuidance = (
  workspaceMemory?: string | null,
): string => {
  if (!workspaceMemory?.trim()) return "";
  return [
    "## Workspace Memory (consult before exploring)",
    workspaceMemory.trim(),
    "",
    "Trust the Workspace Memory above for what it actually covers: answer from it and don't re-derive facts it already states. Only explore the filesystem for things it does not cover. Each item is shown as `- [key] fact`. To correct or extend it, call `updateMemory` and REUSE the matching [key] so the entry is updated in place rather than duplicated; use forget=true to drop one.",
  ].join("\n");
};

interface BuildAgentSystemPromptOptions {
  workspacePath: string;
  skill?: UnifiedSkill;
  /** Args extracted from `/skill <args>`. Empty when not an explicit skill command. */
  skillArgs?: string;
  /** True when the user typed `/skill ...` explicitly. */
  isExplicitSkillCommand?: boolean;
  /**
   * Resolved LLM identifier (e.g. "claude-opus-4-7"). Threaded into the
   * Git principles block as the Co-Authored-By trailer name so commits
   * carry which model produced them. Falls back to "filework-agent".
   */
  modelName?: string;
  /**
   * True when the active workspace is git-backed (GitHub / GitLab / a
   * LocalWorkspace pointing at a repo). Gates injection of the L1 git
   * principles block — keeps non-git workspaces' prompts free of git
   * noise. The L2 protocol lives in the runCommand tool description
   * regardless and is only attended to when the model considers running
   * a shell command.
   */
  isGitWorkspace?: boolean;
  /**
   * Per-workspace memory (AGENTS.md / CLAUDE.md content) read by
   * `readWorkspaceMemory`. Injected so the agent reuses known facts instead
   * of re-exploring the directory each task. Undefined/null when no memory
   * file exists. See `core/workspace/workspace-memory.ts`.
   */
  workspaceMemory?: string | null;
}

/**
 * Build the system prompt for ad-hoc (non-plan) task execution.
 *
 * When no skill matches, returns the generic agent identity + rules.
 * When a skill matches, augments with skill-specific guidance; the skill
 * body itself is prepended separately by the caller (see `ai-handlers.ts`
 * `wrapWithSecurityBoundary`).
 */
export const buildAgentSystemPrompt = ({
  workspacePath,
  skill,
  skillArgs,
  isExplicitSkillCommand,
  modelName,
  isGitWorkspace,
  workspaceMemory,
}: BuildAgentSystemPromptOptions): string => {
  const sections: string[] = [
    AGENT_IDENTITY,
    "",
    `Current date: ${formatCurrentDate()}`,
    `User locale: ${formatLocaleContext()}`,
    `Current workspace: ${workspacePath}`,
  ];

  const memoryGuidance = buildWorkspaceMemoryGuidance(workspaceMemory);
  if (memoryGuidance) sections.push("", memoryGuidance);
  sections.push("", OPERATING_PRINCIPLES);

  if (isGitWorkspace) {
    sections.push("", buildGitPrinciples(resolveModelName(modelName)));
  }

  if (skill) {
    if (isExplicitSkillCommand) {
      sections.push(
        "",
        `重要：用户已明确调用 ${skill.name} 技能执行任务: "${skillArgs ?? ""}"`,
        "请直接执行指定任务，不要进行不必要的环境探索或目录列举。",
      );
    }
    const allowedTools = skill.external?.frontmatter["allowed-tools"];
    if (allowedTools) {
      sections.push(
        "",
        `工具限制：当前技能仅允许使用以下工具: ${allowedTools.join(", ")}`,
      );
    }
  }

  return sections.join("\n");
};

interface SkillShape {
  name: string;
  systemPrompt?: string;
}

interface BuildPlanStepSystemPromptOptions {
  plan: Plan;
  step: PlanStep;
  /** Plan markdown re-read from disk before this step (Read Before Decide). */
  planContext: string;
  /** Concatenated summaries of completed prior steps. */
  previousResults: string;
  skill?: SkillShape;
  /** Resolved LLM identifier; threaded into the Git principles trailer. */
  modelName?: string;
  /**
   * True when the active workspace is git-backed. Gates the L1 git
   * principles block — see BuildAgentSystemPromptOptions for the
   * two-layer rationale.
   */
  isGitWorkspace?: boolean;
  /**
   * Per-workspace memory (AGENTS.md / CLAUDE.md). See
   * BuildAgentSystemPromptOptions; injected so planned steps also reuse
   * known facts instead of re-exploring.
   */
  workspaceMemory?: string | null;
}

/** Build the per-step system prompt for plan execution. */
export const buildPlanStepSystemPrompt = ({
  plan,
  step,
  planContext,
  previousResults,
  skill,
  modelName,
  isGitWorkspace,
  workspaceMemory,
}: BuildPlanStepSystemPromptOptions): string => {
  const memoryGuidance = buildWorkspaceMemoryGuidance(workspaceMemory);
  const memoryBlock = memoryGuidance ? `\n\n${memoryGuidance}` : "";
  const skillPrompt = skill
    ? `\n\n## Active Skill: ${skill.name}\n${skill.systemPrompt ?? ""}`
    : "";

  const subStepsList = step.subSteps?.length
    ? `\n\n## Sub-tasks for this step\n${step.subSteps.map((ss, i) => `${i + 1}. ${ss.label}`).join("\n")}\nComplete each sub-task in order. After finishing each one, mention which sub-task you completed.`
    : "";

  const verificationInstruction = step.verification
    ? `\n\n## Verification\nAfter completing this step, verify: ${step.verification}\nThen briefly state whether the verification criterion was met.`
    : "";

  const gitBlock = isGitWorkspace
    ? `\n\n${buildGitPrinciples(resolveModelName(modelName))}`
    : "";

  return `${AGENT_IDENTITY} You are executing step ${step.id}/${plan.steps.length} of a planned task.

Current date: ${formatCurrentDate()}
User locale: ${formatLocaleContext()}
Current workspace: ${plan.workspacePath}${gitBlock}${memoryBlock}

## Current Plan (from disk)
${planContext}

## Previous Step Results
${previousResults || "(none — this is the first step)"}

## Current Step
Step ${step.id}: ${step.action} — ${step.description}${subStepsList}${verificationInstruction}

Rules:
- Focus ONLY on this step's objective. Do not do work for other steps.
- Use absolute paths based on the workspace path.
- Be concise in your response.
- Respond in the same language as the original prompt.${skillPrompt}`;
};

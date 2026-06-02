/**
 * AgentLoop 的系统提示词构建器。
 *
 * 这里有两个提示词:
 *  - `buildAgentSystemPrompt` —— 用于即时任务的通用 Agent 提示词
 *    (由 `ai-handlers.ts:handleTaskExecution` 调用)
 *  - `buildPlanStepSystemPrompt` —— 用于计划执行的单步提示词
 *    (由 `plan-runner.ts` 调用)
 *
 * 默认领域中立:提示词不假定文件管理身份,因此概念性 / 分析性问题
 * ("compare X and Y")不再被偏向于文件系统操作。当匹配到某个技能
 * (显式 `/skill foo` 或关键词)时,由技能正文承载领域上下文
 * (技能自身决定如何处理文件 / 网络 / shell)。
 */

import type { UnifiedSkill } from "../skills-runtime/types";
import type { Plan, PlanStep } from "./plan-types";

const AGENT_IDENTITY = `You are a general-purpose AI Agent operating with full access to the user's workspace and a set of tools (read/write/list files, run shell commands, ask the user for clarification, plus any skill-specific tools).`;

/**
 * 格式化用于系统提示词注入的当前日期:`YYYY-MM-DD (Weekday, UTC±N)`。
 *
 * 以天为粒度(不含具体时刻),使渲染出的字符串在整个本地自然日内保持稳定
 * —— 这让系统提示词在同一天内的各次请求中字节一致,对命中上游的提示词
 * 缓存很重要。
 *
 * 模型无从知晓当前真实世界日期(其训练截止时间总是早于「今天」),因此
 * 我们将其作为纯粹的事实注入 —— 而非行为规则。本文件的两个系统提示词
 * 构建器以及 `plan-generator.ts` 中规划器自身的 LLM 调用都会使用它。
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
 * 格式化用于系统提示词注入的用户区域设置 + 时区:
 * `zh-TW (Asia/Taipei)`。
 *
 * 与 `formatCurrentDate` 同理:这是关于用户环境的纯粹事实,模型本无从知晓。
 * 它为省略了位置的查询("今天的天气"、"现在是几点"、"附近")提供隐式的
 * 地理锚点,并给出语言提示,与既有的「用相同语言回复」规则相辅相成。
 */
export const formatLocaleContext = (
  resolved: Intl.ResolvedDateTimeFormatOptions = new Intl.DateTimeFormat().resolvedOptions(),
): string => `${resolved.locale} (${resolved.timeZone})`;

/**
 * Agent 的操作原则 + 项目约束。
 *
 * 按 Karpathy 的 4 原则 CLAUDE.md 范式组织
 * (Think / Simplicity / Surgical / Goal-Driven),使模型在每个决策点都有
 * 清晰的心智框架;另加一个独立区块,承载 filework 特有的工程约束
 * (路径、语言)。
 *
 * 无论是否激活技能都适用同一区块 —— 保持模型行为在各执行路径上一致。
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
 * 两层 git 指引,借鉴 Claude Code 在系统提示词与工具描述之间分配注意力的方式:
 *
 *  - L1 (\`buildGitPrinciples\`) —— 硬性红线,约 5 行。仅当工作目录由 git
 *    托管时才注入系统提示词,使安全规则始终在工作记忆中,但在非 git
 *    工作目录下保持安静。
 *
 *  - L2 (\`buildGitRunCommandProtocol\`) —— 完整操作手册
 *    (HEREDOC 提交、\`gh\` / \`glab\` PR 模板、安全扩展)。
 *    嵌入在 \`runCommandTool.description\` 中(见 \`tools/index.ts\`)。
 *    模型仅在考虑某个工具时才以高权重关注其描述,因此该协议保持「按需」:
 *    用户编辑 React 组件时它处于休眠,用户请求提交时它才被激活。
 *
 * \`modelName\` 通过当前 llmConfig 从 \`ai-handlers.ts\` / \`plan-runner.ts\`
 * 传入。\`Co-Authored-By\` 尾注标识由哪个模型产出该提交,而主作者仍归
 * 用户自己的 git config 所有。未知时回退为 "filework-agent"。
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

/** 解析模型名称并带默认回退。单一辅助函数,使 L1/L2 构建器与调用处保持一致。 */
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
  /** 从 `/skill <args>` 中提取的参数。非显式技能命令时为空。 */
  skillArgs?: string;
  /** 用户显式输入 `/skill ...` 时为 true。 */
  isExplicitSkillCommand?: boolean;
  /**
   * 解析后的 LLM 标识符(如 "claude-opus-4-7")。作为 Co-Authored-By 尾注
   * 名称穿入 Git 原则区块,使提交携带由哪个模型产出的信息。
   * 回退为 "filework-agent"。
   */
  modelName?: string;
  /**
   * 当前工作目录由 git 托管(GitHub / GitLab / 指向某仓库的
   * LocalWorkspace)时为 true。控制是否注入 L1 git 原则区块 —— 使非 git
   * 工作目录的提示词不带 git 噪声。L2 协议无论如何都驻留在 runCommand
   * 工具描述中,仅在模型考虑运行 shell 命令时才被关注。
   */
  isGitWorkspace?: boolean;
  /**
   * 由 `readWorkspaceMemory` 读取的每工作目录记忆(AGENTS.md / CLAUDE.md
   * 内容)。注入后使 agent 复用已知事实,而非每次任务都重新探索目录。
   * 无记忆文件时为 undefined/null。见 `core/workspace/workspace-memory.ts`。
   */
  workspaceMemory?: string | null;
}

/**
 * 构建用于即时(非计划)任务执行的系统提示词。
 *
 * 无技能匹配时,返回通用 agent 身份 + 规则。
 * 有技能匹配时,补充技能专属指引;技能正文本身由调用方单独前置
 * (见 `ai-handlers.ts` 的 `wrapWithSecurityBoundary`)。
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
  /** 本步骤前从磁盘重新读取的计划 markdown(Read Before Decide)。 */
  planContext: string;
  /** 已完成的先前步骤摘要的拼接。 */
  previousResults: string;
  skill?: SkillShape;
  /** 解析后的 LLM 标识符;穿入 Git 原则尾注。 */
  modelName?: string;
  /**
   * 当前工作目录由 git 托管时为 true。控制 L1 git 原则区块 ——
   * 两层机制的原理见 BuildAgentSystemPromptOptions。
   */
  isGitWorkspace?: boolean;
  /**
   * 每工作目录记忆(AGENTS.md / CLAUDE.md)。见
   * BuildAgentSystemPromptOptions;注入后使计划步骤也复用已知事实,
   * 而非重新探索。
   */
  workspaceMemory?: string | null;
}

/** 构建用于计划执行的单步系统提示词。 */
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

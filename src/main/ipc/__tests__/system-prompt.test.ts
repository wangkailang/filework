import { describe, expect, it } from "vitest";

import type { Plan, PlanStep } from "../plan-types";
import {
  buildAgentSystemPrompt,
  buildGitPrinciples,
  buildGitRunCommandProtocol,
  buildPlanStepSystemPrompt,
  formatCurrentDate,
  formatLocaleContext,
} from "../system-prompt";

const WORKSPACE = "/Users/me/workspace";

describe("formatCurrentDate", () => {
  it("renders YYYY-MM-DD (Weekday, UTC±N) for a fixed date", () => {
    // 2026-05-19 是星期二。
    const fixed = new Date(2026, 4, 19, 10, 0, 0); // 本地时间
    const out = formatCurrentDate(fixed);
    expect(out).toMatch(/^2026-05-19 \(Tuesday, UTC[+-]\d{1,2}(?::\d{2})?\)$/);
  });

  it("uses day granularity — same string for any time-of-day on the same date", () => {
    const morning = new Date(2026, 4, 19, 0, 0, 0);
    const evening = new Date(2026, 4, 19, 23, 59, 59);
    expect(formatCurrentDate(morning)).toBe(formatCurrentDate(evening));
  });
});

describe("formatLocaleContext", () => {
  it("renders `<locale> (<timeZone>)` from resolved options", () => {
    const resolved = {
      locale: "zh-TW",
      timeZone: "Asia/Taipei",
      // 其余字段 formatLocaleContext 不使用,但类型要求必须提供
      calendar: "gregory",
      numberingSystem: "latn",
    } as unknown as Intl.ResolvedDateTimeFormatOptions;
    expect(formatLocaleContext(resolved)).toBe("zh-TW (Asia/Taipei)");
  });

  it("default invocation returns a non-empty `<locale> (<tz>)` string from the host runtime", () => {
    expect(formatLocaleContext()).toMatch(/^[A-Za-z-]+ \(.+\)$/);
  });
});

describe("buildGitPrinciples / buildGitRunCommandProtocol", () => {
  it("L1 principles are short (≤ 12 lines) and contain hard red-lines + trailer", () => {
    const out = buildGitPrinciples("claude-opus-4-7");
    expect(out.split("\n").length).toBeLessThanOrEqual(12);
    expect(out).toContain("## Git Safety");
    expect(out).toMatch(/--amend/);
    expect(out).toMatch(/--no-verify/);
    expect(out).toMatch(/force-push/);
    expect(out).toContain(
      "Co-Authored-By: claude-opus-4-7 <noreply@filework.local>",
    );
  });

  it("L2 protocol carries the operational manual the L1 block deliberately omits", () => {
    const out = buildGitRunCommandProtocol("claude-opus-4-7");
    expect(out).toMatch(/HEREDOC/);
    expect(out).toMatch(/git commit -m/);
    expect(out).toMatch(/gh pr create/);
    expect(out).toMatch(/glab/);
    expect(out).toContain(
      "Co-Authored-By: claude-opus-4-7 <noreply@filework.local>",
    );
  });

  it("L1 and L2 trailers stay in sync — same modelName flows through both", () => {
    const model = "test-model";
    expect(buildGitPrinciples(model)).toContain(`<noreply@filework.local>`);
    expect(buildGitPrinciples(model)).toContain(model);
    expect(buildGitRunCommandProtocol(model)).toContain(model);
  });
});

describe("buildAgentSystemPrompt", () => {
  it("default prompt is domain-neutral (no FileWork file-management identity)", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("general-purpose AI Agent");
    expect(prompt).toContain(WORKSPACE);
    expect(prompt).not.toContain("FileWork");
    expect(prompt).not.toContain("local file management");
  });

  it("default prompt mentions analytical-question guidance", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(/analytical|conceptual|research/i);
    expect(prompt).toContain("askClarification");
  });

  it("default prompt requires Plan First for multi-step / multi-deliverable tasks", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    // Plan First 规则必须提到 createPlan,并要求它先于其它工具调用 ——
    // 这里若回归,意味着模型可以在亮出计划前自由地用 webSearch/runCommand
    // 探路,从而绕过 agent-tools.ts createPlanTool 中的草稿审批门控。
    expect(prompt).toMatch(/plan first/i);
    expect(prompt).toContain("createPlan");
    // 必须要求 createPlan 先于其它工具调用(并具体列出
    // webSearch/runCommand 等)。锚定 "BEFORE any" + 工具名,这样若被
    // 改写得更弱、丢掉了「先于」要求,测试就会失败。
    expect(prompt).toMatch(/BEFORE any[^.]*webSearch/);
    expect(prompt).toMatch(/retroactively/i);
  });

  it("default prompt includes the Karpathy operating principles + deterministic-computation rule", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("Operating Principles");
    expect(prompt).toContain("Agent Identity");
    expect(prompt).toContain("Think Before Acting");
    expect(prompt).toContain("Simplicity First");
    expect(prompt).toContain("Privacy and Safety Boundaries");
    expect(prompt).toContain("Tone and Output Style");
    expect(prompt).toContain("Deterministic Computation");
    expect(prompt).toContain("Surgical Changes");
    expect(prompt).toContain("Goal-Driven Execution");
  });

  it("default prompt defines Workspace Agent identity without inheriting vendor/model claims", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("Workspace Agent");
    expect(prompt).toContain("local-first");
    expect(prompt).not.toMatch(/Claude Fable|Mythos|Anthropic's products/);
  });

  it("default prompt prioritizes user-provided artifacts and current verification", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(/artifact|URL|file/i);
    expect(prompt).toMatch(/primary source/i);
    expect(prompt).toMatch(/current|recent|latest/i);
  });

  it("default prompt includes privacy and safety boundaries for local workspace work", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(/Never log or transmit file contents/i);
    expect(prompt).toMatch(/API keys|secrets|credentials/i);
    expect(prompt).toMatch(/medical|legal|financial/i);
  });

  it("default prompt treats external content as data, not instructions", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("External Content Boundary");
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toMatch(/ignore.*system prompt|bypass.*approval/i);
  });

  it("default prompt includes compact tool choice and mistake-handling guidance", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("Tool Choice");
    expect(prompt).toMatch(/structured parser|database query/i);
    expect(prompt).toMatch(/Acknowledge mistakes briefly/i);
  });

  it("default prompt routes reminders and recurring follow-ups through automation_update", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("automation_update");
    expect(prompt).toMatch(/reminders|scheduled checks|recurring monitors/i);
    expect(prompt).toMatch(/thread automations/i);
    expect(prompt).toMatch(/standalone\/project automations/i);
  });

  it("default prompt respects explicit stop/completion cues", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(/stop|pause|leave it there/i);
    expect(prompt).toMatch(/do not keep asking/i);
  });

  it("default prompt keeps formatting and tone concise", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(/same language/i);
    expect(prompt).toMatch(/minimal formatting/i);
    expect(prompt).toMatch(/one question/i);
  });

  it("default prompt remains compact after supplemental policy additions", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt.length).toBeLessThan(8500);
  });

  it("deterministic-computation rule names a code-execution path and forbids in-prose math", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    // 必须把模型引向 runCommand(锚定工具名,这样若被泛化改写、丢掉了
    // 可执行的指令,测试就会失败)
    expect(prompt).toContain("runCommand");
    // 必须至少提到一个具体的解释器,让模型有现成可用的调用范式
    expect(prompt).toMatch(/python3 -c|node -e/);
    // 必须提到 BigInt —— 否则大于 2^53 的整数在 node 中会悄无声息地丢失
    // 精度,而这正是本规则要防止的失败模式
    expect(prompt).toContain("BigInt");
    // 必须堵死「我直接推理就行」这个逃生口
    expect(prompt).toMatch(/reasoning/i);
  });

  it("default prompt separates project constraints from behavioral principles", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("Project Constraints");
    expect(prompt).toMatch(/absolute paths/i);
    expect(prompt).toMatch(/same language/i);
  });

  it("default prompt injects 'Current date:' with date + weekday + UTC offset", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(
      /Current date: \d{4}-\d{2}-\d{2} \([A-Z][a-z]+day, UTC[+-]\d/,
    );
  });

  it("default prompt injects 'User locale:' with locale + timezone", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toMatch(/User locale: [A-Za-z-]+ \(.+\)/);
  });

  it("explicit skill command surfaces skill name and skipping-exploration hint", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      skill: { id: "demo", name: "Demo" } as never,
      skillArgs: "do the thing",
      isExplicitSkillCommand: true,
    });
    expect(prompt).toContain("Demo");
    expect(prompt).toContain("do the thing");
    expect(prompt).toContain("不要进行不必要的环境探索");
  });

  it("operating principles apply whether or not a skill is active", () => {
    const withoutSkill = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    const withSkill = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      skill: { id: "demo", name: "Demo" } as never,
      isExplicitSkillCommand: true,
    });
    for (const heading of [
      "Think Before Acting",
      "Simplicity First",
      "Deterministic Computation",
      "Surgical Changes",
      "Goal-Driven Execution",
    ]) {
      expect(withoutSkill).toContain(heading);
      expect(withSkill).toContain(heading);
    }
  });

  it("git principles are absent when isGitWorkspace is not set", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).not.toMatch(/Git Safety/);
    expect(prompt).not.toMatch(/Co-Authored-By/);
  });

  it("omits the Workspace Memory section entirely when there is no memory (minimal prompt)", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    // 不再有常驻的 memory 区块 / 抓取提醒 —— 抓取指引改放在 updateMemory
    // 工具的描述里(L2),从而保持基础提示词精简。
    expect(prompt).not.toContain("## Workspace Memory");
    expect(prompt).not.toContain("updateMemory");
  });

  it("with memory present, injects it and tells the agent to trust it", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      workspaceMemory: "- package manager: pnpm\n- tests live in __tests__",
    });
    expect(prompt).toContain("## Workspace Memory");
    expect(prompt).toContain("package manager: pnpm");
    expect(prompt).toMatch(/Trust the Workspace Memory above/);
  });

  it("treats blank/whitespace-only memory as absent (no section injected)", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      workspaceMemory: "   \n  ",
    });
    expect(prompt).not.toContain("## Workspace Memory");
  });

  it("git principles are absent when isGitWorkspace is false", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      isGitWorkspace: false,
    });
    expect(prompt).not.toMatch(/Git Safety/);
  });

  it("git principles (L1) appear when isGitWorkspace is true; full protocol (L2) does NOT", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      isGitWorkspace: true,
      modelName: "claude-opus-4-7",
    });
    expect(prompt).toContain("## Git Safety");
    expect(prompt).toContain(
      "Co-Authored-By: claude-opus-4-7 <noreply@filework.local>",
    );
    // L2 手册位于 runCommand 工具描述中,而非这里 —— 系统提示词本身
    // 不应出现真正的 HEREDOC 模板或 `gh pr create`。(L1 可以在文字里
    // 引用 HEREDOC 以指向模板所在位置 —— 这是有意为之的。)
    expect(prompt).not.toMatch(/git commit -m "\$\(cat <<'EOF'/);
    expect(prompt).not.toMatch(/gh pr create/);
  });

  it("allowed-tools restriction is announced when skill restricts tools", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      skill: {
        id: "x",
        name: "X",
        external: {
          frontmatter: { "allowed-tools": ["readFile", "listDirectory"] },
        },
      } as never,
    });
    expect(prompt).toContain("readFile, listDirectory");
    expect(prompt).toContain("工具限制");
  });
});

describe("buildPlanStepSystemPrompt", () => {
  const plan: Plan = {
    id: "p1",
    prompt: "do X",
    goal: "G",
    steps: [
      { id: 1, action: "scan", description: "scan dir", status: "pending" },
      {
        id: 2,
        action: "report",
        description: "write report",
        status: "pending",
      },
    ],
    status: "executing",
    workspacePath: WORKSPACE,
    createdAt: "2026-05-09T22:00:00.000Z",
    updatedAt: "2026-05-09T22:00:00.000Z",
  };

  it("step prompt is domain-neutral, includes step context and workspace", () => {
    const step: PlanStep = plan.steps[0];
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "(plan markdown)",
      previousResults: "",
    });
    expect(prompt).toContain("general-purpose AI Agent");
    expect(prompt).not.toContain("FileWork");
    expect(prompt).toContain("step 1/2");
    expect(prompt).toContain(WORKSPACE);
    expect(prompt).toContain("(plan markdown)");
    expect(prompt).toContain("(none — this is the first step)");
  });

  it("step prompt injects 'Current date:' with date + weekday + UTC offset", () => {
    const step: PlanStep = plan.steps[0];
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
    });
    expect(prompt).toMatch(
      /Current date: \d{4}-\d{2}-\d{2} \([A-Z][a-z]+day, UTC[+-]\d/,
    );
  });

  it("step prompt injects 'User locale:' with locale + timezone", () => {
    const step: PlanStep = plan.steps[0];
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
    });
    expect(prompt).toMatch(/User locale: [A-Za-z-]+ \(.+\)/);
  });

  it("step prompt with sub-steps includes Sub-tasks block", () => {
    const step: PlanStep = {
      id: 1,
      action: "scan",
      description: "scan",
      status: "pending",
      subSteps: [
        { label: "list dir", status: "pending" },
        { label: "stat each file", status: "pending" },
      ],
    };
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
    });
    expect(prompt).toContain("## Sub-tasks for this step");
    expect(prompt).toContain("1. list dir");
    expect(prompt).toContain("2. stat each file");
  });

  it("step prompt with verification includes Verification block + closure line", () => {
    const step: PlanStep = {
      id: 1,
      action: "scan",
      description: "scan",
      status: "pending",
      verification: "directory has 10 files",
    };
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
    });
    expect(prompt).toContain("## Verification");
    expect(prompt).toContain("directory has 10 files");
    // Goal-Driven Execution:每个步骤的验证回路应以明确的通过/失败
    // 陈述收尾,而不是留给隐含判断。
    expect(prompt).toContain(
      "Then briefly state whether the verification criterion was met.",
    );
  });

  it("step prompt omits Git Safety when isGitWorkspace is not set", () => {
    const step: PlanStep = plan.steps[0];
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
    });
    expect(prompt).not.toMatch(/Git Safety/);
  });

  it("step prompt injects Git Safety (L1 only) when isGitWorkspace is true", () => {
    const step: PlanStep = plan.steps[0];
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
      isGitWorkspace: true,
      modelName: "claude-opus-4-7",
    });
    expect(prompt).toContain("## Git Safety");
    expect(prompt).toContain("Co-Authored-By: claude-opus-4-7");
    expect(prompt).not.toMatch(/gh pr create/);
  });

  it("step prompt with skill appends Active Skill block", () => {
    const step: PlanStep = plan.steps[0];
    const prompt = buildPlanStepSystemPrompt({
      plan,
      step,
      planContext: "",
      previousResults: "",
      skill: { name: "Report Gen", systemPrompt: "use markdown tables" },
    });
    expect(prompt).toContain("## Active Skill: Report Gen");
    expect(prompt).toContain("use markdown tables");
  });
});

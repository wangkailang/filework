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
    // 2026-05-19 was a Tuesday.
    const fixed = new Date(2026, 4, 19, 10, 0, 0); // local time
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
      // remaining fields not consumed by formatLocaleContext but required by the type
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
    // The Plan First rule must mention createPlan and require it BEFORE other
    // tool calls — a regression here means the model is free to scout with
    // webSearch/runCommand before surfacing the plan, defeating the draft
    // approval gate in agent-tools.ts createPlanTool.
    expect(prompt).toMatch(/plan first/i);
    expect(prompt).toContain("createPlan");
    // Must require createPlan precede other tool calls (concrete listing of
    // webSearch/runCommand etc.). Anchor on "BEFORE any" + a tool name so a
    // weaker rewrite that drops the precedence requirement breaks the test.
    expect(prompt).toMatch(/BEFORE any[^.]*webSearch/);
    expect(prompt).toMatch(/retroactively/i);
  });

  it("default prompt includes the Karpathy operating principles + deterministic-computation rule", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("Operating Principles");
    expect(prompt).toContain("Think Before Acting");
    expect(prompt).toContain("Simplicity First");
    expect(prompt).toContain("Deterministic Computation");
    expect(prompt).toContain("Surgical Changes");
    expect(prompt).toContain("Goal-Driven Execution");
  });

  it("deterministic-computation rule names a code-execution path and forbids in-prose math", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    // Must point the model to runCommand (anchor on the tool name so a
    // generic rewrite that drops the actionable instruction breaks the test)
    expect(prompt).toContain("runCommand");
    // Must mention at least one concrete interpreter so the model has a
    // ready-to-use invocation pattern
    expect(prompt).toMatch(/python3 -c|node -e/);
    // Must mention BigInt — without it, integers > 2^53 silently lose
    // precision in node, which is exactly the failure mode this rule exists
    // to prevent
    expect(prompt).toContain("BigInt");
    // Must rule out "I'll just reason about it" escape hatch
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
    // L2 manual lives in the runCommand tool description, NOT here —
    // we should not see the actual HEREDOC template or `gh pr create`
    // in the system prompt itself. (L1 may reference HEREDOC in prose
    // to point to where the template lives — that's intentional.)
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
    // Goal-Driven Execution: each step's verify loop should close with
    // an explicit pass/fail statement instead of being left implicit.
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

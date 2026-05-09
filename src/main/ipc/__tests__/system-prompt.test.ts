import { describe, expect, it } from "vitest";

import type { Plan, PlanStep } from "../plan-types";
import {
  buildAgentSystemPrompt,
  buildPlanStepSystemPrompt,
} from "../system-prompt";

const WORKSPACE = "/Users/me/workspace";

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

  it("default prompt includes behavioral guidelines when no skill is active", () => {
    const prompt = buildAgentSystemPrompt({ workspacePath: WORKSPACE });
    expect(prompt).toContain("Behavioral Guidelines");
    expect(prompt).toContain("Surgical Precision");
    expect(prompt).toContain("Verification");
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
    // Skill-active branch drops the generic Behavioral Guidelines block.
    expect(prompt).not.toContain("Behavioral Guidelines");
  });

  it("agent-browser skill triggers npx agent-browser hint", () => {
    const prompt = buildAgentSystemPrompt({
      workspacePath: WORKSPACE,
      skill: { id: "agent-browser", name: "Agent Browser" } as never,
      skillArgs: "open example.com",
      isExplicitSkillCommand: true,
    });
    expect(prompt).toContain("npx agent-browser");
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

  it("step prompt with verification includes Verification block", () => {
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

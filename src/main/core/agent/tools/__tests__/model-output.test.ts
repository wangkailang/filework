import { describe, expect, it } from "vitest";

import { readFileTool, runCommandTool } from "../index";

describe("high-noise tool model output projections", () => {
  it("projects readFile output to a bounded model-visible excerpt", async () => {
    const projected = await readFileTool.toModelOutput?.({
      toolCallId: "read-1",
      input: { path: "/workspace/large.log" },
      output: `${"line\n".repeat(20_000)}secret-tail`,
    });

    expect(projected).toMatchObject({ type: "text" });
    const value = (projected as { value: string }).value;
    expect(value).toContain("readFile /workspace/large.log");
    expect(value).toContain("Content:");
    expect(value).not.toContain("secret-tail");
    expect(value.length).toBeLessThan(7_000);
  });

  it("projects runCommand output to command metadata plus bounded streams", async () => {
    const tool = runCommandTool();
    const projected = await tool.toModelOutput?.({
      toolCallId: "cmd-1",
      input: {
        command: "pnpm test",
        runInBackground: false,
        escalatePermissions: false,
      },
      output: {
        exitCode: 1,
        stdout: `${"stdout line\n".repeat(5000)}stdout-tail`,
        stderr: `${"stderr line\n".repeat(5000)}stderr-tail`,
        success: false,
        commandKind: "test",
        testStats: { passed: 10, failed: 1 },
      },
    });

    expect(projected).toMatchObject({ type: "text" });
    const value = (projected as { value: string }).value;
    expect(value).toContain("runCommand pnpm test");
    expect(value).toContain("Exit code: 1");
    expect(value).toContain("Command kind: test");
    expect(value).toContain("Test stats:");
    expect(value).not.toContain("stdout-tail");
    expect(value).not.toContain("stderr-tail");
    expect(value.length).toBeLessThan(9_000);
  });
});

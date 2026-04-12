import { describe, expect, it } from "vitest";

import { preprocessSkill } from "../preprocessor";

// ─── $ARGUMENTS replacement ─────────────────────────────────────────

describe("preprocessSkill — $ARGUMENTS replacement", () => {
  it("replaces $ARGUMENTS with the full argument string", async () => {
    const result = await preprocessSkill(
      "Review: $ARGUMENTS",
      "file1.ts file2.ts",
      "/workspace",
    );
    expect(result.systemPrompt).toBe("Review: file1.ts file2.ts");
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("replaces multiple $ARGUMENTS occurrences", async () => {
    const result = await preprocessSkill(
      "$ARGUMENTS and also $ARGUMENTS",
      "hello",
      "/workspace",
    );
    expect(result.systemPrompt).toBe("hello and also hello");
  });

  it("replaces $ARGUMENTS with empty string when no args provided", async () => {
    const result = await preprocessSkill("Args: $ARGUMENTS", "", "/workspace");
    expect(result.systemPrompt).toBe("Args: ");
  });
});

// ─── $ARGUMENTS[N] / $N replacement ─────────────────────────────────

describe("preprocessSkill — indexed argument replacement", () => {
  it("replaces $ARGUMENTS[0] with the first argument", async () => {
    const result = await preprocessSkill(
      "File: $ARGUMENTS[0]",
      "main.ts utils.ts",
      "/workspace",
    );
    expect(result.systemPrompt).toBe("File: main.ts");
  });

  it("replaces $ARGUMENTS[1] with the second argument", async () => {
    const result = await preprocessSkill(
      "Second: $ARGUMENTS[1]",
      "main.ts utils.ts",
      "/workspace",
    );
    expect(result.systemPrompt).toBe("Second: utils.ts");
  });

  it("replaces $0 and $1 shorthand with corresponding arguments", async () => {
    const result = await preprocessSkill(
      "First: $0, Second: $1",
      "alpha beta",
      "/workspace",
    );
    expect(result.systemPrompt).toBe("First: alpha, Second: beta");
  });

  it("replaces out-of-bounds index with empty string and warns", async () => {
    const result = await preprocessSkill(
      "Missing: $ARGUMENTS[5]",
      "only-one",
      "/workspace",
    );
    expect(result.systemPrompt).toBe("Missing: ");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("out of bounds");
  });

  it("replaces out-of-bounds $N with empty string and warns", async () => {
    const result = await preprocessSkill("Missing: $3", "a b", "/workspace");
    expect(result.systemPrompt).toBe("Missing: ");
    expect(result.warnings.some((w) => w.includes("out of bounds"))).toBe(true);
  });
});

// ─── !command execution ──────────────────────────────────────────────

describe("preprocessSkill — !command execution", () => {
  it("replaces !echo with command output", async () => {
    const result = await preprocessSkill(
      "Output:\n!echo hello world",
      "",
      "/tmp",
    );
    expect(result.systemPrompt).toBe("Output:\nhello world");
    expect(result.warnings).toEqual([]);
  });

  it("replaces multiple !commands", async () => {
    const result = await preprocessSkill(
      "!echo first\n!echo second",
      "",
      "/tmp",
    );
    expect(result.systemPrompt).toBe("first\nsecond");
  });

  it("replaces failed command with error message", async () => {
    const result = await preprocessSkill(
      "!nonexistent-command-xyz-999",
      "",
      "/tmp",
    );
    expect(result.systemPrompt).toContain("[Error: command failed:");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("replaces timed-out command with timeout error", async () => {
    const result = await preprocessSkill("!sleep 30", "", "/tmp", {
      timeoutMs: 500,
    });
    expect(result.systemPrompt).toContain("[Error: command timed out after");
    expect(result.warnings.length).toBeGreaterThan(0);
  }, 10_000);

  it("blocks commands not allowed by security", async () => {
    const result = await preprocessSkill(
      "!curl https://example.com",
      "",
      "/tmp",
    );
    expect(result.systemPrompt).toBe("[Blocked: command not allowed]");
    expect(result.warnings.some((w) => w.includes("blocked"))).toBe(true);
  });

  it("blocks all commands for low trust level", async () => {
    const result = await preprocessSkill("!echo hello", "", "/tmp", {
      trustLevel: "low",
    });
    expect(result.systemPrompt).toBe("[Blocked: command not allowed]");
  });

  it("does not treat lines without leading ! as commands", async () => {
    const result = await preprocessSkill("This is not !a command", "", "/tmp");
    expect(result.systemPrompt).toBe("This is not !a command");
  });
});

// ─── Truncation ──────────────────────────────────────────────────────

describe("preprocessSkill — truncation", () => {
  it("does not truncate content within maxChars", async () => {
    const body = "a".repeat(100);
    const result = await preprocessSkill(body, "", "/tmp", { maxChars: 200 });
    expect(result.systemPrompt).toBe(body);
    expect(result.truncated).toBe(false);
  });

  it("truncates content exceeding maxChars and appends marker with sourcePath", async () => {
    const body = "x".repeat(500);
    const result = await preprocessSkill(body, "", "/tmp", {
      maxChars: 100,
      sourcePath: "/path/to/SKILL.md",
    });
    expect(result.truncated).toBe(true);
    expect(result.systemPrompt).toContain(
      "[...truncated, read full content from: /path/to/SKILL.md]",
    );
    // The content before the marker should be exactly maxChars
    const markerIndex = result.systemPrompt.indexOf("\n[...truncated");
    expect(markerIndex).toBe(100);
  });

  it("truncates without sourcePath using simple marker", async () => {
    const body = "y".repeat(500);
    const result = await preprocessSkill(body, "", "/tmp", {
      maxChars: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.systemPrompt).toContain("[...truncated]");
    expect(result.systemPrompt).not.toContain("read full content from");
  });

  it("uses default maxChars of 20000", async () => {
    const body = "z".repeat(20_001);
    const result = await preprocessSkill(body, "", "/tmp");
    expect(result.truncated).toBe(true);
  });

  it("does not truncate content at exactly maxChars", async () => {
    const body = "a".repeat(100);
    const result = await preprocessSkill(body, "", "/tmp", { maxChars: 100 });
    expect(result.truncated).toBe(false);
    expect(result.systemPrompt).toBe(body);
  });
});

// ─── Processing order ────────────────────────────────────────────────

describe("preprocessSkill — processing order", () => {
  it("processes $ARGUMENTS before !command so commands can use args", async () => {
    const result = await preprocessSkill("!echo $ARGUMENTS", "hello", "/tmp");
    // $ARGUMENTS is replaced first, then !echo hello is executed
    expect(result.systemPrompt).toBe("hello");
  });

  it("applies truncation after all other processing", async () => {
    const result = await preprocessSkill(
      `!echo ${"a".repeat(200)}`,
      "",
      "/tmp",
      { maxChars: 50, sourcePath: "/skill.md" },
    );
    expect(result.truncated).toBe(true);
    expect(result.systemPrompt).toContain("[...truncated");
  });
});

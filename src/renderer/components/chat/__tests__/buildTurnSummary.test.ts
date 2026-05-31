import { describe, expect, it } from "vitest";

import { buildTurnSummary } from "../buildTurnSummary";
import type { MessagePart, ToolPart } from "../types";

function tool(
  toolName: string,
  args: unknown,
  result: unknown,
  state: ToolPart["state"] = "output-available",
): ToolPart {
  return { type: "tool", toolCallId: "c-1", toolName, args, result, state };
}

describe("buildTurnSummary", () => {
  it("returns null for a pure Q&A turn (no tools)", () => {
    const parts: MessagePart[] = [{ type: "text", text: "hello" }];
    expect(buildTurnSummary(parts)).toBeNull();
  });

  it("returns null when only read-only tools ran", () => {
    const parts: MessagePart[] = [
      tool("readFile", { path: "a.ts" }, "contents"),
      tool("listDirectory", { path: "." }, { entries: [] }),
    ];
    expect(buildTurnSummary(parts)).toBeNull();
  });

  it("aggregates a created file with its diff stat", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "src/new.ts", content: "x" },
        {
          success: true,
          path: "src/new.ts",
          diffStat: {
            added: 10,
            removed: 0,
            isNew: true,
            isBinary: false,
            truncated: false,
          },
        },
      ),
    ];
    const sum = buildTurnSummary(parts);
    expect(sum).not.toBeNull();
    expect(sum?.files).toEqual([
      {
        path: "src/new.ts",
        op: "create",
        added: 10,
        removed: 0,
        writeCount: 1,
      },
    ]);
    expect(sum?.commands).toEqual([]);
  });

  it("merges two writes to the same path, summing +/- and counting writes", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "a.ts", content: "1" },
        {
          success: true,
          diffStat: {
            added: 3,
            removed: 1,
            isNew: false,
            isBinary: false,
            truncated: false,
          },
        },
      ),
      tool(
        "writeFile",
        { path: "a.ts", content: "2" },
        {
          success: true,
          diffStat: {
            added: 2,
            removed: 0,
            isNew: false,
            isBinary: false,
            truncated: false,
          },
        },
      ),
    ];
    const sum = buildTurnSummary(parts);
    expect(sum?.files).toEqual([
      { path: "a.ts", op: "modify", added: 5, removed: 1, writeCount: 2 },
    ]);
  });

  it("keeps create op when first write created the file", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "a.ts", content: "1" },
        {
          success: true,
          diffStat: {
            added: 2,
            removed: 0,
            isNew: true,
            isBinary: false,
            truncated: false,
          },
        },
      ),
      tool(
        "writeFile",
        { path: "a.ts", content: "2" },
        {
          success: true,
          diffStat: {
            added: 1,
            removed: 0,
            isNew: false,
            isBinary: false,
            truncated: false,
          },
        },
      ),
    ];
    expect(buildTurnSummary(parts)?.files[0]).toMatchObject({
      op: "create",
      writeCount: 2,
      added: 3,
    });
  });

  it("marks a delete as op delete and overrides a prior write", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "a.ts", content: "1" },
        {
          success: true,
          diffStat: {
            added: 2,
            removed: 0,
            isNew: true,
            isBinary: false,
            truncated: false,
          },
        },
      ),
      tool("deleteFile", { path: "a.ts" }, { success: true, path: "a.ts" }),
    ];
    expect(buildTurnSummary(parts)?.files).toEqual([
      { path: "a.ts", op: "delete", added: 0, removed: 0, writeCount: 1 },
    ]);
  });

  it("flags unknownStat when diffStat is missing or binary", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "img.png", content: "..." },
        {
          success: true,
          diffStat: {
            added: 0,
            removed: 0,
            isNew: true,
            isBinary: true,
            truncated: false,
          },
        },
      ),
      tool("writeFile", { path: "b.ts", content: "..." }, { success: true }),
    ];
    const files = buildTurnSummary(parts)?.files ?? [];
    expect(files.find((f) => f.path === "img.png")?.unknownStat).toBe(true);
    expect(files.find((f) => f.path === "b.ts")?.unknownStat).toBe(true);
  });

  it("skips a failed writeFile (output-error) — the file did not change", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "a.ts", content: "1" },
        { success: false, error: "denied" },
        "output-error",
      ),
    ];
    expect(buildTurnSummary(parts)).toBeNull();
  });

  it("skips a cancelled write normalized to output-available with success:false", () => {
    const parts: MessagePart[] = [
      tool(
        "writeFile",
        { path: "a.ts", content: "1" },
        { success: false, cancelled: true, reason: "user stopped" },
        "output-available",
      ),
    ];
    expect(buildTurnSummary(parts)).toBeNull();
  });

  it("collects commands with exitCode, kind and testStats", () => {
    const parts: MessagePart[] = [
      tool(
        "runCommand",
        { command: "pnpm build" },
        { stdout: "", stderr: "", exitCode: 0, commandKind: "build" },
      ),
      tool(
        "runCommand",
        { command: "pnpm test" },
        {
          stdout: "1 failed, 5 passed",
          stderr: "",
          exitCode: 1,
          commandKind: "test",
          testStats: { passed: 5, failed: 1 },
        },
        "output-error",
      ),
    ];
    const sum = buildTurnSummary(parts);
    expect(sum?.commands).toEqual([
      { command: "pnpm build", exitCode: 0, kind: "build" },
      {
        command: "pnpm test",
        exitCode: 1,
        kind: "test",
        testStats: { passed: 5, failed: 1 },
      },
    ]);
  });

  it("reports an interrupted command with null exitCode", () => {
    const parts: MessagePart[] = [
      tool(
        "runCommand",
        { command: "zip -r out.zip big" },
        { success: false, cancelled: true, deliverable: true },
        "output-available",
      ),
    ];
    expect(buildTurnSummary(parts)?.commands[0]).toEqual({
      command: "zip -r out.zip big",
      exitCode: null,
      kind: "generic",
    });
  });

  it("hides read-only inspection commands from the card", () => {
    const parts: MessagePart[] = [
      tool(
        "runCommand",
        { command: "du -sh ." },
        { exitCode: 0, commandKind: "generic", deliverable: false },
        "output-available",
      ),
    ];
    // Nothing delivered → no card at all.
    expect(buildTurnSummary(parts)).toBeNull();
  });
});

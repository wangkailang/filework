import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../../../workspace/local-workspace";
import type { ToolContext, ToolDefinition } from "../../tool-registry";
import { buildFileTools, type FileSearchFn } from "../index";

describe("searchFiles tool", () => {
  let root: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-search-"));
    ctx = {
      workspace: new LocalWorkspace(root),
      signal: new AbortController().signal,
      toolCallId: "call-1",
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is only registered when a search dep is provided", () => {
    expect(
      buildFileTools().find((t) => t.name === "searchFiles"),
    ).toBeUndefined();
    const fake: FileSearchFn = async () => ({
      hits: [],
      totalMatched: 0,
      truncated: false,
    });
    expect(
      buildFileTools({ searchFiles: fake }).find(
        (t) => t.name === "searchFiles",
      ),
    ).toBeDefined();
  });

  it("passes root + parsed filters and maps hits to absolute paths", async () => {
    let captured: Parameters<FileSearchFn> | undefined;
    const fake: FileSearchFn = async (rootAbs, query, options) => {
      captured = [rootAbs, query, options];
      return {
        hits: [
          {
            name: "report.pdf",
            relPath: "docs/report.pdf",
            size: 123,
            mtimeMs: 1_700_000_000_000,
            score: 7,
          },
        ],
        totalMatched: 1,
        truncated: false,
      };
    };
    const tool = buildFileTools({ searchFiles: fake }).find(
      (t) => t.name === "searchFiles",
    ) as ToolDefinition;

    const result = (await tool.execute(
      {
        query: "report",
        extensions: ["pdf"],
        modifiedAfter: "2023-01-01T00:00:00.000Z",
        limit: 50,
      },
      ctx,
    )) as {
      results: { path: string; relPath: string; modifiedAt: string }[];
      totalMatched: number;
      count: number;
    };

    // 默认搜索根为 workspace root。
    expect(captured?.[0]).toBe(path.resolve(root));
    expect(captured?.[1]).toBe("report");
    expect(captured?.[2]?.extensions).toEqual(["pdf"]);
    expect(captured?.[2]?.modifiedAfterMs).toBe(
      Date.parse("2023-01-01T00:00:00.000Z"),
    );

    expect(result.count).toBe(1);
    expect(result.totalMatched).toBe(1);
    expect(result.results[0].path).toBe(
      path.join(path.resolve(root), "docs/report.pdf"),
    );
    expect(result.results[0].modifiedAt).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../local-workspace";
import {
  readWorkspaceMemory,
  setWorkspaceMemoryRoot,
  updateWorkspaceMemory,
} from "../workspace-memory";

// 历史托管块标记(仅迁移测试用,故在测试内内联,不从模块导出)。
const LEGACY_START = "<!-- filework:memory:start -->";
const LEGACY_END = "<!-- filework:memory:end -->";

describe("workspace-memory (zero repo footprint)", () => {
  let root: string;
  let memRoot: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-mem-ws-"));
    memRoot = await mkdtemp(path.join(tmpdir(), "fw-mem-data-"));
    ws = new LocalWorkspace(root);
    // 把机器记忆根目录指向临时目录,避免污染真实 ~/.filework。
    setWorkspaceMemoryRoot(memRoot);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(memRoot, { recursive: true, force: true });
  });

  describe("readWorkspaceMemory", () => {
    it("returns null when neither human instructions nor agent memory exist", async () => {
      expect(await readWorkspaceMemory(ws)).toBeNull();
    });

    it("reads human-authored AGENTS.md (read-only)", async () => {
      await ws.fs.writeFile("AGENTS.md", "# Project\n- pnpm");
      expect(await readWorkspaceMemory(ws)).toContain("- pnpm");
    });

    it("falls back to CLAUDE.md when AGENTS.md is absent", async () => {
      await ws.fs.writeFile("CLAUDE.md", "claude rules here");
      expect(await readWorkspaceMemory(ws)).toContain("claude rules here");
    });

    it("merges human instructions and agent memory", async () => {
      await ws.fs.writeFile("AGENTS.md", "# Human rules\n- be nice");
      await updateWorkspaceMemory(ws, "- learned: uses pnpm");
      const mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("be nice"); // 人写
      expect(mem).toContain("learned: uses pnpm"); // 机器
    });

    it("truncates oversized memory with a notice", async () => {
      await updateWorkspaceMemory(ws, "x".repeat(20_000));
      const mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("workspace memory truncated");
      expect((mem ?? "").length).toBeLessThan(20_000);
    });

    it("keeps agent memory even when the human file exceeds the budget", async () => {
      // 大体量人写文件不应把机器记忆挤出上限(否则 saved memory 永不进提示词)。
      await ws.fs.writeFile("AGENTS.md", "H".repeat(9000));
      await updateWorkspaceMemory(ws, "- agent fact kept");
      const mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("- agent fact kept");
    });
  });

  describe("updateWorkspaceMemory — never touches the repo", () => {
    it("writes to app data, leaving the workspace untouched (zero footprint)", async () => {
      await updateWorkspaceMemory(ws, "- uses pnpm");
      // 仓库里不应凭空出现 AGENTS.md / CLAUDE.md
      expect(await ws.fs.exists("AGENTS.md")).toBe(false);
      expect(await ws.fs.exists("CLAUDE.md")).toBe(false);
      // 但记忆能被读回
      expect(await readWorkspaceMemory(ws)).toContain("- uses pnpm");
    });

    it("never writes agent memory into a human AGENTS.md", async () => {
      await ws.fs.writeFile("AGENTS.md", "# Human only");
      await updateWorkspaceMemory(ws, "- learned fact");
      const agents = (await ws.fs.readFile("AGENTS.md")) as string;
      expect(agents).toBe("# Human only"); // 原样不动
      expect(agents).not.toContain("learned fact");
    });

    it("append accumulates; replace overwrites", async () => {
      await updateWorkspaceMemory(ws, "- one");
      await updateWorkspaceMemory(ws, "- two");
      let mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("- one");
      expect(mem).toContain("- two");

      await updateWorkspaceMemory(ws, "- only", "replace");
      mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("- only");
      expect(mem).not.toContain("- one");
    });

    it("dedups identical append content (no unbounded growth)", async () => {
      await updateWorkspaceMemory(ws, "- dup");
      await updateWorkspaceMemory(ws, "- dup");
      const mem = (await readWorkspaceMemory(ws)) ?? "";
      expect(mem.split("- dup").length - 1).toBe(1);
    });

    it("keys memory by workspace path — two dirs are independent", async () => {
      const root2 = await mkdtemp(path.join(tmpdir(), "fw-mem-ws2-"));
      const ws2 = new LocalWorkspace(root2);
      try {
        await updateWorkspaceMemory(ws, "- from dir A");
        await updateWorkspaceMemory(ws2, "- from dir B");
        expect(await readWorkspaceMemory(ws)).toContain("- from dir A");
        expect(await readWorkspaceMemory(ws)).not.toContain("- from dir B");
        expect(await readWorkspaceMemory(ws2)).toContain("- from dir B");
      } finally {
        await rm(root2, { recursive: true, force: true });
      }
    });
  });

  describe("one-time migration of legacy AGENTS.md block", () => {
    it("moves a legacy memory block out of AGENTS.md and cleans the file", async () => {
      const block = `${LEGACY_START}\n## Workspace Memory (auto-maintained by the agent)\n\n- migrated fact\n${LEGACY_END}`;
      await ws.fs.writeFile("AGENTS.md", `# Top\n\n${block}\n\n# Bottom`);

      const mem = await readWorkspaceMemory(ws);
      const agentsAfter = (await ws.fs.readFile("AGENTS.md")) as string;

      // AGENTS.md 恢复干净:人写内容保留,块与标记被抹掉
      expect(agentsAfter).toContain("# Top");
      expect(agentsAfter).toContain("# Bottom");
      expect(agentsAfter).not.toContain("filework:memory:start");
      expect(agentsAfter).not.toContain("migrated fact");

      // 记忆迁入机器侧,仍可读回
      expect(mem).toContain("migrated fact");
    });

    it("is idempotent and a no-op when there is no legacy block", async () => {
      await ws.fs.writeFile("AGENTS.md", "# Clean human file");
      await readWorkspaceMemory(ws);
      const agents = (await ws.fs.readFile("AGENTS.md")) as string;
      expect(agents).toBe("# Clean human file");
    });

    it("removes AGENTS.md entirely if it contained only the legacy block", async () => {
      const block = `${LEGACY_START}\n- solo fact\n${LEGACY_END}`;
      await ws.fs.writeFile("AGENTS.md", block);
      const mem = await readWorkspaceMemory(ws);
      // 原本只有块的文件不应留下空文件
      expect(await ws.fs.exists("AGENTS.md")).toBe(false);
      expect(mem).toContain("solo fact");
    });
  });
});

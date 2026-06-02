import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { workspaceKey } from "../../session/workspace-key";
import { LocalWorkspace } from "../local-workspace";
import {
  clearUserMemory,
  clearWorkspaceMemory,
  containsSecret,
  forgetMemory,
  getWorkspaceMemoryInfo,
  MemorySecretError,
  readWorkspaceMemory,
  rememberMemory,
  setWorkspaceMemoryRoot,
} from "../workspace-memory";

// 历史托管块标记(仅迁移测试用,故在测试内内联,不从模块导出)。
const LEGACY_START = "<!-- filework:memory:start -->";
const LEGACY_END = "<!-- filework:memory:end -->";

describe("workspace-memory (structured entries, zero repo footprint)", () => {
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
      await rememberMemory(ws, {
        key: "pm",
        scope: "workspace",
        category: "project",
        text: "uses pnpm",
      });
      const mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("be nice"); // 人写
      expect(mem).toContain("uses pnpm"); // 机器
    });

    it("renders each entry with its [key] so the agent can update in place", async () => {
      await rememberMemory(ws, {
        key: "build-cmd",
        scope: "workspace",
        category: "project",
        text: "pnpm build",
      });
      expect(await readWorkspaceMemory(ws)).toContain(
        "- [build-cmd] pnpm build",
      );
    });

    it("truncates oversized memory with a notice", async () => {
      await rememberMemory(ws, {
        key: "big",
        scope: "workspace",
        category: "project",
        text: "x".repeat(20_000),
      });
      const mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("workspace memory truncated");
      expect((mem ?? "").length).toBeLessThan(20_000);
    });

    it("keeps agent memory even when the human file exceeds the budget", async () => {
      await ws.fs.writeFile("AGENTS.md", "H".repeat(9000));
      await rememberMemory(ws, {
        key: "fact",
        scope: "workspace",
        category: "project",
        text: "agent fact kept",
      });
      expect(await readWorkspaceMemory(ws)).toContain("agent fact kept");
    });
  });

  describe("rememberMemory — never touches the repo", () => {
    it("writes to app data, leaving the workspace untouched (zero footprint)", async () => {
      await rememberMemory(ws, {
        key: "pm",
        scope: "workspace",
        category: "project",
        text: "uses pnpm",
      });
      expect(await ws.fs.exists("AGENTS.md")).toBe(false);
      expect(await ws.fs.exists("CLAUDE.md")).toBe(false);
      expect(await readWorkspaceMemory(ws)).toContain("uses pnpm");
    });

    it("never writes agent memory into a human AGENTS.md", async () => {
      await ws.fs.writeFile("AGENTS.md", "# Human only");
      await rememberMemory(ws, {
        key: "fact",
        scope: "workspace",
        category: "project",
        text: "learned fact",
      });
      const agents = (await ws.fs.readFile("AGENTS.md")) as string;
      expect(agents).toBe("# Human only");
      expect(agents).not.toContain("learned fact");
    });
  });

  describe("upsert by key (no reworded duplicates)", () => {
    it("same key overwrites in place instead of appending", async () => {
      await rememberMemory(ws, {
        key: "pm",
        scope: "workspace",
        category: "project",
        text: "uses pnpm",
      });
      await rememberMemory(ws, {
        key: "pm",
        scope: "workspace",
        category: "project",
        text: "uses pnpm v9",
      });
      const mem = (await readWorkspaceMemory(ws)) ?? "";
      expect(mem).toContain("uses pnpm v9");
      // 仍只有一条 pm 记忆
      expect(mem.split("[pm]").length - 1).toBe(1);
    });

    it("merges a near-duplicate in the same category under a single entry", async () => {
      await rememberMemory(ws, {
        key: "lang-a",
        scope: "user",
        category: "preference",
        text: "always reply in chinese",
      });
      await rememberMemory(ws, {
        key: "lang-b",
        scope: "user",
        category: "preference",
        text: "Always reply in Chinese.",
      });
      const info = await getWorkspaceMemoryInfo(ws);
      expect(info.userEntries.length).toBe(1); // 归一化相同被合并
    });

    it("forget removes the entry by key", async () => {
      await rememberMemory(ws, {
        key: "tmp",
        scope: "workspace",
        category: "project",
        text: "to be removed",
      });
      await forgetMemory(ws, "workspace", "tmp");
      expect(await readWorkspaceMemory(ws)).toBeNull();
    });
  });

  describe("concurrency safety", () => {
    it("serializes concurrent writes so no entry is clobbered (lost-update)", async () => {
      await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          rememberMemory(ws, {
            key: `k${i}`,
            scope: "workspace",
            category: "project",
            text: `fact ${i}`,
          }),
        ),
      );
      const info = await getWorkspaceMemoryInfo(ws);
      expect(info.workspaceEntries.length).toBe(12);
    });
  });

  describe("secret guard", () => {
    it("detects common credential shapes", () => {
      expect(containsSecret("token is sk-abcdefghijklmnop1234")).toBe(true);
      expect(containsSecret("use ghp_0123456789abcdefghijABCDEFGHIJ12")).toBe(
        true,
      );
      expect(containsSecret("password=hunter2hunter")).toBe(true);
      expect(containsSecret("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe(true);
    });

    it("detects a vendor key stated in natural language (keyword + high-entropy token)", () => {
      expect(
        containsSecret(
          "xiaomi llm key tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41 记一下",
        ),
      ).toBe(true);
      expect(containsSecret("我的密钥是 ab12cd34ef56gh78ij90kl12mn34")).toBe(
        true,
      );
      // 真实泄漏写法:全角冒号「：」紧贴 token、token 前无空格 —— 旧的 \s+
      // 切词会把 "API密钥：tp-xxxx" 粘成一个含汉字的 token 而漏放。
      expect(
        containsSecret(
          "小米LLM API密钥：tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41",
        ),
      ).toBe(true);
    });

    it("flags a long standalone high-entropy token even without a keyword", () => {
      expect(
        containsSecret("记住 tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6"),
      ).toBe(true);
    });

    it("does not flag ordinary durable facts, paths, hashes or uuids", () => {
      expect(containsSecret("uses pnpm and vitest")).toBe(false);
      expect(containsSecret("回复语言使用中文")).toBe(false);
      expect(
        containsSecret("项目根目录是 /Users/kailang/develop/2026/filework"),
      ).toBe(false);
      expect(
        containsSecret(
          "build at commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
        ),
      ).toBe(false); // 40-hex SHA
      expect(
        containsSecret("session 550e8400-e29b-41d4-a716-446655440000"),
      ).toBe(false); // UUID
    });

    it("rememberMemory rejects secret-bearing text at the storage layer", async () => {
      await expect(
        rememberMemory(ws, {
          key: "leak",
          scope: "workspace",
          category: "project",
          text: "deploy key sk-abcdefghijklmnop1234",
        }),
      ).rejects.toBeInstanceOf(MemorySecretError);
      // 未落盘
      expect(await readWorkspaceMemory(ws)).toBeNull();
    });
  });

  describe("scopes", () => {
    it("user-scope memory is shared across workspaces; workspace-scope is not", async () => {
      const root2 = await mkdtemp(path.join(tmpdir(), "fw-mem-ws2-"));
      const ws2 = new LocalWorkspace(root2);
      try {
        await rememberMemory(ws, {
          key: "reply-style",
          scope: "user",
          category: "preference",
          text: "reply in chinese",
        });
        await rememberMemory(ws, {
          key: "build",
          scope: "workspace",
          category: "project",
          text: "from dir A",
        });
        // user 偏好两个工作区都能读到
        expect(await readWorkspaceMemory(ws)).toContain("reply in chinese");
        expect(await readWorkspaceMemory(ws2)).toContain("reply in chinese");
        // workspace 事实只属于 A
        expect(await readWorkspaceMemory(ws2)).not.toContain("from dir A");
        expect(await readWorkspaceMemory(ws)).toContain("from dir A");
      } finally {
        await rm(root2, { recursive: true, force: true });
      }
    });

    it("clearWorkspaceMemory keeps user memory; clearUserMemory keeps workspace memory", async () => {
      await rememberMemory(ws, {
        key: "reply-style",
        scope: "user",
        category: "preference",
        text: "reply in chinese",
      });
      await rememberMemory(ws, {
        key: "build",
        scope: "workspace",
        category: "project",
        text: "pnpm build",
      });

      await clearWorkspaceMemory(ws);
      const mem = (await readWorkspaceMemory(ws)) ?? "";
      expect(mem).toContain("reply in chinese"); // user 保留
      expect(mem).not.toContain("pnpm build"); // workspace 清掉

      await clearUserMemory();
      expect(await readWorkspaceMemory(ws)).toBeNull(); // user 也清掉
    });
  });

  describe("migration of legacy plain-text .md memory", () => {
    it("quarantines an old <key>.md into a single legacy-notes entry and removes the .md", async () => {
      const mdPath = path.join(memRoot, `${workspaceKey(root)}.md`);
      const jsonPath = path.join(memRoot, `${workspaceKey(root)}.json`);
      await writeFile(mdPath, "- uses pnpm\n- tests in __tests__\n", "utf-8");

      const mem = await readWorkspaceMemory(ws);
      expect(mem).toContain("uses pnpm");
      expect(mem).toContain("tests in __tests__");

      // 旧文件被清掉,新结构化文件生成
      await expect(readFile(mdPath, "utf-8")).rejects.toThrow();
      const json = JSON.parse(await readFile(jsonPath, "utf-8"));
      expect(Array.isArray(json)).toBe(true);
      // 不再逐行伪装成 N 条事实,而是整体收成单条隔离条目
      expect(json.length).toBe(1);
      expect(json[0].key).toBe("legacy-notes");
      expect(json[0].category).toBe("reference");
      expect(json[0].text).toContain("uses pnpm");
      expect(json[0].text).toContain("tests in __tests__");
    });
  });

  describe("one-time migration of legacy AGENTS.md block", () => {
    it("moves a legacy memory block out of AGENTS.md and cleans the file", async () => {
      const block = `${LEGACY_START}\n## Workspace Memory (auto-maintained by the agent)\n\n- migrated fact\n${LEGACY_END}`;
      await ws.fs.writeFile("AGENTS.md", `# Top\n\n${block}\n\n# Bottom`);

      const mem = await readWorkspaceMemory(ws);
      const agentsAfter = (await ws.fs.readFile("AGENTS.md")) as string;

      expect(agentsAfter).toContain("# Top");
      expect(agentsAfter).toContain("# Bottom");
      expect(agentsAfter).not.toContain("filework:memory:start");
      expect(agentsAfter).not.toContain("migrated fact");
      expect(mem).toContain("migrated fact");
    });

    it("is idempotent and a no-op when there is no legacy block", async () => {
      await ws.fs.writeFile("AGENTS.md", "# Clean human file");
      await readWorkspaceMemory(ws);
      const agents = (await ws.fs.readFile("AGENTS.md")) as string;
      expect(agents).toBe("# Clean human file");
    });
  });
});

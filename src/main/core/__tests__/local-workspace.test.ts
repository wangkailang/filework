import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalWorkspace } from "../workspace/local-workspace";
import { WorkspaceEscapeError } from "../workspace/types";

describe("LocalWorkspace", () => {
  let root: string;
  let outside: string;
  let ws: LocalWorkspace;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-ws-root-"));
    outside = await mkdtemp(path.join(tmpdir(), "fw-ws-outside-"));
    ws = new LocalWorkspace(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  describe("fs basics", () => {
    it("writes and reads a file at a relative path", async () => {
      await ws.fs.writeFile("hello.txt", "world");
      const content = await ws.fs.readFile("hello.txt");
      expect(content).toBe("world");
    });

    it("creates parent directories on writeFile", async () => {
      await ws.fs.writeFile("nested/deep/file.txt", "ok");
      const content = await ws.fs.readFile("nested/deep/file.txt");
      expect(content).toBe("ok");
    });

    it("lists entries with directories first", async () => {
      await ws.fs.writeFile("z-file.txt", "");
      await ws.fs.mkdir("a-dir", { recursive: true });
      const entries = await ws.fs.list(".");
      expect(entries.map((e) => e.name)).toEqual(["a-dir", "z-file.txt"]);
      expect(entries[0].isDirectory).toBe(true);
      expect(entries[1].isDirectory).toBe(false);
    });

    it("skips dotfiles and node_modules", async () => {
      await ws.fs.writeFile(".hidden", "x");
      await ws.fs.mkdir("node_modules", { recursive: true });
      await ws.fs.writeFile("visible.txt", "y");
      const entries = await ws.fs.list(".");
      expect(entries.map((e) => e.name)).toEqual(["visible.txt"]);
    });

    it("stat reports size + isDirectory", async () => {
      await ws.fs.writeFile("a.txt", "12345");
      const stat = await ws.fs.stat("a.txt");
      expect(stat.isDirectory).toBe(false);
      expect(stat.size).toBe(5);
    });

    it("rename moves files and creates parent dirs", async () => {
      await ws.fs.writeFile("from.txt", "x");
      await ws.fs.rename("from.txt", "moved/to.txt");
      expect(await ws.fs.exists("from.txt")).toBe(false);
      expect(await ws.fs.readFile("moved/to.txt")).toBe("x");
    });

    it("rm removes files and directories recursively", async () => {
      await ws.fs.writeFile("doomed/inner.txt", "x");
      await ws.fs.rm("doomed", { recursive: true });
      expect(await ws.fs.exists("doomed")).toBe(false);
    });
  });

  describe("sandboxing", () => {
    it("rejects relative ../ escape via writeFile", async () => {
      await expect(
        ws.fs.writeFile("../escape.txt", "x"),
      ).rejects.toBeInstanceOf(WorkspaceEscapeError);
    });

    it("rejects absolute path outside workspace via toRelative", async () => {
      await expect(ws.fs.toRelative(outside)).rejects.toBeInstanceOf(
        WorkspaceEscapeError,
      );
    });

    it("accepts an absolute path inside workspace via toRelative", async () => {
      await ws.fs.writeFile("inside.txt", "x");
      const abs = path.join(root, "inside.txt");
      const rel = await ws.fs.toRelative(abs);
      expect(rel).toBe("inside.txt");
    });

    it("rejects symlink-out-of-workspace reads", async () => {
      const targetOutside = path.join(outside, "secret.txt");
      await writeFile(targetOutside, "shh");
      await mkdir(path.join(root, "trap"), { recursive: true });
      await symlink(targetOutside, path.join(root, "trap", "leak.txt"));
      await expect(ws.fs.readFile("trap/leak.txt")).rejects.toBeInstanceOf(
        WorkspaceEscapeError,
      );
    });
  });

  describe("exec", () => {
    it("runs a shell command in the workspace cwd", async () => {
      await ws.fs.writeFile("greeting.txt", "hi");
      const isWindows = process.platform === "win32";
      const cmd = isWindows ? "type greeting.txt" : "cat greeting.txt";
      const result = await ws.exec.run(cmd);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hi");
    });

    it("rejects an absolute cwd outside workspace", async () => {
      await expect(ws.exec.run("ls", { cwd: outside })).rejects.toBeInstanceOf(
        WorkspaceEscapeError,
      );
    });

    it("propagates abort signal", async () => {
      const ctrl = new AbortController();
      const promise = ws.exec.run("sleep 5", { signal: ctrl.signal });
      ctrl.abort();
      const result = await promise;
      expect(result.exitCode).toBe(130);
    });
  });

  describe("identity", () => {
    it("derives a stable id from the absolute root", () => {
      const expected = `local:${path.resolve(root)}`;
      expect(ws.id).toBe(expected);
      expect(ws.kind).toBe("local");
    });
  });
});

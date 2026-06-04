import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installEntry, uninstallSkill } from "../installer";
import type { MarketEntry } from "../types";

let skillsRoot: string;

beforeEach(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), "fw-skills-"));
});
afterEach(() => {
  rmSync(skillsRoot, { recursive: true, force: true });
});

describe("installEntry — url source", () => {
  it("downloads a single SKILL.md into <root>/<id>/", async () => {
    const entry: MarketEntry = {
      id: "hello",
      name: "Hello",
      description: "d",
      level: "community",
      source: { type: "url", url: "https://example.com/SKILL.md" },
    };
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "---\nname: hello\n---\nbody",
    });
    const res = await installEntry(entry, { skillsRoot, fetcher });
    expect(res.ok).toBe(true);
    const md = await readFile(join(skillsRoot, "hello", "SKILL.md"), "utf-8");
    expect(md).toContain("name: hello");
  });

  it("rolls back the dir on a failed download", async () => {
    const entry: MarketEntry = {
      id: "bad",
      name: "Bad",
      description: "d",
      level: "community",
      source: { type: "url", url: "https://example.com/SKILL.md" },
    };
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const res = await installEntry(entry, { skillsRoot, fetcher });
    expect(res.ok).toBe(false);
    expect(existsSync(join(skillsRoot, "bad"))).toBe(false);
  });
});

describe("installEntry — git source", () => {
  it("invokes git clone then copies the subdir", async () => {
    const entry: MarketEntry = {
      id: "gitskill",
      name: "Git Skill",
      description: "d",
      level: "official",
      source: { type: "git", repo: "https://github.com/x/y", subdir: "sub" },
    };
    // runGit 注入:从 args 末项取 clone 路径,在其中铺好 sub/SKILL.md
    const runGit = vi.fn(async (args: string[]) => {
      const clone = args[args.length - 1];
      mkdirSync(join(clone, "sub"), { recursive: true });
      writeFileSync(
        join(clone, "sub", "SKILL.md"),
        "---\nname: gitskill\n---\nb",
      );
    });
    const res = await installEntry(entry, { skillsRoot, runGit });
    expect(res.ok).toBe(true);
    expect(existsSync(join(skillsRoot, "gitskill", "SKILL.md"))).toBe(true);
  });
});

describe("uninstallSkill", () => {
  it("removes the skill dir", async () => {
    mkdirSync(join(skillsRoot, "gone"), { recursive: true });
    writeFileSync(join(skillsRoot, "gone", "SKILL.md"), "x");
    await uninstallSkill("gone", { skillsRoot });
    expect(existsSync(join(skillsRoot, "gone"))).toBe(false);
  });
});

describe("installEntry — git rollback", () => {
  it("returns ok:false and removes target when runGit throws", async () => {
    const entry: MarketEntry = {
      id: "gitfail",
      name: "Git Fail",
      description: "d",
      level: "official",
      source: { type: "git", repo: "https://github.com/x/y", subdir: "sub" },
    };
    const runGit = vi.fn(async () => {
      throw new Error("clone failed");
    });
    const res = await installEntry(entry, { skillsRoot, runGit });
    expect(res.ok).toBe(false);
    expect(existsSync(join(skillsRoot, "gitfail"))).toBe(false);
  });
});

describe("installEntry — path traversal guard", () => {
  it("rejects an id that escapes skillsRoot", async () => {
    const entry: MarketEntry = {
      id: "../../evil",
      name: "Evil",
      description: "d",
      level: "community",
      source: { type: "url", url: "https://example.com/SKILL.md" },
    };
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => "x" });
    const res = await installEntry(entry, { skillsRoot, fetcher });
    expect(res.ok).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a subdir that escapes the clone dir", async () => {
    const entry: MarketEntry = {
      id: "evilsub",
      name: "Evil Sub",
      description: "d",
      level: "official",
      source: {
        type: "git",
        repo: "https://github.com/x/y",
        subdir: "../../etc",
      },
    };
    const runGit = vi.fn(async (args: string[]) => {
      const clone = args[args.length - 1];
      mkdirSync(clone, { recursive: true });
    });
    const res = await installEntry(entry, { skillsRoot, runGit });
    expect(res.ok).toBe(false);
  });
});

describe("uninstallSkill — path traversal guard", () => {
  it("throws on an id that escapes skillsRoot", async () => {
    await expect(uninstallSkill("../../etc", { skillsRoot })).rejects.toThrow();
  });
});

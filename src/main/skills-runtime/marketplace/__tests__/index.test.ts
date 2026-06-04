import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listMarket } from "../index";
import type { MarketEntry } from "../types";

const entry: MarketEntry = {
  id: "pdf-tools",
  name: "PDF Tools",
  description: "d",
  level: "official",
  source: { type: "url", url: "https://example.com/SKILL.md" },
};

let skillsRoot: string;
beforeEach(() => {
  skillsRoot = mkdtempSync(join(tmpdir(), "fw-mkt-"));
});
afterEach(() => rmSync(skillsRoot, { recursive: true, force: true }));

describe("listMarket", () => {
  it("flags entries already present in skillsRoot as installed", async () => {
    // 预先创建目录 + SKILL.md,模拟已安装
    mkdirSync(join(skillsRoot, "pdf-tools"), { recursive: true });
    writeFileSync(join(skillsRoot, "pdf-tools", "SKILL.md"), "x");

    const fetchRegistry = vi.fn().mockResolvedValue([entry]);
    const out = await listMarket({ skillsRoot, fetchRegistry });

    expect(out).toHaveLength(1);
    expect(out[0].installed).toBe(true);
  });

  it("flags absent entries as not installed", async () => {
    const fetchRegistry = vi.fn().mockResolvedValue([entry]);
    const out = await listMarket({ skillsRoot, fetchRegistry });

    expect(out[0].installed).toBe(false);
  });
});

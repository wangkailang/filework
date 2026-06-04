import { beforeEach, describe, expect, it } from "vitest";
import {
  _initTestDatabase,
  deleteSkillTrust,
  getSkillTrust,
  type SkillTrustRow,
  upsertSkillTrust,
} from "../index";

// 用内存数据库初始化,每次测试前重置
beforeEach(() => {
  _initTestDatabase(":memory:");
  deleteSkillTrust("pdf-tools");
});

const rec: SkillTrustRow = {
  skillId: "pdf-tools",
  sourcePath: "/tmp/pdf-tools/SKILL.md",
  contentHash: "abc123",
  approved: true,
  approvedAt: "2026-06-04T00:00:00.000Z",
  allowCommands: true,
  allowHooks: false,
};

describe("skill_trust CRUD", () => {
  it("upserts and reads back a record", () => {
    upsertSkillTrust(rec);
    expect(getSkillTrust("pdf-tools")).toEqual(rec);
  });

  it("updates an existing record on second upsert", () => {
    upsertSkillTrust(rec);
    upsertSkillTrust({ ...rec, contentHash: "def456", approved: false });
    const got = getSkillTrust("pdf-tools");
    expect(got?.contentHash).toBe("def456");
    expect(got?.approved).toBe(false);
  });

  it("returns null for unknown skill", () => {
    expect(getSkillTrust("nope")).toBeNull();
  });

  it("deletes a record", () => {
    upsertSkillTrust(rec);
    deleteSkillTrust("pdf-tools");
    expect(getSkillTrust("pdf-tools")).toBeNull();
  });
});

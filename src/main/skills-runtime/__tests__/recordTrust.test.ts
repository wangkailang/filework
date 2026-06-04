/**
 * recordTrust / hydrateTrust 内存灌入函数的单元测试。
 * 纯 Node 环境运行，不依赖任何 DB 或 Electron 模块。
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearTrustStore,
  hydrateTrust,
  isSkillTrusted,
  recordTrust,
} from "../security";
import type { SkillTrustRecord } from "../types";

/** 构造一条已批准的信任记录工厂函数。 */
function makeRecord(
  skillId: string,
  contentHash = "abc123",
  approved = true,
): SkillTrustRecord {
  return {
    skillId,
    sourcePath: `/fake/skills/${skillId}/SKILL.md`,
    contentHash,
    approved,
    approvedAt: "2026-01-01T00:00:00.000Z",
    permissions: { allowCommands: false, allowHooks: false },
  };
}

describe("recordTrust", () => {
  // 每个用例前清空内存存储，避免用例间相互干扰
  beforeEach(() => {
    _clearTrustStore();
  });

  it("写入后 isSkillTrusted 应返回 true（哈希匹配）", () => {
    const record = makeRecord("skill-a", "hash-001");
    recordTrust(record);
    expect(isSkillTrusted("skill-a", "hash-001")).toBe(true);
  });

  it("写入后哈希不匹配应返回 false", () => {
    const record = makeRecord("skill-b", "hash-002");
    recordTrust(record);
    expect(isSkillTrusted("skill-b", "wrong-hash")).toBe(false);
  });

  it("approved 为 false 时即使哈希匹配也不受信任", () => {
    const record = makeRecord("skill-c", "hash-003", false);
    recordTrust(record);
    expect(isSkillTrusted("skill-c", "hash-003")).toBe(false);
  });

  it("覆盖写入：新记录替换旧记录", () => {
    recordTrust(makeRecord("skill-d", "old-hash"));
    // 用新 hash 和 approved=false 覆盖
    recordTrust({ ...makeRecord("skill-d", "new-hash", false) });
    // 旧 hash 不再受信任
    expect(isSkillTrusted("skill-d", "old-hash")).toBe(false);
    // 新 hash 也不受信任（因 approved=false）
    expect(isSkillTrusted("skill-d", "new-hash")).toBe(false);
  });
});

describe("hydrateTrust", () => {
  beforeEach(() => {
    _clearTrustStore();
  });

  it("批量灌入后每条记录均可被 isSkillTrusted 验证通过", () => {
    const records = [
      makeRecord("alpha", "h-alpha"),
      makeRecord("beta", "h-beta"),
      makeRecord("gamma", "h-gamma"),
    ];
    hydrateTrust(records);
    for (const r of records) {
      expect(isSkillTrusted(r.skillId, r.contentHash)).toBe(true);
    }
  });

  it("空数组灌入不抛异常，且不影响已有记录", () => {
    recordTrust(makeRecord("existing", "h-exist"));
    hydrateTrust([]);
    expect(isSkillTrusted("existing", "h-exist")).toBe(true);
  });

  it("灌入 approved=false 的记录后 isSkillTrusted 应返回 false", () => {
    hydrateTrust([makeRecord("untrusted", "h-x", false)]);
    expect(isSkillTrusted("untrusted", "h-x")).toBe(false);
  });

  it("覆盖式：重复灌入相同 skillId 以最后一条为准", () => {
    // 先灌入一批
    hydrateTrust([makeRecord("dup", "h-v1")]);
    // 再灌入覆盖
    hydrateTrust([makeRecord("dup", "h-v2")]);
    expect(isSkillTrusted("dup", "h-v1")).toBe(false);
    expect(isSkillTrusted("dup", "h-v2")).toBe(true);
  });
});

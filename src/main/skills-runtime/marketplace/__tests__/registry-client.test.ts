import { describe, expect, it } from "vitest";
import { fetchRegistry, getRegistry, validateEntry } from "../registry-client";

const goodEntry = {
  id: "pdf-tools",
  name: "PDF Tools",
  description: "Parse PDFs",
  level: "official",
  source: { type: "git", repo: "https://github.com/x/y", subdir: "pdf-tools" },
};

describe("validateEntry", () => {
  it("accepts a well-formed git entry", () => {
    expect(validateEntry(goodEntry)).toBe(true);
  });

  it("rejects an entry missing id", () => {
    const { id, ...rest } = goodEntry;
    expect(validateEntry(rest)).toBe(false);
  });

  it("rejects an entry with unknown source type", () => {
    expect(validateEntry({ ...goodEntry, source: { type: "ftp" } })).toBe(
      false,
    );
  });

  it("rejects an entry with invalid level", () => {
    expect(validateEntry({ ...goodEntry, level: "trusted" })).toBe(false);
  });

  it("accepts a well-formed url entry", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "url", url: "https://example.com/SKILL.md" },
      }),
    ).toBe(true);
  });

  it("rejects a url entry with empty url", () => {
    expect(
      validateEntry({ ...goodEntry, source: { type: "url", url: "" } }),
    ).toBe(false);
  });

  // 安全修复:git transport 注入防护
  it("rejects a git entry with ext:: repo (危险传输协议)", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "git", repo: "ext::evil-command" },
      }),
    ).toBe(false);
  });

  it("rejects a git entry with ref starting with '-' (选项注入)", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "git", repo: "https://github.com/x/y", ref: "-x" },
      }),
    ).toBe(false);
  });

  it("rejects a git entry with file:: repo (本地文件传输)", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "git", repo: "file:///etc/passwd" },
      }),
    ).toBe(false);
  });

  it("accepts a git entry with ssh:// repo", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "git", repo: "ssh://git@github.com/x/y.git" },
      }),
    ).toBe(true);
  });

  it("accepts a git entry with git@ scp form repo", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "git", repo: "git@github.com:owner/repo.git" },
      }),
    ).toBe(true);
  });

  it("rejects a url entry with http:// (非 https)", () => {
    expect(
      validateEntry({
        ...goodEntry,
        source: { type: "url", url: "http://example.com/SKILL.md" },
      }),
    ).toBe(false);
  });
});

describe("getRegistry", () => {
  it("returns only valid entries from the source", () => {
    const entries = getRegistry({
      source: { entries: [goodEntry, { id: "broken" }] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("pdf-tools");
  });

  it("returns an empty list when entries is not an array", () => {
    expect(getRegistry({ source: { entries: null } })).toEqual([]);
  });

  it("returns an empty list when source has no entries", () => {
    expect(getRegistry({ source: {} })).toEqual([]);
  });

  it("reads the bundled registry.json by default", () => {
    const entries = getRegistry();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => validateEntry(e))).toBe(true);
  });
});

describe("fetchRegistry", () => {
  it("resolves to the validated entries from the source", async () => {
    const entries = await fetchRegistry({
      source: { entries: [goodEntry, { id: "broken" }] },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("pdf-tools");
  });
});

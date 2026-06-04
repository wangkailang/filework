import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRegistryCache,
  fetchRegistry,
  validateEntry,
} from "../registry-client";

beforeEach(() => clearRegistryCache());

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
});

describe("fetchRegistry", () => {
  it("returns only valid entries from the payload", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [goodEntry, { id: "broken" }] }),
    });
    const entries = await fetchRegistry({ fetcher, cacheMs: 0 });
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("pdf-tools");
  });

  it("caches within TTL and does not re-fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [goodEntry] }),
    });
    await fetchRegistry({ fetcher, cacheMs: 60_000 });
    await fetchRegistry({ fetcher, cacheMs: 60_000 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-ok response", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchRegistry({ fetcher, cacheMs: 0 })).rejects.toThrow();
  });

  it("re-fetches after the TTL expires", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: [goodEntry] }),
    });
    await fetchRegistry({ fetcher, cacheMs: 0 });
    await fetchRegistry({ fetcher, cacheMs: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns an empty list when entries is not an array", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries: null }),
    });
    const entries = await fetchRegistry({ fetcher, cacheMs: 0 });
    expect(entries).toEqual([]);
  });
});

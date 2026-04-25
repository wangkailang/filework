import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { IncrementalScanner } from "../incremental-scanner";

const originalHome = process.env.HOME;

afterEach(() => {
  process.env.HOME = originalHome;
});

describe("IncrementalScanner", () => {
  it("serializes cache writes during concurrent scans", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "filework-home-"));
    process.env.HOME = fakeHome;

    const workspaceDir = await mkdtemp(join(tmpdir(), "filework-scan-"));
    await writeFile(join(workspaceDir, "b.txt"), "2", "utf-8");
    await writeFile(join(workspaceDir, "a.txt"), "1", "utf-8");

    const scanner = new IncrementalScanner();

    const cacheManager = (scanner as unknown as { cacheManager: unknown })
      .cacheManager as {
      saveCache: () => Promise<void>;
    };
    const originalSaveCache = cacheManager.saveCache.bind(cacheManager);
    let activeWrites = 0;
    let maxConcurrentWrites = 0;

    cacheManager.saveCache = async () => {
      activeWrites += 1;
      maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        await originalSaveCache();
      } finally {
        activeWrites -= 1;
      }
    };

    await Promise.all(
      Array.from({ length: 6 }, () =>
        scanner.scanIncremental(workspaceDir, true),
      ),
    );

    await scanner.flushPendingWrites();
    expect(maxConcurrentWrites).toBe(1);
  });

  it("ignores invalid cache metadata and continues scanning", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "filework-home-"));
    process.env.HOME = fakeHome;

    const cacheDir = join(fakeHome, ".filework");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, "scan-cache.json"),
      JSON.stringify({
        version: 0,
        lastUpdate: "invalid-date",
        directories: {},
      }),
      "utf-8",
    );

    const workspaceDir = await mkdtemp(join(tmpdir(), "filework-scan-"));
    await writeFile(join(workspaceDir, "hello.txt"), "hello", "utf-8");

    const scanner = new IncrementalScanner();
    const result = await scanner.scanIncremental(workspaceDir, false);

    expect(result.totalFiles).toBe(1);
    expect(result.added.length).toBe(1);
  });
});

it("expires cached snapshots after TTL", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "filework-home-"));
  process.env.HOME = fakeHome;

  const workspaceDir = await mkdtemp(join(tmpdir(), "filework-scan-"));
  await writeFile(join(workspaceDir, "one.txt"), "1", "utf-8");

  const scanner = new IncrementalScanner({
    ttlMs: 1,
    maxDirectories: 100,
    maxTotalFiles: 10000,
  });
  const first = await scanner.scanIncremental(workspaceDir, false);
  expect(first.added.length).toBe(1);

  await new Promise((resolve) => setTimeout(resolve, 5));

  const second = await scanner.scanIncremental(workspaceDir, false);
  expect(second.added.length).toBe(1);
  expect(second.unchanged.length).toBe(0);
});

it("evicts old snapshots when maxDirectories is exceeded", async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), "filework-home-"));
  process.env.HOME = fakeHome;

  const dirA = await mkdtemp(join(tmpdir(), "filework-scan-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "filework-scan-b-"));
  await writeFile(join(dirA, "a.txt"), "a", "utf-8");
  await writeFile(join(dirB, "b.txt"), "b", "utf-8");

  const scanner = new IncrementalScanner({
    ttlMs: 60_000,
    maxDirectories: 1,
    maxTotalFiles: 10000,
  });
  await scanner.scanIncremental(dirA, false);
  await scanner.scanIncremental(dirB, false);

  expect(scanner.getCacheStats().directories).toBe(1);
});

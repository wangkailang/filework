import { describe, expect, it, vi } from "vitest";

describe("safeTools.listDirectory", () => {
  it("returns deterministically sorted entries in incremental mode", async () => {
    vi.resetModules();

    vi.doMock("../../utils/incremental-scanner", () => ({
      getIncrementalScanner: () => ({
        scanIncremental: vi.fn(async () => ({
          added: [
            {
              name: "z-folder",
              path: "/tmp/z-folder",
              isDirectory: true,
              size: 0,
              extension: "",
              modifiedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          modified: [
            {
              name: "c.txt",
              path: "/tmp/c.txt",
              isDirectory: false,
              size: 1,
              extension: ".txt",
              modifiedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          unchanged: [
            {
              name: "a.txt",
              path: "/tmp/a.txt",
              isDirectory: false,
              size: 1,
              extension: ".txt",
              modifiedAt: "2026-01-01T00:00:00.000Z",
            },
            {
              name: "b-folder",
              path: "/tmp/b-folder",
              isDirectory: true,
              size: 0,
              extension: "",
              modifiedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          deleted: [],
          totalFiles: 4,
          scanTime: 1,
        })),
        getCacheStats: vi.fn(() => ({ directories: 1, totalFiles: 4, memoryUsage: 512 })),
      }),
      FileEntry: {},
    }));

    const { safeTools } = await import("../ai-tools");

    const result = await safeTools.listDirectory.execute?.({
      path: "/tmp",
      incremental: true,
      includeStats: false,
    } as any, {} as any);

    expect(result).toEqual([
      expect.objectContaining({ name: "b-folder", isDirectory: true }),
      expect.objectContaining({ name: "z-folder", isDirectory: true }),
      expect.objectContaining({ name: "a.txt", isDirectory: false }),
      expect.objectContaining({ name: "c.txt", isDirectory: false }),
    ]);
  });
});

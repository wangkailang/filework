import { EventEmitter } from "node:events";
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
        getCacheStats: vi.fn(() => ({
          directories: 1,
          totalFiles: 4,
          memoryUsage: 512,
        })),
      }),
      FileEntry: {},
    }));

    const { safeTools } = await import("../ai-tools");

    type ListDirArgs = Parameters<
      NonNullable<typeof safeTools.listDirectory.execute>
    >[0];
    type ToolCtx = Parameters<
      NonNullable<typeof safeTools.listDirectory.execute>
    >[1];

    const result = await safeTools.listDirectory.execute?.(
      {
        path: "/tmp",
        incremental: true,
        includeStats: false,
      } satisfies ListDirArgs,
      { toolCallId: "t1", messages: [] } satisfies ToolCtx,
    );

    expect(result).toEqual([
      expect.objectContaining({ name: "b-folder", isDirectory: true }),
      expect.objectContaining({ name: "z-folder", isDirectory: true }),
      expect.objectContaining({ name: "a.txt", isDirectory: false }),
      expect.objectContaining({ name: "c.txt", isDirectory: false }),
    ]);
  });
});

describe("safeTools.runCommand", () => {
  it("returns cancelled result when abortSignal is triggered", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    try {
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.pid = 4242;
      child.stdout = stdout;
      child.stderr = stderr;

      const spawnMock = vi.fn(() => child as unknown);
      vi.doMock("node:child_process", () => ({
        spawn: spawnMock,
      }));

      vi.doMock("../../utils/incremental-scanner", () => ({
        getIncrementalScanner: () => ({
          scanIncremental: vi.fn(async () => ({
            added: [],
            modified: [],
            unchanged: [],
            deleted: [],
            totalFiles: 0,
            scanTime: 1,
          })),
          getCacheStats: vi.fn(() => ({
            directories: 0,
            totalFiles: 0,
            memoryUsage: 0,
          })),
        }),
        FileEntry: {},
      }));

      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation(
          ((_pid: number, _signal?: NodeJS.Signals | number) =>
            true) as typeof process.kill,
        );
      const { safeTools } = await import("../ai-tools");

      const controller = new AbortController();
      type RunCommandArgs = Parameters<
        NonNullable<typeof safeTools.runCommand.execute>
      >[0];
      type RunCommandCtx = Parameters<
        NonNullable<typeof safeTools.runCommand.execute>
      >[1];
      const runPromise = safeTools.runCommand.execute?.(
        {
          command: "npx agent-browser open https://example.com",
        } satisfies RunCommandArgs,
        {
          abortSignal: controller.signal,
          toolCallId: "t1",
          messages: [],
        } satisfies RunCommandCtx,
      );

      controller.abort();
      const result = await runPromise;

      expect(result).toEqual(
        expect.objectContaining({
          exitCode: 130,
        }),
      );
      expect(spawnMock).toHaveBeenCalledWith(
        "npx agent-browser open https://example.com",
        [],
        expect.objectContaining({
          shell: true,
          detached: process.platform !== "win32",
        }),
      );

      if (process.platform !== "win32") {
        expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
        vi.advanceTimersByTime(2000);
        expect(killSpy).toHaveBeenCalledWith(-4242, "SIGKILL");
      }

      killSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

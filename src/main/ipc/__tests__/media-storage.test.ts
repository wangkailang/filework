import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testHome = "";

describe("saveMediaToDisk", () => {
  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), "filework-media-storage-"));
    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => testHome,
    }));
  });

  afterEach(async () => {
    vi.doUnmock("node:os");
    vi.resetModules();
    if (testHome) await rm(testHome, { force: true, recursive: true });
  });

  it("saves base64 data URLs without fetching them over the network", async () => {
    const fetchFn = vi.fn();
    const { saveMediaToDisk } = await import("../media-storage");

    const saved = await saveMediaToDisk(
      fetchFn as unknown as typeof fetch,
      "data:image/png;base64,aW1hZ2U=",
      "session-1",
      "png",
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(await readFile(saved.path, "utf8")).toBe("image");
  });
});

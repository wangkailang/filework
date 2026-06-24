import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileTreePanel } from "../FileTreePanel";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      sidebar_folderNotFound: () => "Folder not found",
      sidebar_openSystemSettings: () => "Open settings",
      sidebar_permissionDenied: () => "Permission denied",
      sidebar_permissionDeniedHint: () => "Grant access",
      sidebar_refresh: () => "Refresh directory",
      sidebar_retry: () => "Retry",
    },
  }),
}));

const entry = (name: string, path: string, isDirectory = false) => ({
  extension: isDirectory ? "" : name.split(".").pop() || "",
  isDirectory,
  modifiedAt: "2026-06-24T00:00:00.000Z",
  name,
  path,
  size: 1,
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

describe("FileTreePanel", () => {
  let root: Root | null = null;
  let container: HTMLElement;
  let listDirectory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const parsed = parseHTML('<div id="root"></div>');
    const document = parsed.document;
    const window = parsed.window;
    listDirectory = vi.fn();
    Object.assign(window, {
      filework: {
        listDirectory,
        openFilesAndFoldersSettings: vi.fn(),
      },
    });
    vi.stubGlobal("window", window);
    vi.stubGlobal("document", document);
    vi.stubGlobal("HTMLElement", window.HTMLElement);
    vi.stubGlobal("navigator", window.navigator);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.getElementById("root") as HTMLElement;
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    root = null;
  });

  it("reloads the tree when the external refresh token changes", async () => {
    listDirectory
      .mockResolvedValueOnce([entry("stale.md", "/workspace/stale.md")])
      .mockResolvedValueOnce([]);

    await act(async () => {
      root?.render(
        <FileTreePanel
          workspacePath="/workspace"
          refreshToken={0}
          onSelectFile={vi.fn()}
        />,
      );
    });
    await flushEffects();

    expect(container.textContent).toContain("stale.md");

    await act(async () => {
      root?.render(
        <FileTreePanel
          workspacePath="/workspace"
          refreshToken={1}
          onSelectFile={vi.fn()}
        />,
      );
    });
    await flushEffects();

    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith("/workspace");
    expect(container.textContent).not.toContain("stale.md");
  });
});

// 文件树面板:由 Sidebar 抽出。懒加载子目录 + 根目录不可访问的错误横幅。
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "../ai-elements/file-tree";

interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

// 对应 src/main/ipc/file-handlers.ts 的 FS_ERROR_TAG。渲染层靠解析
// error.message 识别(IPC 把 Error 拍平成字符串)。
const FS_ERROR_TAG_PERMISSION_DENIED = "FS_PERMISSION_DENIED";
const FS_ERROR_TAG_NOT_FOUND = "FS_NOT_FOUND";

type ListError =
  | { kind: "permission"; path: string }
  | { kind: "not-found"; path: string }
  | { kind: "other"; message: string };

const classifyListError = (err: unknown): ListError => {
  const msg = err instanceof Error ? err.message : String(err);
  const permMatch = msg.match(
    new RegExp(`\\[${FS_ERROR_TAG_PERMISSION_DENIED}\\]\\s*(.*)`),
  );
  if (permMatch) return { kind: "permission", path: permMatch[1].trim() };
  const notFoundMatch = msg.match(
    new RegExp(`\\[${FS_ERROR_TAG_NOT_FOUND}\\]\\s*(.*)`),
  );
  if (notFoundMatch)
    return { kind: "not-found", path: notFoundMatch[1].trim() };
  return { kind: "other", message: msg };
};

export const FileTreePanel = ({
  workspacePath,
  onSelectFile,
}: {
  workspacePath: string;
  onSelectFile: (path: string) => void;
}) => {
  const { LL } = useI18nContext();
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, FileInfo[]>>(
    {},
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const [rootError, setRootError] = useState<ListError | null>(null);

  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      const isDir =
        files.some((f) => f.path === path && f.isDirectory) ||
        Object.values(childrenMap).some((children) =>
          children.some((f) => f.path === path && f.isDirectory),
        );
      if (!isDir) onSelectFile(path);
    },
    [files, childrenMap, onSelectFile],
  );

  useEffect(() => {
    const loadFiles = async () => {
      try {
        const entries = await window.filework.listDirectory(workspacePath);
        setFiles(entries);
        setRootError(null);
      } catch (err) {
        setFiles([]);
        setRootError(classifyListError(err));
      }
    };
    loadFiles();
  }, [workspacePath]);

  const handleExpandedChange = useCallback(
    async (newExpanded: Set<string>) => {
      setExpandedPaths(newExpanded);
      for (const path of newExpanded) {
        if (!childrenMap[path]) {
          try {
            const entries = await window.filework.listDirectory(path);
            setChildrenMap((prev) => ({ ...prev, [path]: entries }));
          } catch {
            setChildrenMap((prev) => ({ ...prev, [path]: [] }));
          }
        }
      }
    },
    [childrenMap],
  );

  const handleRefresh = useCallback(async () => {
    try {
      const entries = await window.filework.listDirectory(workspacePath);
      setFiles(entries);
      setRootError(null);
    } catch (err) {
      setFiles([]);
      setRootError(classifyListError(err));
      return;
    }
    const newChildrenMap: Record<string, FileInfo[]> = {};
    for (const path of expandedPaths) {
      try {
        newChildrenMap[path] = await window.filework.listDirectory(path);
      } catch {
        newChildrenMap[path] = [];
      }
    }
    setChildrenMap(newChildrenMap);
  }, [workspacePath, expandedPaths]);

  const handleGrantAccess = useCallback(() => {
    window.filework.openFilesAndFoldersSettings();
  }, []);

  const renderEntries = (entries: FileInfo[]) =>
    entries.map((file) =>
      file.isDirectory ? (
        <FileTreeFolder key={file.path} path={file.path} name={file.name}>
          {childrenMap[file.path]
            ? renderEntries(childrenMap[file.path])
            : null}
        </FileTreeFolder>
      ) : (
        <FileTreeFile key={file.path} path={file.path} name={file.name} />
      ),
    );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end px-2 py-1">
        <button
          type="button"
          onClick={handleRefresh}
          className="rounded p-1 hover:bg-accent"
          title={LL.sidebar_refresh()}
        >
          <RefreshCw className="size-3.5 text-muted-foreground" />
        </button>
      </div>

      {rootError && (
        <div
          className={
            rootError.kind === "permission"
              ? "mx-2 mt-1 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
              : "mx-2 mt-1 rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          }
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {rootError.kind === "permission"
                  ? LL.sidebar_permissionDenied()
                  : rootError.kind === "not-found"
                    ? LL.sidebar_folderNotFound()
                    : rootError.message}
              </div>
              {rootError.kind === "permission" && (
                <div className="mt-1 leading-snug opacity-90">
                  {LL.sidebar_permissionDeniedHint()}
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-2">
                {rootError.kind === "permission" && (
                  <button
                    type="button"
                    onClick={handleGrantAccess}
                    className="rounded bg-amber-500/20 px-2 py-1 font-medium transition-colors hover:bg-amber-500/30"
                  >
                    {LL.sidebar_openSystemSettings()}
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleRefresh}
                  className="rounded bg-muted px-2 py-1 font-medium transition-colors hover:bg-accent"
                >
                  {LL.sidebar_retry()}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-1 py-2">
        <FileTree
          expanded={expandedPaths}
          onExpandedChange={handleExpandedChange}
          selectedPath={selectedPath}
          onSelect={handleSelect}
        >
          {renderEntries(files)}
        </FileTree>
      </div>
    </div>
  );
};

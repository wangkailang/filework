import {
  Blocks,
  ChevronRight,
  FolderOpen,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { Locales } from "../../i18n/i18n-types";
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "../ai-elements/file-tree";
import { SkillsModal } from "../skills/SkillsModal";
import { SettingsModal } from "./SettingsModal";

interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  extension: string;
  modifiedAt: string;
}

interface SidebarProps {
  workspacePath: string;
  onChangeDirectory: (path: string) => void;
  onCloseDirectory: () => void;
  onLocaleChange: (locale: Locales) => void;
  onSelectFile: (path: string) => void;
}

export const Sidebar = ({
  workspacePath,
  onChangeDirectory,
  onCloseDirectory,
  onLocaleChange,
  onSelectFile,
}: SidebarProps) => {
  const { LL } = useI18nContext();
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [childrenMap, setChildrenMap] = useState<Record<string, FileInfo[]>>(
    {},
  );
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | undefined>();

  const handleSelect = useCallback(
    (path: string) => {
      setSelectedPath(path);
      // Only trigger file open for non-directory entries
      const isDir =
        files.some((f) => f.path === path && f.isDirectory) ||
        Object.values(childrenMap).some((children) =>
          children.some((f) => f.path === path && f.isDirectory),
        );
      if (!isDir) {
        onSelectFile(path);
      }
    },
    [files, childrenMap, onSelectFile],
  );

  useEffect(() => {
    const loadFiles = async () => {
      const entries = await window.filework.listDirectory(workspacePath);
      setFiles(entries);
    };
    loadFiles();
  }, [workspacePath]);

  const handleExpandedChange = useCallback(
    async (newExpanded: Set<string>) => {
      setExpandedPaths(newExpanded);
      // Load children for newly expanded folders
      for (const path of newExpanded) {
        if (!childrenMap[path]) {
          const entries = await window.filework.listDirectory(path);
          setChildrenMap((prev) => ({ ...prev, [path]: entries }));
        }
      }
    },
    [childrenMap],
  );

  const openDirectory = () => {
    window.filework.showInFinder(workspacePath);
  };

  const handleRefresh = useCallback(async () => {
    const entries = await window.filework.listDirectory(workspacePath);
    setFiles(entries);
    // Reload children for currently expanded folders
    const newChildrenMap: Record<string, FileInfo[]> = {};
    for (const path of expandedPaths) {
      const children = await window.filework.listDirectory(path);
      newChildrenMap[path] = children;
    }
    setChildrenMap(newChildrenMap);
  }, [workspacePath, expandedPaths]);

  // Listen for programmatic settings open (e.g. from error actions)
  useEffect(() => {
    const handler = () => {
      setSettingsOpen(true);
    };
    window.addEventListener("filework:open-settings", handler);
    return () => window.removeEventListener("filework:open-settings", handler);
  }, []);

  const dirName = workspacePath.split("/").pop() || workspacePath;

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

  if (collapsed) {
    return (
      <div className="w-12 h-full bg-muted/50 border-r border-border flex flex-col items-center pt-14 gap-2">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="p-2 rounded-md hover:bg-accent transition-colors"
          title={LL.sidebar_collapse()}
        >
          <ChevronRight className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <>
      <aside className="w-64 h-full bg-muted/30 border-r border-border flex flex-col pt-12">
        {/* Workspace header */}
        <div className="titlebar-no-drag flex items-center justify-between px-3 py-2 border-b border-border">
          <button
            type="button"
            onClick={openDirectory}
            className="flex items-center gap-2 text-sm font-medium text-foreground hover:text-primary transition-colors truncate flex-1 min-w-0"
            title={workspacePath}
          >
            <FolderOpen className="w-4 h-4 text-file-folder shrink-0" />
            <span className="truncate">{dirName}</span>
          </button>
          <div className="flex items-center shrink-0 ml-1">
            <button
              type="button"
              onClick={handleRefresh}
              className="p-1 rounded hover:bg-accent transition-colors"
              title="刷新目录"
            >
              <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
            <button
              type="button"
              onClick={onCloseDirectory}
              className="p-1 rounded hover:bg-accent transition-colors"
              title="关闭目录"
            >
              <X className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* File tree */}
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

        {/* Bottom actions */}
        <div className="titlebar-no-drag border-t border-border px-3 py-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSkillsOpen(true)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <Blocks className="w-4 h-4" />
            技能
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors ml-auto"
          >
            <Settings className="w-4 h-4" />
            {LL.sidebar_settings()}
          </button>
        </div>
      </aside>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onLocaleChange={onLocaleChange}
      />

      <SkillsModal open={skillsOpen} onClose={() => setSkillsOpen(false)} />
    </>
  );
};

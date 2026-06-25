// Diff 左侧文件树:把变更文件按目录组织成可折叠的树,带筛选框。点击文件
// 切换右侧单文件 diff。单子目录链会合并显示(src/renderer 这种)。
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  FileX,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  GitFileDiff,
  GitFileStatus,
} from "../../../main/core/git-diff/types";
import { cn } from "../../lib/utils";

interface TreeNode {
  /** 显示名(目录可能是合并后的 a/b/c)。 */
  name: string;
  /** 完整路径,作为 key 与折叠状态键。 */
  path: string;
  /** 文件节点携带其 diff;目录节点为空。 */
  file?: GitFileDiff;
  children: TreeNode[];
}

interface MutNode {
  name: string;
  path: string;
  file?: GitFileDiff;
  children: Map<string, MutNode>;
}

function buildTree(files: GitFileDiff[]): TreeNode[] {
  const root: MutNode = { name: "", path: "", children: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: acc, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.file = file;
      node = child;
    });
  }
  return root.children.size
    ? [...root.children.values()].map(collapse).sort(compareNodes)
    : [];
}

/** 合并单子目录链(src → renderer 折成 src/renderer),并递归处理子节点。 */
function collapse(node: MutNode): TreeNode {
  let name = node.name;
  let cur = node;
  while (!cur.file && cur.children.size === 1) {
    const only = [...cur.children.values()][0];
    if (only.file) break; // 不把文件并进目录名
    name = `${name}/${only.name}`;
    cur = only;
  }
  const children = [...cur.children.values()].map(collapse).sort(compareNodes);
  return { name, path: cur.path, file: cur.file, children };
}

/** 目录在前、文件在后,各自按名称排序。 */
function compareNodes(a: TreeNode, b: TreeNode): number {
  const aDir = !a.file;
  const bDir = !b.file;
  if (aDir !== bDir) return aDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function statusIcon(status: GitFileStatus) {
  if (status === "added") return FilePlus;
  if (status === "deleted") return FileX;
  return FileText;
}

function statusColor(status: GitFileStatus): string {
  if (status === "added") return "text-emerald-500";
  if (status === "deleted") return "text-red-400";
  if (status === "renamed") return "text-amber-400";
  return "text-muted-foreground";
}

export function BranchDiffFileTree({
  files,
  activePath,
  onSelect,
  filterPlaceholder,
}: {
  files: GitFileDiff[];
  activePath: string | null;
  onSelect: (path: string) => void;
  filterPlaceholder: string;
}) {
  const [query, setQuery] = useState("");
  // 折叠的目录路径集合(默认全展开)。
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? files.filter((f) => f.path.toLowerCase().includes(q))
      : files;
    return buildTree(filtered);
  }, [files, query]);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div
      data-branch-diff-file-tree="true"
      className="flex w-60 shrink-0 flex-col border-r border-border bg-card/50"
    >
      <div className="border-b border-border p-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={filterPlaceholder}
          className="w-full rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-1">
        {tree.map((node) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={0}
            collapsed={collapsed}
            onToggleDir={toggleDir}
            activePath={activePath}
            onSelect={onSelect}
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  collapsed,
  onToggleDir,
  activePath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleDir: (path: string) => void;
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  const pad = { paddingLeft: `${depth * 12 + 6}px` };

  if (node.file) {
    const Icon = statusIcon(node.file.status);
    const active = activePath === node.path;
    return (
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        data-branch-diff-tree-file="true"
        style={pad}
        title={node.path}
        className={cn(
          "flex w-full items-center gap-1.5 rounded py-1 pr-2 text-left text-xs transition-colors",
          active
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon
          className={cn("size-3.5 shrink-0", statusColor(node.file.status))}
        />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }

  const isCollapsed = collapsed.has(node.path);
  return (
    <>
      <button
        type="button"
        onClick={() => onToggleDir(node.path)}
        style={pad}
        title={node.path}
        className="flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-xs text-foreground/80 transition-colors hover:bg-accent"
      >
        {isCollapsed ? (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate font-medium">{node.name}</span>
      </button>
      {!isCollapsed &&
        node.children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            collapsed={collapsed}
            onToggleDir={onToggleDir}
            activePath={activePath}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

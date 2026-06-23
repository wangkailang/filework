import { GitBranch, PanelRight, RefreshCw } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { cn } from "../../lib/utils";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { BranchDiffFileCard } from "./BranchDiffFileCard";
import { BranchDiffFileTree } from "./BranchDiffFileTree";
import { useBranchDiff } from "./useBranchDiff";

/** 在分支列表里挑一个合理的默认对比基线:main > master > 首个非当前分支。 */
function pickDefaultBase(
  branches: string[],
  currentBranch?: string | null,
): string {
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  const other = branches.find((b) => b !== currentBranch);
  return other ?? branches[0] ?? "main";
}

interface BranchDiffPanelProps {
  /** Workspace root absolute path. Empty/undefined → empty state. */
  workspaceRoot?: string;
  /** Current checked-out branch. Threaded into the hook so a
   *  BranchSwitcher checkout invalidates the cache immediately. */
  currentBranch?: string | null;
  /** Controlled compare base owned by the dock host so close/reopen keeps it. */
  baseBranch?: string | null;
  /** Called when the user selects a new compare base. */
  onBaseBranchChange?: (branch: string) => void;
  /** Bump to force a refetch from outside (eg after a tool finishes). */
  invalidator?: number;
}

/**
 * 分支 diff 内容,宿主于 ContextDock 的「Diff」标签。宽度与关闭由 Dock
 * 统一控制,这里只填满父容器并渲染标题摘要 + 文件卡片。
 */
export function BranchDiffPanel({
  workspaceRoot,
  currentBranch,
  baseBranch: controlledBaseBranch,
  onBaseBranchChange,
  invalidator,
}: BranchDiffPanelProps) {
  const { LL } = useI18nContext();

  // 可选对比基线:优先使用 dock host 传入的受控值;未受控时保留本地 state。
  const [branches, setBranches] = useState<string[]>([]);
  const [uncontrolledBase, setUncontrolledBase] = useState<string | null>(null);
  const baseBranch =
    controlledBaseBranch ??
    uncontrolledBase ??
    pickDefaultBase(branches, currentBranch);
  const handleBaseBranchChange = useCallback(
    (branch: string) => {
      if (onBaseBranchChange) {
        onBaseBranchChange(branch);
      } else {
        setUncontrolledBase(branch);
      }
    },
    [onBaseBranchChange],
  );

  // 拉取本地分支列表(远程工作区也克隆在本地,故统一走 local.listBranches)。
  // currentBranch 变化(切换/提交后)重新拉取,使列表保持最新。
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentBranch 仅作刷新触发器,不在体内读取
  useEffect(() => {
    if (!workspaceRoot) {
      setBranches([]);
      return;
    }
    let alive = true;
    window.filework.local
      .listBranches({ path: workspaceRoot })
      .then((list: { name: string }[]) => {
        if (alive) setBranches(list.map((b) => b.name));
      })
      .catch(() => {
        if (alive) setBranches([]);
      });
    return () => {
      alive = false;
    };
  }, [workspaceRoot, currentBranch]);

  const { data, loading, error, refresh } = useBranchDiff({
    path: workspaceRoot,
    baseBranch,
    currentBranch,
    invalidator,
  });

  // 文件树:可收起(持久化),点击文件滚动定位到左侧对应卡片并高亮。
  const [treeCollapsed, setTreeCollapsed] = useState<boolean>(
    () => localStorage.getItem("filework-diff-tree-collapsed") === "1",
  );
  const toggleTree = useCallback(() => {
    setTreeCollapsed((v) => {
      const next = !v;
      localStorage.setItem("filework-diff-tree-collapsed", next ? "1" : "0");
      return next;
    });
  }, []);
  const [activePath, setActivePath] = useState<string | null>(null);
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const registerRef = (path: string, el: HTMLDivElement | null) => {
    if (el) cardRefs.current.set(path, el);
    else cardRefs.current.delete(path);
  };
  const handleSelectFile = (path: string) => {
    setActivePath(path);
    cardRefs.current
      .get(path)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const hasFiles = !!data && !data.notAvailable && data.files.length > 0;

  return (
    <div className="flex h-full w-full flex-col bg-background">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {data?.headBranch
              ? LL.branch_diff_title(
                  data.headBranch,
                  data.baseRef ?? data.baseBranch,
                )
              : LL.branch_diff_open()}
          </div>
          {data && !data.notAvailable && (
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
              <span>
                <span className="text-emerald-500">+{data.totalAdded}</span>{" "}
                <span className="text-red-400">-{data.totalRemoved}</span>
              </span>
              <span className="text-muted-foreground/70">
                {data.base === data.head
                  ? `@${data.base.slice(0, 7)}`
                  : `${data.base.slice(0, 7)}…${data.head.slice(0, 7)}`}
              </span>
              <StatusBadges data={data} LL={LL} />
            </div>
          )}
        </div>
        {branches.length > 0 && (
          <BaseBranchSelect
            value={baseBranch}
            branches={branches}
            currentBranch={currentBranch}
            onChange={handleBaseBranchChange}
            label={LL.branch_diff_compareBase()}
          />
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          title={LL.branch_diff_refresh()}
        >
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </button>
        {hasFiles && (
          <button
            type="button"
            onClick={toggleTree}
            className="rounded-md p-1.5 hover:bg-accent"
            title={LL.branch_diff_toggleTree()}
            aria-pressed={!treeCollapsed}
          >
            <PanelRight
              className={cn(
                "size-3.5",
                treeCollapsed ? "text-muted-foreground" : "text-primary",
              )}
            />
          </button>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex-1 space-y-1.5 overflow-y-auto p-3">
          {renderBody({ data, loading, error, LL, registerRef, activePath })}
        </div>
        {hasFiles && !treeCollapsed && data && (
          <BranchDiffFileTree
            files={data.files}
            activePath={activePath}
            onSelect={handleSelectFile}
            filterPlaceholder={LL.branch_diff_filterFiles()}
          />
        )}
      </div>
    </div>
  );
}

/** 对比基线下拉:点击切换 base 分支,选中项即时驱动 useBranchDiff(各 base 有缓存)。 */
function BaseBranchSelect({
  value,
  branches,
  currentBranch,
  onChange,
  label,
}: {
  value: string;
  branches: string[];
  currentBranch?: string | null;
  onChange: (branch: string) => void;
  label: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        title={label}
        className="h-7 max-w-[140px] gap-1 rounded-md border-border bg-muted/60 px-2 text-[11px] text-muted-foreground hover:border-primary/40 hover:text-foreground"
      >
        <GitBranch className="size-3 shrink-0" />
        <SelectValue aria-label={value}>
          <span className="truncate font-mono">{value}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent align="end" className="max-h-72 w-52">
        <SelectGroup>
          <SelectLabel>{label}</SelectLabel>
          {branches.map((b) => (
            <SelectItem key={b} value={b} className="font-mono text-xs">
              <span className="truncate">{b}</span>
              {b === currentBranch && (
                <span className="ml-auto shrink-0 rounded bg-muted px-1 py-0.5 font-sans text-[9px] text-muted-foreground">
                  HEAD
                </span>
              )}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

interface StatusBadgesProps {
  data: NonNullable<ReturnType<typeof useBranchDiff>["data"]>;
  LL: ReturnType<typeof useI18nContext>["LL"];
}

function StatusBadges({ data, LL }: StatusBadgesProps) {
  const items: ReactNode[] = [];
  if (data.uncommitted !== undefined && data.uncommitted > 0) {
    items.push(
      <span
        key="uncommitted"
        className="px-1.5 rounded bg-amber-500/15 text-amber-400 normal-case"
      >
        {LL.branch_diff_uncommitted(data.uncommitted)}
      </span>,
    );
  }
  if (data.ahead !== undefined && data.ahead > 0) {
    items.push(
      <span
        key="ahead"
        className="px-1.5 rounded bg-emerald-500/15 text-emerald-400 normal-case"
      >
        {LL.branch_diff_ahead(data.ahead)}
      </span>,
    );
  }
  if (data.behind !== undefined && data.behind > 0) {
    items.push(
      <span
        key="behind"
        className="px-1.5 rounded bg-red-500/15 text-red-400 normal-case"
      >
        {LL.branch_diff_behind(data.behind)}
      </span>,
    );
  }
  return items.length > 0 ? items : null;
}

interface BodyArgs {
  data: ReturnType<typeof useBranchDiff>["data"];
  loading: boolean;
  error: string | null;
  LL: ReturnType<typeof useI18nContext>["LL"];
  /** 注册/注销每个文件卡片的 DOM 节点,供文件树点击时滚动定位。 */
  registerRef: (path: string, el: HTMLDivElement | null) => void;
  /** 当前在文件树中选中的文件路径(用于卡片高亮)。 */
  activePath: string | null;
}

function renderBody({
  data,
  loading,
  error,
  LL,
  registerRef,
  activePath,
}: BodyArgs): ReactNode {
  if (loading && !data) {
    return <div className="text-xs text-muted-foreground italic">…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-400">{error}</div>;
  }
  if (!data) {
    return null;
  }
  if (data.notAvailable === "not-git") {
    return (
      <div className="text-xs text-muted-foreground italic">
        {LL.branch_diff_not_git()}
      </div>
    );
  }
  if (data.notAvailable === "no-base") {
    return (
      <div className="text-xs text-muted-foreground italic">
        {LL.branch_diff_no_base()}
        {data.errorMessage && (
          <div className="mt-1 font-mono text-[10px] text-foreground/60">
            {data.errorMessage}
          </div>
        )}
      </div>
    );
  }
  if (data.notAvailable) {
    return (
      <div className="text-xs text-red-400">
        {LL.branch_diff_exec_failed()}
        {data.errorMessage && (
          <div className="mt-1 font-mono text-[10px] text-foreground/60">
            {data.errorMessage}
          </div>
        )}
      </div>
    );
  }
  if (data.files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground italic">
        {LL.branch_diff_empty()}
      </div>
    );
  }
  return (
    <>
      {data.truncated && (
        <div className="text-xs text-amber-400 mb-1">
          {LL.preview_diff_truncated()}
        </div>
      )}
      {data.files.map((f) => (
        <div
          key={`${f.status}-${f.path}`}
          ref={(el) => registerRef(f.path, el)}
          className={cn(
            "scroll-mt-2 rounded-md",
            activePath === f.path && "ring-1 ring-primary/40",
          )}
        >
          <BranchDiffFileCard file={f} LL={LL} />
        </div>
      ))}
    </>
  );
}

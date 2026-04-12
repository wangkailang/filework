import { ArrowLeft, Blocks, ExternalLink, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/utils";

type SourceType = "built-in" | "project" | "personal" | "additional";
type FilterType = "all" | SourceType;

interface SkillExternalInfo {
  context: "default" | "fork";
  allowedTools: string[];
  userInvocable: boolean;
  disableModelInvocation: boolean;
  requires?: {
    bins?: string[];
    env?: string[];
    os?: string[];
    pip?: string[];
  };
  hasHooks: boolean;
  sourcePath: string;
}

interface SkillListItem {
  id: string;
  name: string;
  description: string;
  source: SourceType;
  category: "tool" | "task";
  keywords: string[];
  suggestions: string[];
  isExternal: boolean;
  external?: SkillExternalInfo;
}

interface SkillDetailData extends SkillListItem {
  systemPrompt?: string;
  external?: SkillExternalInfo & { body?: string };
}

const SOURCE_LABELS: Record<SourceType, string> = {
  "built-in": "内置",
  project: "项目",
  personal: "个人",
  additional: "扩展",
};

const SOURCE_COLORS: Record<SourceType, string> = {
  "built-in": "bg-blue-500/10 text-blue-500",
  project: "bg-green-500/10 text-green-500",
  personal: "bg-purple-500/10 text-purple-500",
  additional: "bg-amber-500/10 text-amber-500",
};

interface SkillsModalProps {
  open: boolean;
  onClose: () => void;
}

export const SkillsModal = ({ open, onClose }: SkillsModalProps) => {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailData | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch skill list when modal opens
  useEffect(() => {
    if (!open) return;
    setSelectedSkillId(null);
    setDetail(null);
    let cancelled = false;
    window.filework.listSkills().then((list: SkillListItem[]) => {
      if (!cancelled) setSkills(list ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Fetch detail when a skill is selected
  useEffect(() => {
    if (!selectedSkillId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    window.filework
      .getSkillDetail(selectedSkillId)
      .then((d: SkillDetailData | null) => {
        if (!cancelled) {
          setDetail(d);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSkillId]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (selectedSkillId) setSelectedSkillId(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, selectedSkillId]);

  const filtered = skills.filter((s) => {
    if (filter !== "all" && s.source !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // Collect available source types for filter tabs
  const availableSources = Array.from(new Set(skills.map((s) => s.source)));

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <button
        type="button"
        className="absolute inset-0 bg-black/50 cursor-default"
        onClick={onClose}
        aria-label="Close skills"
      />
      <div className="relative bg-background border border-border rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            {selectedSkillId && (
              <button
                type="button"
                onClick={() => setSelectedSkillId(null)}
                className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors mr-1"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <Blocks className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-base font-medium text-foreground">
              {selectedSkillId ? (detail?.name ?? "...") : "技能管理"}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {selectedSkillId ? (
          <SkillDetailView detail={detail} loading={loading} />
        ) : (
          <SkillListView
            skills={filtered}
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            availableSources={availableSources}
            onSelect={setSelectedSkillId}
          />
        )}
      </div>
    </div>
  );
};

/* ── Skill List View ─────────────────────────────────────────────── */

const SkillListView = ({
  skills,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  availableSources,
  onSelect,
}: {
  skills: SkillListItem[];
  filter: FilterType;
  onFilterChange: (f: FilterType) => void;
  search: string;
  onSearchChange: (s: string) => void;
  availableSources: SourceType[];
  onSelect: (id: string) => void;
}) => (
  <>
    {/* Search + Filters */}
    <div className="px-6 pt-4 pb-2 space-y-3 shrink-0">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          type="text"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="搜索技能..."
          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <FilterTab
          active={filter === "all"}
          onClick={() => onFilterChange("all")}
        >
          全部 ({skills.length})
        </FilterTab>
        {availableSources.map((src) => (
          <FilterTab
            key={src}
            active={filter === src}
            onClick={() => onFilterChange(src)}
          >
            {SOURCE_LABELS[src]}
          </FilterTab>
        ))}
      </div>
    </div>

    {/* List */}
    <div className="flex-1 overflow-y-auto px-6 pb-4">
      {skills.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          未找到匹配的技能
        </div>
      ) : (
        <div className="space-y-2 pt-1">
          {skills.map((skill) => (
            <SkillCard
              key={skill.id}
              skill={skill}
              onClick={() => onSelect(skill.id)}
            />
          ))}
        </div>
      )}
    </div>
  </>
);

const FilterTab = ({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cn(
      "px-2.5 py-1 text-xs rounded-md border transition-colors",
      active
        ? "border-primary bg-primary/10 text-primary"
        : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
    )}
  >
    {children}
  </button>
);

/* ── Skill Card ──────────────────────────────────────────────────── */

const SkillCard = ({
  skill,
  onClick,
}: {
  skill: SkillListItem;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full text-left rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors group"
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-medium text-sm text-foreground truncate">
            {skill.name}
          </span>
          <span
            className={cn(
              "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
              SOURCE_COLORS[skill.source],
            )}
          >
            {SOURCE_LABELS[skill.source]}
          </span>
          <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
            {skill.category === "task" ? "任务" : "工具"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {skill.description}
        </p>
      </div>
      <span className="shrink-0 font-mono text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
        {skill.isExternal ? `/${skill.id}` : "自动匹配"}
      </span>
    </div>
    {skill.keywords.length > 0 && (
      <div className="flex flex-wrap gap-1 mt-2">
        {skill.keywords.slice(0, 6).map((kw) => (
          <span
            key={kw}
            className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {kw}
          </span>
        ))}
        {skill.keywords.length > 6 && (
          <span className="text-[10px] text-muted-foreground">
            +{skill.keywords.length - 6}
          </span>
        )}
      </div>
    )}
  </button>
);

/* ── Skill Detail View ───────────────────────────────────────────── */

const SkillDetailView = ({
  detail,
  loading,
}: {
  detail: SkillDetailData | null;
  loading: boolean;
}) => {
  if (loading || !detail) {
    return (
      <div className="flex-1 flex items-center justify-center py-12 text-sm text-muted-foreground">
        {loading ? "加载中..." : "未找到技能信息"}
      </div>
    );
  }

  const ext = detail.external;

  return (
    <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
      {/* Badges */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={cn(
            "rounded px-2 py-0.5 text-xs font-medium",
            SOURCE_COLORS[detail.source],
          )}
        >
          {SOURCE_LABELS[detail.source]}
        </span>
        <span className="rounded px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
          {detail.category === "task" ? "任务型" : "工具型"}
        </span>
        {ext?.context === "fork" && (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-600">
            独立上下文
          </span>
        )}
        {ext?.disableModelInvocation && (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-red-500/10 text-red-500">
            仅手动触发
          </span>
        )}
      </div>

      {/* Description */}
      <Section title="描述">
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
          {detail.description}
        </p>
      </Section>

      {/* Usage */}
      <Section title="使用方式">
        {detail.isExternal ? (
          <code className="block text-sm bg-muted rounded-md px-3 py-2 text-foreground">
            /{detail.id} &lt;你的指令&gt;
          </code>
        ) : (
          <p className="text-sm text-muted-foreground">
            在对话中直接描述需求即可，AI 会根据关键词自动匹配此技能。
          </p>
        )}
      </Section>

      {/* Suggestions */}
      {detail.suggestions.length > 0 && (
        <Section title="建议提示词">
          <div className="space-y-1.5">
            {detail.suggestions.map((s) => (
              <div
                key={s}
                className="text-sm text-muted-foreground bg-muted/50 rounded-md px-3 py-1.5"
              >
                {s}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Keywords */}
      {detail.keywords.length > 0 && (
        <Section title="关键词">
          <div className="flex flex-wrap gap-1.5">
            {detail.keywords.map((kw) => (
              <span
                key={kw}
                className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground"
              >
                {kw}
              </span>
            ))}
          </div>
        </Section>
      )}

      {/* External skill metadata */}
      {ext && (
        <>
          {/* Source path */}
          <Section title="来源路径">
            <div className="flex items-center gap-2">
              <code className="text-xs bg-muted rounded px-2 py-1 text-muted-foreground break-all flex-1">
                {ext.sourcePath}
              </code>
              <button
                type="button"
                onClick={() => window.filework.showInFinder(ext.sourcePath)}
                className="shrink-0 p-1 rounded hover:bg-accent transition-colors"
                title="在 Finder 中显示"
              >
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </Section>

          {/* Allowed tools */}
          {ext.allowedTools.length > 0 && (
            <Section title="允许的工具">
              <div className="flex flex-wrap gap-1.5">
                {ext.allowedTools.map((t) => (
                  <span
                    key={t}
                    className="rounded-md bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </Section>
          )}

          {/* Requirements */}
          {ext.requires && (
            <Section title="运行依赖">
              <div className="space-y-1.5 text-xs">
                {ext.requires.bins && ext.requires.bins.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0 w-12">
                      命令
                    </span>
                    <span className="font-mono text-foreground">
                      {ext.requires.bins.join(", ")}
                    </span>
                  </div>
                )}
                {ext.requires.pip && ext.requires.pip.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0 w-12">
                      pip
                    </span>
                    <span className="font-mono text-foreground">
                      {ext.requires.pip.join(", ")}
                    </span>
                  </div>
                )}
                {ext.requires.env && ext.requires.env.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0 w-12">
                      环境变量
                    </span>
                    <span className="font-mono text-foreground">
                      {ext.requires.env.join(", ")}
                    </span>
                  </div>
                )}
                {ext.requires.os && ext.requires.os.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0 w-12">
                      系统
                    </span>
                    <span className="font-mono text-foreground">
                      {ext.requires.os.join(", ")}
                    </span>
                  </div>
                )}
              </div>
            </Section>
          )}

          {ext.hasHooks && (
            <Section title="生命周期">
              <p className="text-xs text-muted-foreground">
                此技能包含 pre-activate / post-complete 钩子脚本
              </p>
            </Section>
          )}
        </>
      )}
    </div>
  );
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div>
    <h3 className="text-xs font-medium text-foreground mb-1.5">{title}</h3>
    {children}
  </div>
);

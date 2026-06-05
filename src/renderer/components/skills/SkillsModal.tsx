import { ArrowLeft, Blocks, ExternalLink, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import type { TranslationFunctions } from "../../i18n/i18n-types";
import { cn } from "../../lib/utils";

type SourceType = "built-in" | "project" | "personal" | "additional";
type FilterType = "all" | SourceType | "market";

// 市场条目结构
interface MarketItem {
  id: string;
  name: string;
  description: string;
  level: "official" | "community";
  installed: boolean;
  source: unknown;
}

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
  /**
   * Whether the skill is currently registered into the runtime.
   * Optional only because `ai:getSkillDetail` (used in the detail view)
   * does not currently echo this field — list responses always set it.
   */
  enabled?: boolean;
  /** Whether the skill passed eligibility checks at discovery time. */
  eligible?: boolean;
  ineligibleReason?: string;
  external?: SkillExternalInfo;
}

interface SkillDetailData extends SkillListItem {
  systemPrompt?: string;
  external?: SkillExternalInfo & { body?: string };
}

const getSourceLabels = (
  LL: TranslationFunctions,
): Record<SourceType, string> => ({
  "built-in": LL.skillsModal_sourceBuiltIn(),
  project: LL.skillsModal_sourceProject(),
  personal: LL.skillsModal_sourcePersonal(),
  additional: LL.skillsModal_sourceAdditional(),
});

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
  const { LL } = useI18nContext();
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [filter, setFilter] = useState<FilterType>("all");
  const [search, setSearch] = useState("");
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailData | null>(null);
  const [loading, setLoading] = useState(false);

  // 市场状态
  const [market, setMarket] = useState<MarketItem[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const isMarket = filter === "market";

  const refreshSkills = useCallback(async () => {
    const list = (await window.filework.listAllSkills()) as
      | SkillListItem[]
      | undefined;
    setSkills(list ?? []);
  }, []);

  // 市场 tab 打开时加载条目
  useEffect(() => {
    if (!open || !isMarket) return;
    let cancelled = false;
    setMarketLoading(true);
    setMarketError(null);
    void (async () => {
      const res = (await window.filework.marketList()) as {
        ok: boolean;
        error?: string;
        entries: MarketItem[];
      };
      if (cancelled) return;
      if (res.ok) setMarket(res.entries);
      else setMarketError(res.error ?? "error");
      setMarketLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, isMarket]);

  // 安装市场 skill(community 需弹窗确认)
  const handleInstall = useCallback(
    async (item: MarketItem) => {
      if (item.level === "community") {
        if (!window.confirm(LL.skillsModal_marketConfirmCommunity())) return;
      }
      setInstallingId(item.id);
      const res = (await window.filework.marketInstall(item)) as {
        ok: boolean;
        error?: string;
      };
      setInstallingId(null);
      if (res.ok) {
        setMarket((prev) =>
          prev.map((m) => (m.id === item.id ? { ...m, installed: true } : m)),
        );
        await refreshSkills();
      } else {
        console.warn("[market] install failed:", res.error);
      }
    },
    [LL, refreshSkills],
  );

  // 卸载市场 skill
  const handleUninstall = useCallback(
    async (skillId: string) => {
      const res = (await window.filework.marketUninstall(skillId)) as {
        ok: boolean;
      };
      if (res.ok) {
        setMarket((prev) =>
          prev.map((m) => (m.id === skillId ? { ...m, installed: false } : m)),
        );
        await refreshSkills();
      }
    },
    [refreshSkills],
  );

  // Fetch skill list when modal opens
  useEffect(() => {
    if (!open) return;
    setSelectedSkillId(null);
    setDetail(null);
    let cancelled = false;
    void (async () => {
      const list = (await window.filework.listAllSkills()) as
        | SkillListItem[]
        | undefined;
      if (!cancelled) setSkills(list ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSkillToggle = useCallback(
    async (skillId: string, next: boolean) => {
      // Optimistic local update — flip the enabled flag immediately so
      // the switch feels instant; we re-fetch on success for source of
      // truth, and roll back on failure.
      setSkills((prev) =>
        prev.map((s) => (s.id === skillId ? { ...s, enabled: next } : s)),
      );
      setDetail((prev) =>
        prev && prev.id === skillId ? { ...prev, enabled: next } : prev,
      );
      const res = (await window.filework.setSkillEnabled(skillId, next)) as {
        ok: boolean;
        error?: string;
      };
      if (!res?.ok) {
        setSkills((prev) =>
          prev.map((s) => (s.id === skillId ? { ...s, enabled: !next } : s)),
        );
        setDetail((prev) =>
          prev && prev.id === skillId ? { ...prev, enabled: !next } : prev,
        );
        console.warn("[SkillsModal] setSkillEnabled failed:", res?.error);
        return;
      }
      await refreshSkills();
    },
    [refreshSkills],
  );

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
              {selectedSkillId
                ? (detail?.name ?? "...")
                : LL.skillsModal_title()}
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
          <SkillDetailView
            detail={detail}
            loading={loading}
            onToggle={handleSkillToggle}
          />
        ) : isMarket ? (
          <MarketView
            items={market}
            loading={marketLoading}
            error={marketError}
            search={search}
            onSearchChange={setSearch}
            filter={filter}
            onFilterChange={setFilter}
            availableSources={availableSources}
            installingId={installingId}
            onInstall={handleInstall}
            onUninstall={handleUninstall}
          />
        ) : (
          <SkillListView
            skills={filtered}
            filter={filter}
            onFilterChange={setFilter}
            search={search}
            onSearchChange={setSearch}
            availableSources={availableSources}
            onSelect={setSelectedSkillId}
            onSkillToggle={handleSkillToggle}
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
  onSkillToggle,
}: {
  skills: SkillListItem[];
  filter: FilterType;
  onFilterChange: (f: FilterType) => void;
  search: string;
  onSearchChange: (s: string) => void;
  availableSources: SourceType[];
  onSelect: (id: string) => void;
  onSkillToggle: (skillId: string, next: boolean) => void | Promise<void>;
}) => {
  const { LL } = useI18nContext();
  const sourceLabels = useMemo(() => getSourceLabels(LL), [LL]);

  return (
    <>
      {/* Search + Filters */}
      <div className="px-6 pt-4 pb-2 space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={LL.skillsModal_search()}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <FilterTab
            active={filter === "all"}
            onClick={() => onFilterChange("all")}
          >
            {LL.skillsModal_all(String(skills.length))}
          </FilterTab>
          {availableSources.map((src) => (
            <FilterTab
              key={src}
              active={filter === src}
              onClick={() => onFilterChange(src)}
            >
              {sourceLabels[src]}
            </FilterTab>
          ))}
          {/* 市场 tab */}
          <FilterTab
            active={filter === "market"}
            onClick={() => onFilterChange("market")}
          >
            {LL.skillsModal_market()}
          </FilterTab>
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {skills.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {LL.skillsModal_notFound()}
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            {skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                onClick={() => onSelect(skill.id)}
                onToggle={(next) => onSkillToggle(skill.id, next)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
};

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
  onToggle,
}: {
  skill: SkillListItem;
  onClick: () => void;
  onToggle: (next: boolean) => void | Promise<void>;
}) => {
  const { LL } = useI18nContext();
  const sourceLabels = useMemo(() => getSourceLabels(LL), [LL]);

  const togglable =
    skill.source === "personal" || skill.source === "additional";

  return (
    <div
      className={cn(
        "relative rounded-lg border border-border hover:bg-accent/50 transition-colors group",
        skill.enabled === false && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "w-full text-left p-3",
          // Reserve space on the right for the absolutely-positioned switch.
          togglable && "pr-12",
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="font-medium text-sm text-foreground truncate">
                {skill.name}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                  SOURCE_COLORS[skill.source],
                )}
              >
                {sourceLabels[skill.source]}
              </span>
              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground">
                {skill.category === "task"
                  ? LL.skillsModal_task()
                  : LL.skillsModal_tool()}
              </span>
              {skill.enabled === false && (
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-600">
                  {LL.skillsModal_sourceDisabled()}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2">
              {skill.description}
            </p>
          </div>
          <span className="shrink-0 font-mono text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
            {skill.isExternal ? `/${skill.id}` : LL.skillsModal_autoMatch()}
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
      {togglable && (
        <div className="absolute top-3 right-3">
          <SkillSwitch
            checked={skill.enabled === true}
            onChange={onToggle}
            ariaLabel={skill.name}
          />
        </div>
      )}
    </div>
  );
};

/** Compact toggle switch used inline on per-skill cards. */
const SkillSwitch = ({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void | Promise<void>;
  ariaLabel: string;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={ariaLabel}
    onClick={(e) => {
      e.stopPropagation();
      void onChange(!checked);
    }}
    onKeyDown={(e) => {
      // Prevent the parent div role="button" from also acting on space/enter
      if (e.key === " " || e.key === "Enter") {
        e.stopPropagation();
      }
    }}
    className={cn(
      "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-border transition-colors",
      checked ? "bg-primary" : "bg-muted",
    )}
  >
    <span
      className={cn(
        "inline-block h-3 w-3 transform rounded-full bg-background shadow transition-transform",
        checked ? "translate-x-3.5" : "translate-x-0.5",
      )}
    />
  </button>
);

/* ── Market View ─────────────────────────────────────────────────── */

const MarketView = ({
  items,
  loading,
  error,
  search,
  onSearchChange,
  filter,
  onFilterChange,
  availableSources,
  installingId,
  onInstall,
  onUninstall,
}: {
  items: MarketItem[];
  loading: boolean;
  error: string | null;
  search: string;
  onSearchChange: (s: string) => void;
  filter: FilterType;
  onFilterChange: (f: FilterType) => void;
  availableSources: SourceType[];
  installingId: string | null;
  onInstall: (item: MarketItem) => void | Promise<void>;
  onUninstall: (skillId: string) => void | Promise<void>;
}) => {
  const { LL } = useI18nContext();
  const sourceLabels = useMemo(() => getSourceLabels(LL), [LL]);
  // 按搜索词过滤条目
  const shown = items.filter((m) =>
    !search
      ? true
      : (m.name + m.description).toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="px-6 pt-4 pb-2 space-y-3 shrink-0">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={LL.skillsModal_search()}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-border bg-muted/30 text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {/* 「全部」tab:点击切回本地列表 */}
          <FilterTab active={false} onClick={() => onFilterChange("all")}>
            {LL.skillsModal_all(String(items.length))}
          </FilterTab>
          {availableSources.map((src) => (
            <FilterTab
              key={src}
              active={false}
              onClick={() => onFilterChange(src)}
            >
              {sourceLabels[src]}
            </FilterTab>
          ))}
          {/* 市场 tab 高亮 */}
          <FilterTab
            active={filter === "market"}
            onClick={() => onFilterChange("market")}
          >
            {LL.skillsModal_market()}
          </FilterTab>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-4">
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {LL.skillsModal_loading()}
          </div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-red-500">
            {LL.skillsModal_marketError()}
          </div>
        ) : shown.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {LL.skillsModal_marketEmpty()}
          </div>
        ) : (
          <div className="space-y-2 pt-1">
            {shown.map((m) => (
              <div
                key={m.id}
                className="relative rounded-lg border border-border p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">
                        {m.name}
                      </span>
                      {/* community/official 等级徽标 */}
                      <span
                        className={cn(
                          "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                          m.level === "community"
                            ? "bg-amber-500/10 text-amber-600"
                            : "bg-blue-500/10 text-blue-500",
                        )}
                      >
                        {m.level === "community"
                          ? LL.skillsModal_marketCommunity()
                          : LL.skillsModal_marketOfficial()}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {m.description}
                    </p>
                  </div>
                  {/* 安装/卸载按钮 */}
                  {m.installed ? (
                    <button
                      type="button"
                      onClick={() => onUninstall(m.id)}
                      className="shrink-0 text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:bg-accent"
                    >
                      {LL.skillsModal_marketUninstall()}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={installingId === m.id}
                      onClick={() => void onInstall(m)}
                      className="shrink-0 text-xs px-2 py-1 rounded-md border border-primary bg-primary/10 text-primary disabled:opacity-50"
                    >
                      {installingId === m.id
                        ? LL.skillsModal_marketInstalling()
                        : LL.skillsModal_marketInstall()}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
};

/* ── Skill Detail View ───────────────────────────────────────────── */

const SkillDetailView = ({
  detail,
  loading,
  onToggle,
}: {
  detail: SkillDetailData | null;
  loading: boolean;
  onToggle: (skillId: string, next: boolean) => void | Promise<void>;
}) => {
  const { LL } = useI18nContext();
  const sourceLabels = useMemo(() => getSourceLabels(LL), [LL]);

  if (loading || !detail) {
    return (
      <div className="flex-1 flex items-center justify-center py-12 text-sm text-muted-foreground">
        {loading ? LL.skillsModal_loading() : LL.skillsModal_notFoundInfo()}
      </div>
    );
  }

  const ext = detail.external;
  const togglable =
    detail.source === "personal" || detail.source === "additional";

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
          {sourceLabels[detail.source]}
        </span>
        <span className="rounded px-2 py-0.5 text-xs font-medium bg-muted text-muted-foreground">
          {detail.category === "task"
            ? LL.skillsModal_taskType()
            : LL.skillsModal_toolType()}
        </span>
        {detail.enabled === false && (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-600">
            {LL.skillsModal_sourceDisabled()}
          </span>
        )}
        {togglable && (
          <span className="ml-auto flex items-center gap-2">
            <SkillSwitch
              checked={detail.enabled === true}
              onChange={(next) => onToggle(detail.id, next)}
              ariaLabel={detail.name}
            />
          </span>
        )}
        {ext?.context === "fork" && (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-600">
            {LL.skillsModal_isolatedContext()}
          </span>
        )}
        {ext?.disableModelInvocation && (
          <span className="rounded px-2 py-0.5 text-xs font-medium bg-red-500/10 text-red-500">
            {LL.skillsModal_manualOnly()}
          </span>
        )}
      </div>

      {/* Description */}
      <Section title={LL.skillsModal_description()}>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap">
          {detail.description}
        </p>
      </Section>

      {/* Usage */}
      <Section title={LL.skillsModal_usage()}>
        {detail.isExternal ? (
          <code className="block text-sm bg-muted rounded-md px-3 py-2 text-foreground">
            {LL.skillsModal_usageCommand(detail.id)}
          </code>
        ) : (
          <p className="text-sm text-muted-foreground">
            {LL.skillsModal_usageAuto()}
          </p>
        )}
      </Section>

      {/* Suggestions */}
      {detail.suggestions.length > 0 && (
        <Section title={LL.skillsModal_suggestions()}>
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
        <Section title={LL.skillsModal_keywords()}>
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
          <Section title={LL.skillsModal_sourcePath()}>
            <div className="flex items-center gap-2">
              <code className="text-xs bg-muted rounded px-2 py-1 text-muted-foreground break-all flex-1">
                {ext.sourcePath}
              </code>
              <button
                type="button"
                onClick={() => window.filework.showInFinder(ext.sourcePath)}
                className="shrink-0 p-1 rounded hover:bg-accent transition-colors"
                title={LL.skillsModal_showInFinder()}
              >
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          </Section>

          {/* Allowed tools */}
          {ext.allowedTools.length > 0 && (
            <Section title={LL.skillsModal_allowedTools()}>
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
            <Section title={LL.skillsModal_dependencies()}>
              <div className="space-y-1.5 text-xs">
                {ext.requires.bins && ext.requires.bins.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0 w-12">
                      {LL.skillsModal_depCommand()}
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
                      {LL.skillsModal_depEnvVar()}
                    </span>
                    <span className="font-mono text-foreground">
                      {ext.requires.env.join(", ")}
                    </span>
                  </div>
                )}
                {ext.requires.os && ext.requires.os.length > 0 && (
                  <div className="flex gap-2">
                    <span className="text-muted-foreground shrink-0 w-12">
                      {LL.skillsModal_depSystem()}
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
            <Section title={LL.skillsModal_lifecycle()}>
              <p className="text-xs text-muted-foreground">
                {LL.skillsModal_lifecycleHint()}
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

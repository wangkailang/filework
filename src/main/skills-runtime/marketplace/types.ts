/** 市场来源等级 —— 影响安装时的信任警示文案。 */
export type MarketLevel = "official" | "community";

/** git 子目录安装来源。 */
export interface GitSource {
  type: "git";
  repo: string;
  ref?: string;
  subdir?: string;
}

/** 单文件 SKILL.md 直链来源。 */
export interface UrlSource {
  type: "url";
  url: string;
}

/** registry.json 中的单条市场条目。 */
export interface MarketEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  level: MarketLevel;
  source: GitSource | UrlSource;
  requires?: { bins?: string[]; env?: string[]; os?: string[]; pip?: string[] };
  homepage?: string;
}

/** 附带本地安装状态的市场条目(供 UI 使用)。 */
export interface MarketEntryWithStatus extends MarketEntry {
  installed: boolean;
}

/** 安装结果。 */
export interface InstallResult {
  ok: boolean;
  skillId: string;
  installedPath?: string;
  error?: string;
}

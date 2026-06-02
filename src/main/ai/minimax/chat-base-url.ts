/**
 * MiniMax base-URL 解析。
 *
 * MiniMax 提供两个 API 接口一致的区域端点:
 *  - https://api.minimaxi.com/v1 (中国大陆,默认)
 *  - https://api.minimax.io/v1   (国际版)
 *
 * 用户可通过 LLM 配置的 `baseUrl` 字段按配置覆盖
 * (例如私有网关,或切换区域)。未设置时默认使用
 * 大陆端点 —— 若国际版变得更常用,可在此切换默认值。
 */

export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";

/** 规范化 base URL:去除末尾斜杠,使调用方能安全地追加 "/..."。 */
const stripTrailingSlash = (s: string): string => s.replace(/\/+$/, "");

export const resolveMinimaxBaseUrl = (
  override: string | null | undefined,
): string => {
  const raw =
    override && override.trim() !== "" ? override : MINIMAX_DEFAULT_BASE_URL;
  return stripTrailingSlash(raw);
};

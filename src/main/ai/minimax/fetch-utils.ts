/**
 * MiniMax 客户端共用的 HTTP 响应处理。
 *
 * image-client 和 video-client 使用相同的响应封装:
 *   - HTTP 状态必须是 2xx,否则将响应体文本暴露出来。
 *   - JSON 响应体携带 `base_resp.status_code` —— `0` 表示成功;
 *     其他值是上游错误,应传播到 UI。
 *
 * 集中处理,这样新增 MiniMax 端点(音频、声音克隆等)只需一次 import,
 * 而不必再复制一份相同的守卫逻辑。
 */

import { MinimaxApiError } from "./types";

export const ensureOk = async (
  response: Response,
  endpoint: string,
): Promise<void> => {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  throw new MinimaxApiError(
    `MiniMax ${endpoint} HTTP ${response.status}: ${text || response.statusText}`,
    -1,
    response.status,
  );
};

export const ensureZeroStatus = (
  base: { status_code?: number; status_msg?: string } | undefined,
  endpoint: string,
  httpStatus: number,
): void => {
  const code = base?.status_code ?? -1;
  if (code !== 0) {
    throw new MinimaxApiError(
      `MiniMax ${endpoint} failed (${code}): ${base?.status_msg || "unknown error"}`,
      code,
      httpStatus,
    );
  }
};

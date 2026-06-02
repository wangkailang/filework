/**
 * MiniMax 图像生成客户端。
 *
 * 对 POST {baseUrl}/image_generation 的轻量封装。同步式 ——
 * API 直接返回渲染好的图像 URL(无需轮询,这点与视频生成不同)。
 *
 * fetch 以注入方式传入,这样调用方可以传 `proxyAwareFetch`
 * (经由 Mihomo/Clash 等做分流路由)。测试传入 mock 以避免真实网络请求。
 */

import { resolveMinimaxBaseUrl } from "./chat-base-url";
import { ensureOk, ensureZeroStatus } from "./fetch-utils";
import { MinimaxApiError, type MinimaxImageResponse } from "./types";

export interface GenerateImageInput {
  apiKey: string;
  baseUrl?: string | null;
  model: string;
  prompt: string;
  /** MiniMax 接受的可选宽高比标记(例如 "1:1"、"16:9")。 */
  aspectRatio?: string;
  /** 要生成的图像数量。默认为 1 以契合 UI 预期。 */
  n?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface GenerateImageResult {
  /** MiniMax 返回的 URL —— 短时效;请尽快下载。 */
  imageUrls: string[];
  /** 服务端请求 id,用于提交工单。 */
  requestId?: string;
}

export const generateImage = async (
  input: GenerateImageInput,
): Promise<GenerateImageResult> => {
  const fetchFn = input.fetchImpl ?? fetch;
  const baseUrl = resolveMinimaxBaseUrl(input.baseUrl);
  const url = `${baseUrl}/image_generation`;

  const body: Record<string, unknown> = {
    model: input.model,
    prompt: input.prompt,
    response_format: "url",
    n: input.n ?? 1,
  };
  if (input.aspectRatio) body.aspect_ratio = input.aspectRatio;

  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  await ensureOk(response, "image_generation");

  const json = (await response.json()) as MinimaxImageResponse;
  ensureZeroStatus(json.base_resp, "image_generation", response.status);

  const urls = json.data?.image_urls ?? [];
  if (urls.length === 0) {
    throw new MinimaxApiError(
      "MiniMax image_generation returned no image URLs",
      0,
      response.status,
    );
  }

  return { imageUrls: urls, requestId: json.id };
};

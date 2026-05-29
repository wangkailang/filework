/**
 * HTTP Range 头解析 —— 供 `local-file://` 协议处理器做按需/分段读取。
 *
 * 只支持单段 `bytes=` 语法(浏览器 <video>/<iframe PDF> 实际只发这种),
 * 多段(逗号分隔)一律按不可满足处理。
 */

/** 闭区间字节范围:[start, end](含两端)。 */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * 解析 Range 头,返回闭区间 [start, end];语法非法或不可满足时返回 null
 * (调用方应回 416)。end 会被 clamp 到 fileSize-1。
 *
 * 支持:
 *   bytes=200-999  → {200, 999}
 *   bytes=200-     → {200, fileSize-1}
 *   bytes=-500     → 最后 500 字节 → {fileSize-500, fileSize-1}
 */
export const parseRange = (
  rangeHeader: string,
  fileSize: number,
): ByteRange | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;

  const startStr = match[1];
  const endStr = match[2];
  // "bytes=-" 两端都空:非法。
  if (startStr === "" && endStr === "") return null;

  let start: number;
  let end: number;
  if (startStr === "") {
    // 后缀范围:最后 N 字节。
    const suffixLength = Number(endStr);
    if (suffixLength === 0) return null;
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === "" ? fileSize - 1 : Math.min(Number(endStr), fileSize - 1);
  }

  // 越界 / 反向区间 → 不可满足。
  if (start < 0 || start > end || start >= fileSize) return null;
  return { start, end };
};

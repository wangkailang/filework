import type { TranslationFunctions } from "../../../i18n/i18n-types";
import type { MemoryEventType } from "./useMemoryChartData";

export const getTypeLabel = (
  type: MemoryEventType,
  LL: TranslationFunctions,
): string => {
  switch (type) {
    case "compression-write":
      return LL.memoryDebug_contextCompression();
    case "compression-skip":
      return LL.memoryDebug_compressionSkipped();
    case "compression-error":
      return LL.memoryDebug_compressionError();
    case "result-summarize":
      return LL.memoryDebug_resultSummarize();
    case "truncation-drop":
      return LL.memoryDebug_truncationDrop();
    case "cache-write":
      return LL.memoryDebug_cacheWrite();
    case "cache-hit":
      return LL.memoryDebug_cacheHit();
  }
};

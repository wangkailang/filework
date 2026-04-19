import type { TranslationFunctions } from "../../i18n/i18n-types";

/** Human-readable tool name labels (shared between tool.tsx and plan-viewer.tsx) */
export const getToolLabels = (
  LL: TranslationFunctions,
): Record<string, string> => ({
  listDirectory: LL.toolName_listDirectory(),
  readFile: LL.toolName_readFile(),
  writeFile: LL.toolName_writeFile(),
  moveFile: LL.toolName_moveFile(),
  createDirectory: LL.toolName_createDirectory(),
  deleteFile: LL.toolName_deleteFile(),
  directoryStats: LL.toolName_directoryStats(),
  findDuplicates: LL.toolName_findDuplicates(),
  runCommand: LL.toolName_runCommand(),
});

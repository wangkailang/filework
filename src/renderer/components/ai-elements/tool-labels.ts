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
  automation_update: LL.toolName_automationUpdate(),
  runCommand: LL.toolName_runCommand(),
  runProcess: LL.toolName_runProcess(),
  webSearch: LL.toolName_webSearch(),
  webFetch: LL.toolName_webFetch(),
  webFetchRendered: LL.toolName_webFetchRendered(),
  webScrape: LL.toolName_webScrape(),
  youtubeTranscript: LL.toolName_youtubeTranscript(),
  spawnSubagent: LL.toolName_spawnSubagent(),
});

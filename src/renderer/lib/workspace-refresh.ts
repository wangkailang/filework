const FILE_TREE_MUTATION_TOOLS = new Set([
  "writeFile",
  "moveFile",
  "deleteFile",
  "createDirectory",
  "restoreFromTrash",
  "emptyTrash",
]);

export const shouldRefreshFileTreeForToolResult = (
  toolName: string,
  result: unknown,
): boolean => {
  if (!FILE_TREE_MUTATION_TOOLS.has(toolName)) return false;
  if (result == null || typeof result !== "object") return true;
  const resultObj = result as Record<string, unknown>;
  return !(
    resultObj.denied === true ||
    resultObj.success === false ||
    resultObj.isError === true
  );
};

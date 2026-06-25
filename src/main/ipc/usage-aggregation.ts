export interface TokenUsageLike {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
}

const valueOrZero = (value: number | null | undefined): number =>
  typeof value === "number" ? value : 0;

const hasAnyUsage = (
  usage: TokenUsageLike | undefined,
): usage is TokenUsageLike =>
  usage !== undefined &&
  (usage.inputTokens != null ||
    usage.outputTokens != null ||
    usage.totalTokens != null);

const normalizedTotal = (usage: TokenUsageLike): number | null => {
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  if (usage.inputTokens != null || usage.outputTokens != null) {
    return valueOrZero(usage.inputTokens) + valueOrZero(usage.outputTokens);
  }
  return null;
};

export const mergeTokenUsage = (
  ...usages: Array<TokenUsageLike | undefined>
): Required<TokenUsageLike> => {
  const present = usages.filter(hasAnyUsage);
  if (present.length === 0) {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }

  return present.reduce<Required<TokenUsageLike>>(
    (acc, usage) => ({
      inputTokens:
        acc.inputTokens === null && usage.inputTokens == null
          ? null
          : valueOrZero(acc.inputTokens) + valueOrZero(usage.inputTokens),
      outputTokens:
        acc.outputTokens === null && usage.outputTokens == null
          ? null
          : valueOrZero(acc.outputTokens) + valueOrZero(usage.outputTokens),
      totalTokens:
        acc.totalTokens === null && normalizedTotal(usage) === null
          ? null
          : valueOrZero(acc.totalTokens) + valueOrZero(normalizedTotal(usage)),
    }),
    { inputTokens: null, outputTokens: null, totalTokens: null },
  );
};

export const subagentUsageFromToolResult = (
  result: unknown,
): Required<TokenUsageLike> => {
  if (result == null || typeof result !== "object") {
    return mergeTokenUsage();
  }
  const reports = (result as { reports?: unknown }).reports;
  if (!Array.isArray(reports)) return mergeTokenUsage();

  return mergeTokenUsage(
    ...reports.map((report) => {
      if (report == null || typeof report !== "object") return undefined;
      const usage = (report as { usage?: unknown }).usage;
      return usage != null && typeof usage === "object"
        ? (usage as TokenUsageLike)
        : undefined;
    }),
  );
};

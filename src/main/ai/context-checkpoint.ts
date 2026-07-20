import type { HistoryMessage } from "./message-converter";

export interface ContextCheckpointInput {
  coveredThroughMessageId?: string | null;
  summary?: string | null;
}

export interface AppliedContextCheckpoint {
  applied: boolean;
  history: HistoryMessage[];
  summary: string | null;
}

export function applyContextCheckpoint(
  history: HistoryMessage[],
  checkpoint: ContextCheckpointInput | null | undefined,
  pinnedMessageCount = 2,
): AppliedContextCheckpoint {
  const coveredThroughMessageId = checkpoint?.coveredThroughMessageId?.trim();
  const summary = checkpoint?.summary?.trim();
  if (!coveredThroughMessageId || !summary) {
    return { applied: false, history, summary: null };
  }

  const coveredIndex = history.findIndex(
    (message) => message.id === coveredThroughMessageId,
  );
  const pinnedCount = Math.max(0, Math.floor(pinnedMessageCount));
  if (coveredIndex < pinnedCount) {
    return { applied: false, history, summary: null };
  }

  return {
    applied: true,
    history: [
      ...history.slice(0, pinnedCount),
      ...history.slice(coveredIndex + 1),
    ],
    summary,
  };
}

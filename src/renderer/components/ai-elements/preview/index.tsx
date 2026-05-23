import type { BatchApprovalEntry } from "../../../../main/core/session/message-parts";
import type { TranslationFunctions } from "../../../i18n/i18n-types";
import { CreateDirectoryPreviewCard } from "./CreateDirectoryPreviewCard";
import { DeleteFilePreviewCard } from "./DeleteFilePreviewCard";
import { MoveFilePreviewCard } from "./MoveFilePreviewCard";
import { RunCommandPreviewCard } from "./RunCommandPreviewCard";
import { WriteFilePreviewCard } from "./WriteFilePreviewCard";

export { CreateDirectoryPreviewCard } from "./CreateDirectoryPreviewCard";
export { DeleteFilePreviewCard } from "./DeleteFilePreviewCard";
export { DiffHunkView } from "./DiffHunkView";
export { MoveFilePreviewCard } from "./MoveFilePreviewCard";
export { RunCommandPreviewCard } from "./RunCommandPreviewCard";
export { WriteFilePreviewCard } from "./WriteFilePreviewCard";

interface PreviewEntryRowProps {
  entry: BatchApprovalEntry;
  LL: TranslationFunctions;
}

/**
 * Dispatch table for approval-card rows. The IPC layer attaches a
 * structured `entry.preview` to most destructive-tool requests; we pick
 * the matching card by `preview.kind`. Old sessions (no preview field)
 * and tool kinds we don't have a card for yet fall back to the
 * description-only row, preserving the pre-preview look.
 */
export function PreviewEntryRow({ entry, LL }: PreviewEntryRowProps) {
  const preview = entry.preview;
  if (preview) {
    switch (preview.kind) {
      case "write":
        return (
          <WriteFilePreviewCard
            preview={preview}
            LL={LL}
            fallbackDescription={entry.description}
          />
        );
      case "move":
        return <MoveFilePreviewCard preview={preview} LL={LL} />;
      case "delete":
        return <DeleteFilePreviewCard preview={preview} LL={LL} />;
      case "mkdir":
        return <CreateDirectoryPreviewCard preview={preview} LL={LL} />;
      case "run":
        return <RunCommandPreviewCard preview={preview} LL={LL} />;
    }
  }
  // Old sessions and any tool we don't have a preview for fall back here.
  return <div className="truncate">· {entry.description}</div>;
}

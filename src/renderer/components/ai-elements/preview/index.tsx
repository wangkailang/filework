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
 * 审批卡片行的分发表。IPC 层会为大多数破坏性工具请求附加一个结构化的
 * `entry.preview`;我们按 `preview.kind` 选择匹配的卡片。旧会话(无 preview
 * 字段)以及尚无对应卡片的工具类型会回退到仅展示描述的行,保留引入预览前
 * 的外观。
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
  // 旧会话以及任何没有对应预览的工具都会回退到此处。
  return <div className="truncate">· {entry.description}</div>;
}

import { CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import { type HTMLAttributes, useState } from "react";
import type {
  ApprovalState,
  BatchApprovalEntry,
  ToolApprovalRichPreview,
} from "../../../main/core/session/message-parts";
import { cn } from "../../lib/utils";

// ---------------------------------------------------------------------------
// Types — re-exported from the shared core types so the JSONL session store
// and the renderer agree on a single source of truth.
// ---------------------------------------------------------------------------

export type { ApprovalState } from "../../../main/core/session/message-parts";

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

interface ConfirmationProps extends HTMLAttributes<HTMLDivElement> {
  state: ApprovalState;
}

export const Confirmation = ({
  state,
  children,
  className,
  ...props
}: ConfirmationProps) => (
  <div
    data-state={state}
    className={cn(
      "rounded-lg border text-sm",
      state === "approval-requested" && "border-amber-500/40 bg-amber-500/5",
      state === "approval-accepted" && "border-green-500/40 bg-green-500/5",
      state === "approval-rejected" && "border-red-500/40 bg-red-500/5",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Request (shown while waiting for user decision)
// ---------------------------------------------------------------------------

export const ConfirmationRequest = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-start gap-2 px-3 py-2.5", className)}
    {...props}
  >
    <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
    <div className="text-foreground/90 text-xs leading-relaxed">{children}</div>
  </div>
);

// ---------------------------------------------------------------------------
// Accepted
// ---------------------------------------------------------------------------

export const ConfirmationAccepted = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2", className)}
    {...props}
  >
    <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
    <span className="text-xs text-green-400">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Rejected
// ---------------------------------------------------------------------------

export const ConfirmationRejected = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 py-2", className)}
    {...props}
  >
    <XCircle className="size-3.5 text-red-500 shrink-0" />
    <span className="text-xs text-red-400">{children}</span>
  </div>
);

// ---------------------------------------------------------------------------
// Actions (approve / reject buttons)
// ---------------------------------------------------------------------------

export const ConfirmationActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex items-center gap-2 px-3 pb-2.5", className)}
    {...props}
  >
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Action button
// ---------------------------------------------------------------------------

interface ConfirmationActionProps extends HTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
}

export const ConfirmationAction = ({
  variant = "default",
  disabled,
  children,
  className,
  ...props
}: ConfirmationActionProps) => (
  <button
    type="button"
    disabled={disabled}
    className={cn(
      "inline-flex items-center justify-center rounded-md px-3 py-1 text-xs font-medium transition-colors",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      "disabled:pointer-events-none disabled:opacity-50",
      variant === "default" &&
        "bg-primary text-primary-foreground hover:bg-primary/90",
      variant === "outline" &&
        "border border-border bg-transparent hover:bg-accent hover:text-foreground",
      variant === "destructive" &&
        "bg-destructive text-destructive-foreground hover:bg-destructive/90",
      className,
    )}
    {...props}
  >
    {children}
  </button>
);

// ---------------------------------------------------------------------------
// Batch — one card for N destructive calls coalesced by approval-batcher
// ---------------------------------------------------------------------------

interface ConfirmationBatchProps {
  state: ApprovalState;
  toolName: string;
  entries: BatchApprovalEntry[];
  onApproveAll: () => void;
  onDenyAll: () => void;
  /** Max entries shown before "+N more" collapse. Default 5. */
  previewLimit?: number;
  className?: string;
}

// ---------------------------------------------------------------------------
// Branch choice — multi-button picker for proposeSessionBranch
// ---------------------------------------------------------------------------

interface ConfirmationBranchChoiceProps {
  candidates: string[];
  rationale?: string;
  onPick: (branch: string) => void;
  onDeny: () => void;
  className?: string;
}

export const ConfirmationBranchChoice = ({
  candidates,
  rationale,
  onPick,
  onDeny,
  className,
}: ConfirmationBranchChoiceProps) => {
  const [custom, setCustom] = useState("");
  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2.5", className)}>
      <div className="flex items-start gap-2">
        <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="text-foreground/90 text-xs leading-relaxed">
          <div className="font-medium">选择会话分支</div>
          {rationale && (
            <div className="mt-0.5 text-foreground/60">{rationale}</div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 pl-6">
        {candidates.map((c) => (
          <button
            key={c}
            type="button"
            className={cn(
              "inline-flex items-center rounded-md border border-border bg-transparent",
              "px-2.5 py-1 text-xs font-mono text-foreground",
              "hover:bg-accent hover:text-foreground transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
            onClick={() => onPick(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 pl-6">
        <input
          type="text"
          placeholder="自定义分支名 (feature/...)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          className={cn(
            "flex-1 rounded-md border border-border bg-transparent px-2 py-1",
            "text-xs font-mono text-foreground placeholder:text-foreground/40",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          )}
        />
        <ConfirmationAction
          variant="default"
          disabled={custom.trim().length === 0}
          onClick={() => onPick(custom.trim())}
        >
          使用自定义
        </ConfirmationAction>
        <ConfirmationAction variant="outline" onClick={onDeny}>
          拒绝
        </ConfirmationAction>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Commit preview — branch, author, message, file list
// ---------------------------------------------------------------------------

interface ConfirmationCommitPreviewProps {
  branch: string | null;
  author: string | null;
  message: string;
  files: string[];
}

export const ConfirmationCommitPreview = ({
  branch,
  author,
  message,
  files,
}: ConfirmationCommitPreviewProps) => (
  <div className="flex flex-col gap-1 px-3 py-2.5 text-xs">
    <div className="flex items-start gap-2">
      <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
      <div className="font-medium text-foreground/90">提交</div>
    </div>
    <dl className="pl-6 space-y-0.5 text-foreground/80">
      <div className="flex gap-2">
        <dt className="text-foreground/50 w-16 shrink-0">分支</dt>
        <dd className="font-mono">{branch ?? "(未设置)"}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-foreground/50 w-16 shrink-0">作者</dt>
        <dd className="font-mono">{author ?? "(当前模型)"}</dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-foreground/50 w-16 shrink-0">信息</dt>
        <dd className="whitespace-pre-line break-words">{message}</dd>
      </div>
      {files.length > 0 && (
        <div className="flex gap-2">
          <dt className="text-foreground/50 w-16 shrink-0">文件</dt>
          <dd className="font-mono break-all">
            {files.slice(0, 8).join(", ")}
            {files.length > 8 && ` …+${files.length - 8}`}
          </dd>
        </div>
      )}
    </dl>
  </div>
);

// ---------------------------------------------------------------------------
// PR preview — base ← head, title, body, draft
// ---------------------------------------------------------------------------

interface ConfirmationPrPreviewProps {
  base: string;
  head: string | null;
  title: string;
  bodyPreview: string;
  draft: boolean;
}

export const ConfirmationPrPreview = ({
  base,
  head,
  title,
  bodyPreview,
  draft,
}: ConfirmationPrPreviewProps) => (
  <div className="flex flex-col gap-1 px-3 py-2.5 text-xs">
    <div className="flex items-start gap-2">
      <ShieldAlert className="size-4 text-amber-500 mt-0.5 shrink-0" />
      <div className="font-medium text-foreground/90">
        创建 PR{draft && " (draft)"}
      </div>
    </div>
    <dl className="pl-6 space-y-0.5 text-foreground/80">
      <div className="flex gap-2">
        <dt className="text-foreground/50 w-16 shrink-0">合并</dt>
        <dd className="font-mono">
          {head ?? "(未设置)"} → {base}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-foreground/50 w-16 shrink-0">标题</dt>
        <dd className="break-words">{title}</dd>
      </div>
      {bodyPreview && (
        <div className="flex gap-2">
          <dt className="text-foreground/50 w-16 shrink-0">正文</dt>
          <dd className="whitespace-pre-line break-words text-foreground/70 line-clamp-6">
            {bodyPreview}
          </dd>
        </div>
      )}
    </dl>
  </div>
);

// ---------------------------------------------------------------------------
// Rich preview dispatcher — picks the right component by kind
// ---------------------------------------------------------------------------

interface ConfirmationRichPreviewProps {
  preview: ToolApprovalRichPreview;
  onPick: (choice: string) => void;
  onDeny: () => void;
}

export const ConfirmationRichPreview = ({
  preview,
  onPick,
  onDeny,
}: ConfirmationRichPreviewProps) => {
  if (preview.kind === "branch-choice") {
    return (
      <ConfirmationBranchChoice
        candidates={preview.candidates}
        rationale={preview.rationale}
        onPick={onPick}
        onDeny={onDeny}
      />
    );
  }
  if (preview.kind === "commit") {
    return (
      <ConfirmationCommitPreview
        branch={preview.branch}
        author={preview.author}
        message={preview.message}
        files={preview.files}
      />
    );
  }
  if (preview.kind === "pr") {
    return (
      <ConfirmationPrPreview
        base={preview.base}
        head={preview.head}
        title={preview.title}
        bodyPreview={preview.bodyPreview}
        draft={preview.draft}
      />
    );
  }
  return null;
};

export const ConfirmationBatch = ({
  state,
  toolName,
  entries,
  onApproveAll,
  onDenyAll,
  previewLimit = 5,
  className,
}: ConfirmationBatchProps) => {
  const count = entries.length;
  const visible = entries.slice(0, previewLimit);
  const hidden = Math.max(0, count - previewLimit);

  return (
    <Confirmation state={state} className={className}>
      <ConfirmationRequest>
        <div className="flex flex-col gap-1">
          <div className="font-medium">
            批准 {count} 个 {toolName} 操作？
          </div>
          <ul className="ml-1 mt-0.5 space-y-0.5 text-foreground/70">
            {visible.map((e) => (
              <li key={e.toolCallId} className="truncate">
                · {e.description}
              </li>
            ))}
            {hidden > 0 && (
              <li className="text-foreground/50">…还有 {hidden} 个</li>
            )}
          </ul>
        </div>
      </ConfirmationRequest>
      {state === "approval-requested" && (
        <ConfirmationActions>
          <ConfirmationAction variant="default" onClick={onApproveAll}>
            批准全部 {count} 个
          </ConfirmationAction>
          <ConfirmationAction variant="destructive" onClick={onDenyAll}>
            拒绝全部
          </ConfirmationAction>
        </ConfirmationActions>
      )}
      {state === "approval-accepted" && (
        <ConfirmationAccepted>已批准 {count} 个操作</ConfirmationAccepted>
      )}
      {state === "approval-rejected" && (
        <ConfirmationRejected>已拒绝 {count} 个操作</ConfirmationRejected>
      )}
    </Confirmation>
  );
};

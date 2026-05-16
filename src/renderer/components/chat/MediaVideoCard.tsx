import { Film, Loader2, X } from "lucide-react";
import { localFileUrl } from "../../lib/local-file-url";
import type { VideoJobPart } from "./types";

interface MediaVideoCardProps {
  part: VideoJobPart;
}

const STATUS_LABEL: Record<VideoJobPart["status"], string> = {
  queued: "排队中",
  running: "生成中",
  succeeded: "完成",
  failed: "失败",
  canceled: "已取消",
};

const STATUS_COLOR: Record<VideoJobPart["status"], string> = {
  queued: "text-foreground",
  running: "text-foreground",
  succeeded: "text-primary",
  failed: "text-destructive",
  canceled: "text-muted-foreground",
};

/**
 * Inline card for a long-running video-generation job. Shows a spinner
 * + status while polling; flips to a playable <video> element once the
 * watcher writes `resultPath`. The Cancel button calls
 * `media:cancel-job` — the main-process watcher tears down its timers
 * and the DB row flips to status=canceled.
 */
export const MediaVideoCard = ({ part }: MediaVideoCardProps) => {
  const isTerminal =
    part.status === "succeeded" ||
    part.status === "failed" ||
    part.status === "canceled";

  const handleCancel = () => {
    void window.filework.media.cancelJob(part.jobId);
  };

  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border bg-muted">
      {part.status === "succeeded" && part.resultPath ? (
        <video
          src={localFileUrl(part.resultPath)}
          controls
          className="block w-full max-h-[480px] bg-background"
        >
          <track kind="captions" />
        </video>
      ) : (
        <div className="flex h-40 items-center justify-center bg-background/60">
          {part.status === "failed" || part.status === "canceled" ? (
            <Film className="h-8 w-8 opacity-40" />
          ) : (
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          )}
        </div>
      )}
      <div className="flex items-start gap-2 px-3 py-2 text-xs">
        <Film className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-60 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={STATUS_COLOR[part.status]}>
              {STATUS_LABEL[part.status]}
            </span>
            {part.modelId && (
              <span className="text-muted-foreground opacity-60">
                · {part.modelId}
              </span>
            )}
          </div>
          <div className="break-words text-foreground/80 mt-0.5">
            {part.prompt}
          </div>
          {part.status === "failed" && part.errorMessage && (
            <div className="mt-0.5 text-destructive opacity-80">
              {part.errorMessage}
            </div>
          )}
        </div>
        {!isTerminal && (
          <button
            type="button"
            onClick={handleCancel}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
            title="取消任务"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
};

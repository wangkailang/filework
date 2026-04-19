import { FileWarning } from "lucide-react";
import { useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";

interface VideoViewerProps {
  filePath: string;
  fileName: string;
}

export const VideoViewer = ({ filePath, fileName }: VideoViewerProps) => {
  const { LL } = useI18nContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  const src = `local-file://open?path=${encodeURIComponent(filePath)}`;

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground px-6">
        <FileWarning className="w-10 h-10" />
        <p className="text-sm text-center">{LL.preview_videoError()}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full bg-black/90 p-4">
      <video
        ref={videoRef}
        src={src}
        controls
        className="max-w-full max-h-full rounded"
        onError={() => setError(true)}
        aria-label={LL.preview_videoLabel(fileName)}
      >
        <track kind="captions" />
      </video>
    </div>
  );
};

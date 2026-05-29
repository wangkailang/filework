import { FileWarning, Music } from "lucide-react";
import { useRef, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { localFileUrl } from "../../lib/local-file-url";

interface AudioViewerProps {
  filePath: string;
  fileName: string;
}

export const AudioViewer = ({ filePath, fileName }: AudioViewerProps) => {
  const { LL } = useI18nContext();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [error, setError] = useState(false);
  // 走 local-file:// 协议(支持 Range/流式),与图片/视频一致,免 base64 膨胀。
  const src = localFileUrl(filePath);

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted-foreground">
        <FileWarning className="h-10 w-10" />
        <p className="text-center text-sm">{LL.preview_audioError()}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
      <div className="flex min-w-0 flex-col items-center gap-3 text-muted-foreground">
        <Music className="h-16 w-16" />
        <span className="max-w-full truncate text-sm text-foreground">
          {fileName}
        </span>
      </div>
      <audio
        ref={audioRef}
        src={src}
        controls
        className="w-full max-w-md"
        onError={() => setError(true)}
        aria-label={LL.preview_audioLabel(fileName)}
      >
        <track kind="captions" />
      </audio>
    </div>
  );
};

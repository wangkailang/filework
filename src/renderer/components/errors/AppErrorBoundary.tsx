import { AlertTriangle, RotateCw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";

type RecoveryCopy = {
  description: string;
  reload: string;
  title: string;
};

const RECOVERY_COPY: Record<"en" | "ja" | "zh", RecoveryCopy> = {
  en: {
    title: "The workspace cannot be displayed right now",
    description:
      "Workspace Agent hit a display error. Your files and chats remain stored locally.",
    reload: "Reload app",
  },
  ja: {
    title: "ワークスペースを表示できません",
    description:
      "表示中にエラーが発生しました。ファイルとチャットはローカルに保存されたままです。",
    reload: "アプリを再読み込み",
  },
  zh: {
    title: "工作区暂时无法显示",
    description: "Workspace Agent 遇到了界面错误。文件和对话仍保存在本地。",
    reload: "重新加载应用",
  },
};

const recoveryCopyFor = (locale?: string): RecoveryCopy => {
  const language =
    locale ??
    (typeof navigator === "undefined" ? "en" : (navigator.language ?? "en"));
  if (language.toLowerCase().startsWith("zh")) return RECOVERY_COPY.zh;
  if (language.toLowerCase().startsWith("ja")) return RECOVERY_COPY.ja;
  return RECOVERY_COPY.en;
};

interface AppErrorBoundaryProps {
  children: ReactNode;
  locale?: string;
  onReload?: () => void;
}

interface AppErrorBoundaryState {
  hasError: boolean;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // The fallback intentionally avoids rendering or persisting raw exception
    // details, which can include local workspace paths.
  }

  private reload = () => {
    if (this.props.onReload) {
      this.props.onReload();
      return;
    }
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const copy = recoveryCopyFor(this.props.locale);
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6 text-foreground">
        <section
          aria-live="assertive"
          className="w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-lg"
        >
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-status-error/10 text-status-error">
              <AlertTriangle className="size-4.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold">{copy.title}</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
                {copy.description}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={copy.reload}
            onClick={this.reload}
            className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RotateCw className="size-3.5" aria-hidden="true" />
            {copy.reload}
          </button>
        </section>
      </main>
    );
  }
}

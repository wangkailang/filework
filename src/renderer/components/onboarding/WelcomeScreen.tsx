import { AlertTriangle, Clock, FolderOpen, Github, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";
import { decodeRef, type WorkspaceRef } from "../../types/workspace-ref";

interface RecentWorkspace {
  path: string;
  name: string;
  lastOpenedAt: string;
  kind?: "local" | "github";
  metadata?: string | null;
}

interface WelcomeScreenProps {
  onSelectDirectory: (path: string) => void;
  onSelectGithub?: () => void;
  onSelectRecentRef?: (ref: WorkspaceRef) => void;
  errorMessage?: string | null;
}

export const WelcomeScreen = ({
  onSelectDirectory,
  onSelectGithub,
  onSelectRecentRef,
  errorMessage,
}: WelcomeScreenProps) => {
  const { LL } = useI18nContext();
  const [recentList, setRecentList] = useState<RecentWorkspace[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const list = await window.filework.getRecentWorkspaces();
        setRecentList(list ?? []);
      } catch {
        // ignore
      }
    };
    load();
  }, []);

  const handleSelectDirectory = async () => {
    const path = await window.filework.openDirectory();
    if (path) {
      onSelectDirectory(path);
    }
  };

  const handleRemoveRecent = async (e: React.MouseEvent, path: string) => {
    e.stopPropagation();
    await window.filework.removeRecentWorkspace(path);
    setRecentList((prev) => prev.filter((w) => w.path !== path));
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      {/* Titlebar drag region */}
      <div className="titlebar-drag fixed top-0 left-0 right-0 h-12" />

      <div className="flex flex-col items-center gap-8 max-w-md text-center">
        {/* Logo */}
        <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center">
          <FolderOpen className="w-10 h-10 text-primary" />
        </div>

        <div>
          <h1 className="text-2xl font-semibold text-foreground mb-2">
            {LL.welcome_title()}
          </h1>
          <p className="text-muted-foreground">{LL.welcome_description()}</p>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch gap-3">
          <button
            type="button"
            onClick={handleSelectDirectory}
            className="flex items-center justify-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors cursor-pointer"
          >
            <FolderOpen className="w-5 h-5" />
            {LL.welcome_selectDirectory()}
          </button>
          {onSelectGithub && (
            <button
              type="button"
              onClick={onSelectGithub}
              className="flex items-center justify-center gap-2 px-6 py-3 border border-border rounded-lg hover:bg-accent transition-colors cursor-pointer"
            >
              <Github className="w-5 h-5" />
              Connect GitHub Repo
            </button>
          )}
        </div>

        {errorMessage && (
          <div className="w-full max-w-sm rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-left">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
              <div className="text-xs text-destructive">{errorMessage}</div>
            </div>
          </div>
        )}

        {/* Recent workspaces */}
        {recentList.length > 0 && (
          <div className="w-full max-w-sm">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <Clock className="w-3 h-3" />
              <span>{LL.welcome_recentlyOpened()}</span>
            </div>
            <div className="space-y-1">
              {recentList.slice(0, 5).map((ws) => {
                const ref = decodeRef(ws.metadata);
                const isGithub = ref?.kind === "github" || ws.kind === "github";
                const Icon = isGithub ? Github : FolderOpen;
                const handleClick = () => {
                  if (ref && ref.kind === "github" && onSelectRecentRef) {
                    onSelectRecentRef(ref);
                  } else {
                    onSelectDirectory(ws.path);
                  }
                };
                return (
                  <button
                    key={ws.path}
                    type="button"
                    onClick={handleClick}
                    className="group w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm hover:bg-accent transition-colors"
                  >
                    <Icon className="w-4 h-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-foreground">{ws.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {ws.path}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => handleRemoveRecent(e, ws.path)}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-muted transition-all"
                      title={LL.welcome_remove()}
                    >
                      <X className="w-3 h-3 text-muted-foreground" />
                    </button>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">{LL.welcome_privacy()}</p>
      </div>
    </div>
  );
};

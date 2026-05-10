import { Clock, FolderOpen, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18nContext } from "../../i18n/i18n-react";

interface RecentWorkspace {
  path: string;
  name: string;
  lastOpenedAt: string;
}

interface WelcomeScreenProps {
  onSelectDirectory: (path: string) => void;
}

export const WelcomeScreen = ({ onSelectDirectory }: WelcomeScreenProps) => {
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

        <button
          type="button"
          onClick={handleSelectDirectory}
          className="flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors cursor-pointer"
        >
          <FolderOpen className="w-5 h-5" />
          {LL.welcome_selectDirectory()}
        </button>

        {/* Recent workspaces */}
        {recentList.length > 0 && (
          <div className="w-full max-w-sm">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
              <Clock className="w-3 h-3" />
              <span>{LL.welcome_recentlyOpened()}</span>
            </div>
            <div className="space-y-1">
              {recentList.slice(0, 5).map((ws) => (
                <button
                  key={ws.path}
                  type="button"
                  onClick={() => onSelectDirectory(ws.path)}
                  className="group w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left text-sm hover:bg-accent transition-colors"
                >
                  <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
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
              ))}
            </div>
          </div>
        )}

        <p className="text-xs text-muted-foreground">{LL.welcome_privacy()}</p>
      </div>
    </div>
  );
};

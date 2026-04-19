import { useEffect, useState } from "react";
import { ChatPanel } from "./components/chat/ChatPanel";
import { FilePreviewPanel } from "./components/file-preview/FilePreviewPanel";
import { Sidebar } from "./components/layout/Sidebar";
import { WelcomeScreen } from "./components/onboarding/WelcomeScreen";
import TypesafeI18n from "./i18n/i18n-react";
import type { Locales } from "./i18n/i18n-types";
import { loadAllLocales } from "./i18n/i18n-util.sync";

// Load all locales synchronously at startup
loadAllLocales();

const getInitialLocale = (): Locales => {
  const saved = localStorage.getItem("filework-locale") as Locales | null;
  if (saved) return saved;
  const lang = navigator.language;
  if (lang.startsWith("zh")) return "zh-CN";
  if (lang.startsWith("ja")) return "ja";
  return "en";
};

export const App = () => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locales>(getInitialLocale);
  const [isRestoring, setIsRestoring] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  // On launch: restore the most recent workspace
  useEffect(() => {
    const restore = async () => {
      try {
        const recent = await window.filework.getRecentWorkspaces();
        if (recent.length > 0) {
          setWorkspacePath(recent[0].path);
        }
      } catch {
        // First launch or no history — show WelcomeScreen
      } finally {
        setIsRestoring(false);
      }
    };
    restore();
  }, []);

  // When workspace changes, record it as recent
  const handleSetWorkspace = (path: string) => {
    setWorkspacePath(path);
    setSelectedFilePath(null);
    const name = path.split("/").pop() || path;
    window.filework.addRecentWorkspace(path, name);
  };

  if (isRestoring) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="titlebar-drag fixed top-0 left-0 right-0 h-12" />
      </div>
    );
  }

  return (
    <TypesafeI18n key={locale} locale={locale}>
      {!workspacePath ? (
        <WelcomeScreen onSelectDirectory={handleSetWorkspace} />
      ) : (
        <div className="flex h-screen w-screen overflow-hidden">
          <div className="titlebar-drag fixed top-0 left-0 right-0 h-12 z-50" />
          <Sidebar
            workspacePath={workspacePath}
            onChangeDirectory={handleSetWorkspace}
            onCloseDirectory={() => setWorkspacePath(null)}
            onLocaleChange={setLocale}
            onSelectFile={setSelectedFilePath}
          />
          <main className="flex-1 flex pt-12 overflow-hidden">
            {selectedFilePath && (
              <div className="w-7/10 border-r border-border overflow-hidden">
                <FilePreviewPanel
                  filePath={selectedFilePath}
                  onClose={() => setSelectedFilePath(null)}
                />
              </div>
            )}
            <div
              className={
                selectedFilePath
                  ? "w-3/10 overflow-hidden"
                  : "flex-1 overflow-hidden"
              }
            >
              <ChatPanel workspacePath={workspacePath} />
            </div>
          </main>
        </div>
      )}
    </TypesafeI18n>
  );
};

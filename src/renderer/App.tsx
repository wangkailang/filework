import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "./components/chat/ChatPanel";
import { FilePreviewPanel } from "./components/file-preview/FilePreviewPanel";
import { Sidebar } from "./components/layout/Sidebar";
import { GitHubConnectModal } from "./components/onboarding/GitHubConnectModal";
import { WelcomeScreen } from "./components/onboarding/WelcomeScreen";
import TypesafeI18n from "./i18n/i18n-react";
import type { Locales } from "./i18n/i18n-types";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import {
  decodeRef,
  encodeRef,
  type WorkspaceRef,
  workspaceRefLabel,
} from "./types/workspace-ref";

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

interface ResolvedWorkspace {
  ref: WorkspaceRef;
  /** On-disk path the file tree / sandbox uses (clone dir for GitHub). */
  localPath: string;
}

const recentKeyFor = (ref: WorkspaceRef): string =>
  ref.kind === "local"
    ? ref.path
    : `github:${ref.owner}/${ref.repo}@${ref.ref}`;

export const App = () => {
  const [workspace, setWorkspace] = useState<ResolvedWorkspace | null>(null);
  const [locale, setLocale] = useState<Locales>(getInitialLocale);
  const [isRestoring, setIsRestoring] = useState(true);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [githubModalOpen, setGithubModalOpen] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const resolveWorkspace = useCallback(
    async (ref: WorkspaceRef): Promise<ResolvedWorkspace> => {
      if (ref.kind === "local") {
        return { ref, localPath: ref.path };
      }
      const { root } = await window.filework.github.cloneRepo({
        credentialId: ref.credentialId,
        owner: ref.owner,
        repo: ref.repo,
        ref: ref.ref,
      });
      return { ref, localPath: root };
    },
    [],
  );

  // On launch: restore the most recent workspace
  useEffect(() => {
    const restore = async () => {
      try {
        const recent = await window.filework.getRecentWorkspaces();
        if (recent.length === 0) return;
        const top = recent[0];
        const ref: WorkspaceRef = decodeRef(top.metadata) ?? {
          kind: "local",
          path: top.path,
        };
        try {
          const resolved = await resolveWorkspace(ref);
          setWorkspace(resolved);
        } catch (err) {
          console.warn("[App] Failed to restore workspace:", err);
        }
      } finally {
        setIsRestoring(false);
      }
    };
    restore();
  }, [resolveWorkspace]);

  const recordRecent = (ref: WorkspaceRef, label: string) => {
    window.filework.addRecentWorkspace(recentKeyFor(ref), label, {
      kind: ref.kind,
      metadata: encodeRef(ref),
    });
  };

  const handleSelectLocal = (path: string) => {
    const ref: WorkspaceRef = { kind: "local", path };
    setSelectedFilePath(null);
    setWorkspace({ ref, localPath: path });
    recordRecent(ref, workspaceRefLabel(ref));
  };

  const handleSelectGithub = async (ref: WorkspaceRef) => {
    setGithubModalOpen(false);
    setResolveError(null);
    setIsRestoring(true);
    try {
      const resolved = await resolveWorkspace(ref);
      setSelectedFilePath(null);
      setWorkspace(resolved);
      recordRecent(ref, workspaceRefLabel(ref));
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRestoring(false);
    }
  };

  if (isRestoring) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background">
        <div className="titlebar-drag fixed top-0 left-0 right-0 h-12" />
      </div>
    );
  }

  const workspaceRefJson = workspace ? encodeRef(workspace.ref) : undefined;

  return (
    <TypesafeI18n key={locale} locale={locale}>
      {!workspace ? (
        <>
          <WelcomeScreen
            onSelectDirectory={handleSelectLocal}
            onSelectGithub={() => setGithubModalOpen(true)}
            errorMessage={resolveError}
          />
          {githubModalOpen && (
            <GitHubConnectModal
              onCancel={() => setGithubModalOpen(false)}
              onConfirm={handleSelectGithub}
            />
          )}
        </>
      ) : (
        <div className="flex h-screen w-screen overflow-hidden">
          <div className="titlebar-drag fixed top-0 left-0 right-0 h-12 z-50" />
          <Sidebar
            workspacePath={workspace.localPath}
            workspaceRef={workspace.ref}
            onChangeDirectory={handleSelectLocal}
            onCloseDirectory={() => setWorkspace(null)}
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
              <ChatPanel
                workspacePath={workspace.localPath}
                workspaceRefJson={workspaceRefJson}
              />
            </div>
          </main>
        </div>
      )}
    </TypesafeI18n>
  );
};

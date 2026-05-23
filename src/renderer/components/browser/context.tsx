import { createContext, type ReactNode, useContext, useMemo } from "react";

interface BrowserRouter {
  /** Open the given URL inside the right-side BrowserPanel. */
  openInPanel: (url: string) => void;
}

const Ctx = createContext<BrowserRouter | null>(null);

export function BrowserRouterProvider({
  openInPanel,
  children,
}: {
  openInPanel: (url: string) => void;
  children: ReactNode;
}) {
  const value = useMemo<BrowserRouter>(() => ({ openInPanel }), [openInPanel]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Returns the router if a provider is mounted, otherwise null. Callers
 *  fall back to `window.filework.openExternal` when null. */
export function useBrowserRouter(): BrowserRouter | null {
  return useContext(Ctx);
}

export type ThemePreference = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "filework-theme";

const SYSTEM_DARK_MEDIA = "(prefers-color-scheme: dark)";

export const isThemePreference = (
  value: string | null,
): value is ThemePreference =>
  value === "dark" || value === "light" || value === "system";

export const resolveThemeMode = (
  preference: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme => {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
};

const getPrefersDark = (): boolean =>
  window.matchMedia(SYSTEM_DARK_MEDIA).matches;

export const getStoredThemePreference = (): ThemePreference => {
  const saved = localStorage.getItem(THEME_STORAGE_KEY);
  return isThemePreference(saved) ? saved : "dark";
};

export const applyThemePreference = (
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
  prefersDark = getPrefersDark(),
): ResolvedTheme => {
  const resolved = resolveThemeMode(preference, prefersDark);
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.dataset.theme = resolved;
  return resolved;
};

export const setStoredThemePreference = (
  preference: ThemePreference,
): ResolvedTheme => {
  localStorage.setItem(THEME_STORAGE_KEY, preference);
  return applyThemePreference(preference);
};

export const startThemeSync = (): (() => void) => {
  const media = window.matchMedia(SYSTEM_DARK_MEDIA);
  const sync = () => applyThemePreference(getStoredThemePreference());
  sync();

  media.addEventListener("change", sync);
  return () => media.removeEventListener("change", sync);
};

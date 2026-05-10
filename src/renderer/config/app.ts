/**
 * Workspace Agent — application configuration.
 *
 * Note: the npm package name (`@filework/desktop`), preload namespace
 * (`window.filework.*`), on-disk data directory (`~/.filework/`), and
 * Electron appId (`com.filework.desktop`) intentionally retain the
 * legacy "filework" identifier — renaming them would invalidate user
 * data, code-signing identity, and the IPC surface. Only the display
 * name is rebranded.
 */

export const appConfig = {
  name: "Workspace Agent" as const,
  version: "0.1.0" as const,
  description: "General-purpose AI Agent for your local workspace" as const,

  // AI provider defaults
  ai: {
    defaultProvider: "openai" as const,
    defaultModel: "gpt-4o-mini" as const,
    providers: ["openai", "anthropic", "ollama", "custom"] as const,
  },

  // Supported languages
  i18n: {
    defaultLocale: "en" as const,
    locales: ["en", "zh-CN", "ja"] as const,
  },
};

export type AIProvider = (typeof appConfig.ai.providers)[number];

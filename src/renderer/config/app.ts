/**
 * FileWork Application Configuration
 */

export const appConfig = {
  name: "FileWork" as const,
  version: "0.1.0" as const,
  description: "Your Local File AI Assistant" as const,

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

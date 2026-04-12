import type { BaseTranslation } from "../i18n-types";

const en: BaseTranslation = {
  // Common
  appName: "FileWork",
  tagline: "Your Local File AI Assistant",

  // Welcome / Onboarding
  welcome_title: "FileWork",
  welcome_description:
    "Your local file AI assistant. Select a working directory and tell me what to do.",
  welcome_selectDirectory: "Select Working Directory",
  welcome_privacy:
    "FileWork only works within your selected directory. Your data never leaves your computer.",

  // Chat
  chat_placeholder: "Tell me what you want to do... (⌘+Enter to send)",
  chat_emptyTitle: "How can I help?",
  chat_emptyDescription: "Tell me what you want to do with this directory",

  // Suggestions
  suggestion_organize: "Organize files in this directory by type",
  suggestion_report: "Analyze this directory and generate a report",
  suggestion_duplicates: "Find all duplicate files",
  suggestion_stats: "Count files by type and size",

  // Sidebar
  sidebar_settings: "Settings",
  sidebar_collapse: "Collapse sidebar",

  // Settings
  settings_title: "Settings",
  settings_aiProvider: "AI Provider",
  settings_apiKey: "API Key",
  settings_model: "Model",
  settings_language: "Language",
  settings_theme: "Theme",
  settings_themeDark: "Dark",
  settings_themeLight: "Light",
  settings_themeSystem: "System",
  settings_testConnection: "Test Connection",

  // Tasks
  task_pending: "Pending",
  task_running: "Running",
  task_completed: "Completed",
  task_failed: "Failed",
  task_undo: "Undo",

  // LLM Configuration
  llmConfig_title: "LLM Channel Configuration",
  llmConfig_add: "Add Configuration",
  llmConfig_edit: "Edit",
  llmConfig_delete: "Delete",
  llmConfig_name: "Display Name",
  llmConfig_provider: "Provider",
  llmConfig_apiKey: "API Key",
  llmConfig_baseUrl: "Base URL",
  llmConfig_model: "Model",
  llmConfig_default: "Default",
  llmConfig_setDefault: "Set as Default",
  llmConfig_deleteConfirm:
    "Are you sure you want to delete this configuration?",
  llmConfig_deleteLastError: "At least one default configuration must be kept",
  llmConfig_validationRequired: "This field is required",
  llmConfig_authError:
    "API Key is invalid or expired, please check the channel configuration in settings",
  llmConfig_notFound: "Selected LLM configuration does not exist",
  llmConfig_save: "Save",
  llmConfig_cancel: "Cancel",

  // Errors
  error_unknown: "An unknown error occurred",
  error_aiConnection: "Failed to connect to AI provider",
  error_fileAccess: "Cannot access file or directory",
};

export default en;

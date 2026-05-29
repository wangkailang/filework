import type { BaseTranslation } from "../i18n-types";

const en: BaseTranslation = {
  // Common
  appName: "Workspace Agent",
  tagline: "Your Local AI Workspace Agent",

  // Welcome / Onboarding
  welcome_title: "Workspace Agent",
  welcome_description:
    "A general-purpose AI agent for your local workspace. Select a working directory and tell me what to do.",
  welcome_selectDirectory: "Select Working Directory",
  welcome_privacy:
    "Workspace Agent only operates inside your selected directory. Your data never leaves your computer.",

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
  sidebar_expand: "Expand sidebar",

  // TopBar / Rail / Dock (布局重构)
  topbar_history: "History",
  topbar_newChat: "New chat",
  topbar_settings: "Settings",
  rail_chats: "Chats",
  rail_files: "Files",
  dock_preview: "Preview",
  dock_diff: "Diff",
  dock_web: "Web",

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

  // Welcome extras
  welcome_recentlyOpened: "Recently Opened",
  welcome_remove: "Remove",

  // Session list
  session_history: "Chat History",
  session_close: "Close",
  session_empty: "No chat history",
  session_delete: "Delete chat",
  session_newChat: "New Chat",

  // Chat panel
  chat_reject: "Reject",
  chat_approve: "Approve",
  chat_approved: "Approved",
  chat_rejected: "Rejected",
  chat_error: "Error",
  chat_retrying: "Retrying ({0:string}/{1:string})...",
  chat_planGenerating: "Analyzing task, generating plan...",
  chat_thinking: "Thinking...",
  chat_forkHere: "Fork from here",
  chat_inputPlaceholder: "Tell me what you want to do... (Enter to send)",

  // Error types
  errorType_auth: "Auth Failed",
  errorType_authHint:
    "API key is invalid or expired, please check configuration in settings",
  errorType_billing: "Insufficient Balance",
  errorType_billingHint:
    "API account balance insufficient, please top up on the provider platform",
  errorType_rateLimit: "Rate Limited",
  errorType_rateLimitHint:
    "Request rate too high, auto-retried but still failed",
  errorType_contextOverflow: "Context Too Long",
  errorType_contextOverflowHint:
    "Conversation too long, please start a new chat",
  errorType_serverError: "Service Unavailable",
  errorType_serverErrorHint:
    "Server temporarily unavailable, please try again later",
  errorType_timeout: "Request Timeout",
  errorType_timeoutHint: "Connection timed out, please try again later",
  errorType_proxyIntercepted: "Network Blocked",
  errorType_proxyInterceptedHint:
    "Request blocked by proxy or firewall, please check network settings",

  // Retry labels
  retry_rateLimit: "Rate Limit",
  retry_contextOverflow: "Context Compression",
  retry_serverError: "Server Error",
  retry_timeout: "Connection Timeout",

  // Recovery actions
  recovery_retry: "Retry",
  recovery_settings: "Check Settings",
  recovery_newChat: "New Chat",

  // Tool states
  tool_preparing: "Preparing",
  tool_running: "Running",
  tool_done: "Done",
  tool_error: "Error",
  tool_params: "Parameters",
  tool_result: "Result",
  tool_errorLabel: "Error",

  // Tool names
  toolName_listDirectory: "List Directory",
  toolName_readFile: "Read File",
  toolName_writeFile: "Write File",
  toolName_moveFile: "Move File",
  toolName_createDirectory: "Create Directory",
  toolName_deleteFile: "Delete File",
  toolName_directoryStats: "Directory Stats",
  toolName_findDuplicates: "Find Duplicates",
  toolName_runCommand: "Run Command",

  // Tool summary (folded one-liner)
  tool_summary_lines: "{0:number} lines",
  tool_summary_dirs_files: "{0:number} dirs / {1:number} files",
  tool_summary_more: "… {0:number} more lines",
  tool_summary_exitCode: "exit {0:number}",
  tool_summary_group_label: "{0:number} {1:string} calls",
  tool_summary_new_file: "new file",
  tool_diff_label: "Diff",
  tool_stdout: "stdout",
  tool_stderr: "stderr",
  tool_show_full: "Show full content",
  tool_hide_full: "Hide",

  // Approval-card preview (codex-style change preview)
  preview_card_title_write: "Will write file",
  preview_card_title_overwrite: "Will overwrite file",
  preview_card_title_move: "Move / rename",
  preview_card_title_delete: "Delete",
  preview_card_title_mkdir: "Create directory",
  preview_card_title_run: "Run command",
  preview_binary_skipped: "Binary file, diff skipped",
  preview_too_large: "File too large (>1 MB); line counts only",
  preview_diff_truncated: "Diff truncated",
  preview_destination_exists: "Destination exists, will be overwritten",
  preview_source_missing: "Source does not exist",
  preview_parent_missing: "Parent directory does not exist",
  preview_cwd_missing: "Working directory does not exist",
  preview_already_exists: "Directory already exists",
  preview_dir_children: "{0} entries",
  preview_size_bytes: "{0} bytes",
  preview_no_changes: "No changes",

  // Branch diff drawer (codex-style aggregate diff)
  branch_diff_open: "View branch changes",
  branch_diff_title: "{0} vs {1}",
  branch_diff_empty: "No changes",
  branch_diff_not_git: "Workspace is not a git repository",
  branch_diff_no_base: "Base branch (main) not found",
  branch_diff_exec_failed: "git command failed",
  branch_diff_refresh: "Refresh",
  branch_diff_ahead: "{0} unpushed",
  branch_diff_behind: "{0} behind",
  branch_diff_uncommitted: "{0} uncommitted",

  // Plan viewer
  plan_title: "Execution Plan",
  plan_stalled: "Slow Response",
  plan_artifacts: "Artifacts ({0:string})",
  plan_reject: "Reject",
  plan_start: "Start Execution",
  plan_cancel: "Cancel Execution",
  plan_completed: "Plan completed",
  plan_failed: "Plan failed",
  plan_cancelled: "Plan cancelled",
  plan_stepError: "Error: {0:string}",
  plan_verify: "Verify",
  plan_reasoning: "Reasoning",

  // Clarification
  clarification_title: "Clarification Needed",

  // Conversation
  conv_scrollToBottom: "Scroll to bottom",
  conv_newMessages: "New messages",
  conv_roleUser: "User",
  conv_roleAssistant: "Assistant",
  conv_download: "Download conversation",

  // File preview
  preview_close: "Close preview",
  preview_loading: "Loading file...",
  preview_unsupported: "Preview not supported for",
  preview_unsupportedType: "this type",
  preview_files: "files",
  preview_zoomIn: "Zoom in",
  preview_zoomOut: "Zoom out",
  preview_readImageError: "Failed to read image",
  preview_readFileError: "Failed to read file",
  preview_videoError: "Unable to play this video file",
  preview_videoLabel: "Video preview: {0:string}",
  preview_truncated:
    "File too large ({0:string}); previewing the beginning only",

  // Code viewer
  code_loading: "Loading...",

  // Skill menu
  skill_loading: "Loading skills...",
  skill_notFound: 'No skills matching "{0:string}"',
  skill_searchHint: "Type skill name to search",

  // Skill approval
  skillApproval_title: "Skill Approval Request",
  skillApproval_name: "Skill Name:",
  skillApproval_source: "Source Path:",
  skillApproval_commands: "Commands to execute:",
  skillApproval_hooks: "Hook scripts:",
  skillApproval_reject: "Reject",
  skillApproval_approve: "Approve",

  // Skills modal
  skillsModal_title: "Skill Manager",
  skillsModal_search: "Search skills...",
  skillsModal_all: "All ({0:string})",
  skillsModal_notFound: "No matching skills found",
  skillsModal_task: "Task",
  skillsModal_tool: "Tool",
  skillsModal_autoMatch: "Auto Match",
  skillsModal_loading: "Loading...",
  skillsModal_notFoundInfo: "Skill info not found",
  skillsModal_taskType: "Task Type",
  skillsModal_toolType: "Tool Type",
  skillsModal_isolatedContext: "Isolated Context",
  skillsModal_manualOnly: "Manual Trigger Only",
  skillsModal_description: "Description",
  skillsModal_usage: "Usage",
  skillsModal_usageCommand: "/{0:string} <your instruction>",
  skillsModal_usageAuto:
    "Just describe your needs in the conversation, AI will auto-match this skill by keywords.",
  skillsModal_suggestions: "Suggested Prompts",
  skillsModal_keywords: "Keywords",
  skillsModal_sourcePath: "Source Path",
  skillsModal_showInFinder: "Show in Finder",
  skillsModal_allowedTools: "Allowed Tools",
  skillsModal_dependencies: "Dependencies",
  skillsModal_depCommand: "Command",
  skillsModal_depEnvVar: "Environment Variable",
  skillsModal_depSystem: "System",
  skillsModal_lifecycle: "Lifecycle",
  skillsModal_lifecycleHint:
    "This skill includes pre-activate / post-complete hook scripts",
  skillsModal_sourceBuiltIn: "Built-in",
  skillsModal_sourceProject: "Project",
  skillsModal_sourcePersonal: "Personal",
  skillsModal_sourceAdditional: "Additional",
  skillsModal_sourceDisabled: "Disabled",

  // Usage panel
  usage_loading: "Loading usage data...",
  usage_empty: "No usage data yet",
  usage_title: "Token Usage Statistics",
  usage_total: "Total",
  usage_input: "Input",
  usage_output: "Output",
  usage_byModel: "By Model",
  usage_tasks: "({0:string} tasks)",
  usage_recent: "Recent Usage",

  // Memory debug panel
  memoryDebug_title: "Memory Debug",
  memoryDebug_savedLabel: "saved",
  memoryDebug_contextCompression: "Context Compression",
  memoryDebug_compressionSkipped: "Compression Skipped",
  memoryDebug_compressionError: "Compression Failed",
  memoryDebug_compressionErrorShort: "Failed",
  memoryDebug_resultSummarize: "Result Summarized",
  memoryDebug_resultsSummarized: "{0:string} results summarized",
  memoryDebug_truncationDrop: "Messages Dropped",
  memoryDebug_messagesDroppedCount: "{0:string} messages dropped",
  memoryDebug_cacheWrite: "Cache Write",
  memoryDebug_cacheHit: "Cache Hit",
  memoryDebug_messagesCompressed: "({0:string} messages)",
  memoryDebug_notOverLimit: "(not over limit)",
  memoryDebug_cacheWriteTokens: "Wrote {0:string} tokens",
  memoryDebug_cacheReadTokens: "Hit {0:string} tokens",
  memoryDebug_loading: "Loading debug data...",
  memoryDebug_empty: "No Memory events yet",
  memoryDebug_emptyHint: "Context compression or cache events will appear here",
  memoryDebug_clear: "Clear",
  memoryDebug_hitTimes: "{0:string} hits",
  memoryDebug_eventLog: "Event Log ({0:string})",
  memoryDebug_visualization: "Visualization",
  memoryDebug_tokenTimeline: "Token Compression",
  memoryDebug_cacheActivity: "Cache Activity",
  memoryDebug_eventTypes: "Event Types",
  memoryDebug_original: "Original",
  memoryDebug_compressed: "Compressed",
  memoryDebug_written: "Written",
  memoryDebug_read: "Read",
  memoryDebug_noData: "No data",

  // Sidebar extras
  sidebar_refresh: "Refresh directory",
  sidebar_closeDir: "Close directory",
  sidebar_skills: "Skills",
  sidebar_permissionDenied: "Permission denied",
  sidebar_permissionDeniedHint:
    "macOS is blocking access to this folder. Grant access under System Settings → Privacy & Security → Files and Folders.",
  sidebar_folderNotFound: "Folder not found",
  sidebar_openSystemSettings: "Open System Settings",
  sidebar_retry: "Retry",

  // useChatSession
  chat_userStopped: "User stopped execution",
  chat_planExecution: "Execution plan: {0:string}",
  chat_planFailed: "Plan generation failed: {0:string}",
  chat_connectionTimeout:
    "Connection timed out, failed to establish connection to AI service",
  chat_unknownError: "Unknown error",

  // Errors
  error_unknown: "An unknown error occurred",
  error_aiConnection: "Failed to connect to AI provider",
  error_fileAccess: "Cannot access file or directory",

  // In-app browser panel
  browser_back: "Back",
  browser_forward: "Forward",
  browser_reload: "Reload",
  browser_stop: "Stop",
  browser_close: "Close browser",
  browser_open_external: "Open in system browser",
  browser_url_placeholder: "Enter URL…",
  browser_failed_to_load: "Failed to load page",
};

export default en;

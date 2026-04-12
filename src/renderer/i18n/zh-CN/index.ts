import type { Translation } from "../i18n-types";

const zhCN: Translation = {
  appName: "FileWork",
  tagline: "你的本地文件 AI 助手",

  welcome_title: "FileWork",
  welcome_description:
    "你的本地文件 AI 助手。选择一个工作目录，告诉我你想做什么。",
  welcome_selectDirectory: "选择工作目录",
  welcome_privacy: "FileWork 只在你选择的目录中工作，数据不会离开你的电脑。",

  chat_placeholder: "告诉我你想做什么... (⌘+Enter 发送)",
  chat_emptyTitle: "有什么可以帮你的？",
  chat_emptyDescription: "告诉我你想对这个目录做什么",

  suggestion_organize: "帮我整理这个目录的文件，按类型分类",
  suggestion_report: "分析这个目录的内容，生成一份报告",
  suggestion_duplicates: "找出所有重复的文件",
  suggestion_stats: "统计各类型文件的数量和大小",

  sidebar_settings: "设置",
  sidebar_collapse: "折叠侧栏",

  settings_title: "设置",
  settings_aiProvider: "AI 服务商",
  settings_apiKey: "API 密钥",
  settings_model: "模型",
  settings_language: "语言",
  settings_theme: "主题",
  settings_themeDark: "深色",
  settings_themeLight: "浅色",
  settings_themeSystem: "跟随系统",
  settings_testConnection: "测试连接",

  task_pending: "等待中",
  task_running: "执行中",
  task_completed: "已完成",
  task_failed: "失败",
  task_undo: "撤销",

  llmConfig_title: "LLM 渠道配置",
  llmConfig_add: "添加配置",
  llmConfig_edit: "编辑",
  llmConfig_delete: "删除",
  llmConfig_name: "显示名称",
  llmConfig_provider: "服务商",
  llmConfig_apiKey: "API 密钥",
  llmConfig_baseUrl: "Base URL",
  llmConfig_model: "模型",
  llmConfig_default: "默认",
  llmConfig_setDefault: "设为默认",
  llmConfig_deleteConfirm: "确定要删除此配置吗？",
  llmConfig_deleteLastError: "至少保留一条默认配置",
  llmConfig_validationRequired: "此字段为必填项",
  llmConfig_authError: "API Key 无效或已过期，请在设置中检查该渠道配置",
  llmConfig_notFound: "所选 LLM 配置不存在",
  llmConfig_save: "保存",
  llmConfig_cancel: "取消",

  error_unknown: "发生未知错误",
  error_aiConnection: "无法连接 AI 服务",
  error_fileAccess: "无法访问文件或目录",
};

export default zhCN;

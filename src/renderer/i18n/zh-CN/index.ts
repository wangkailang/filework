import type { Translation } from "../i18n-types";

const zhCN: Translation = {
  appName: "Workspace Agent",
  tagline: "你的本地 AI 工作区代理",

  welcome_title: "Workspace Agent",
  welcome_description:
    "通用的本地 AI Agent。选择一个工作目录，告诉我你想做什么。",
  welcome_selectDirectory: "选择工作目录",
  welcome_privacy:
    "Workspace Agent 只在你选择的目录中工作，数据不会离开你的电脑。",

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

  // Welcome extras
  welcome_recentlyOpened: "最近打开",
  welcome_remove: "移除",

  // Session list
  session_history: "历史对话",
  session_close: "关闭",
  session_empty: "暂无历史对话",
  session_delete: "删除对话",
  session_newChat: "新对话",

  // Chat panel
  chat_reject: "拒绝",
  chat_approve: "批准",
  chat_approved: "已批准执行",
  chat_rejected: "已拒绝执行",
  chat_error: "出错了",
  chat_retrying: "正在重试 ({0}/{1})...",
  chat_planGenerating: "正在分析任务，生成执行计划...",
  chat_thinking: "思考中...",
  chat_forkHere: "从此处分支",
  chat_inputPlaceholder: "告诉我你想做什么... (Enter 发送)",

  // Error types
  errorType_auth: "认证失败",
  errorType_authHint: "API 密钥无效或已过期，请在设置中检查配置",
  errorType_billing: "余额不足",
  errorType_billingHint: "API 账户余额不足，请前往对应平台充值后重试",
  errorType_rateLimit: "频率超限",
  errorType_rateLimitHint: "请求频率过高，已自动重试但仍然失败",
  errorType_contextOverflow: "上下文过长",
  errorType_contextOverflowHint: "对话过长，建议开启新对话",
  errorType_serverError: "服务不可用",
  errorType_serverErrorHint: "服务端暂时不可用，请稍后重试",
  errorType_timeout: "请求超时",
  errorType_timeoutHint: "连接超时，请稍后重试",
  errorType_proxyIntercepted: "网络拦截",
  errorType_proxyInterceptedHint: "请求被代理或防火墙拦截，请检查网络环境",

  // Retry labels
  retry_rateLimit: "频率限制",
  retry_contextOverflow: "上下文压缩",
  retry_serverError: "服务错误",
  retry_timeout: "连接超时",

  // Recovery actions
  recovery_retry: "重试",
  recovery_settings: "检查配置",
  recovery_newChat: "新对话",

  // Tool states
  tool_preparing: "准备中",
  tool_running: "执行中",
  tool_done: "完成",
  tool_error: "出错",
  tool_params: "参数",
  tool_result: "结果",
  tool_errorLabel: "错误",

  // Tool names
  toolName_listDirectory: "列出目录",
  toolName_readFile: "读取文件",
  toolName_writeFile: "写入文件",
  toolName_moveFile: "移动文件",
  toolName_createDirectory: "创建目录",
  toolName_deleteFile: "删除文件",
  toolName_directoryStats: "目录统计",
  toolName_findDuplicates: "查找重复文件",
  toolName_runCommand: "执行命令",

  // Plan viewer
  plan_title: "执行计划",
  plan_stalled: "响应缓慢",
  plan_artifacts: "操作明细 ({0})",
  plan_reject: "拒绝",
  plan_start: "开始执行",
  plan_cancel: "取消执行",
  plan_completed: "计划执行完成",
  plan_failed: "计划执行失败",
  plan_cancelled: "计划已取消",
  plan_stepError: "错误: {0}",
  plan_verify: "验证",

  // Clarification
  clarification_title: "需要确认",

  // Conversation
  conv_scrollToBottom: "滚动到底部",
  conv_newMessages: "新消息",
  conv_roleUser: "用户",
  conv_roleAssistant: "助手",
  conv_download: "下载对话",

  // File preview
  preview_close: "关闭预览",
  preview_loading: "读取文件中...",
  preview_unsupported: "暂不支持预览",
  preview_unsupportedType: "此类型",
  preview_files: "文件",
  preview_zoomIn: "放大",
  preview_zoomOut: "缩小",
  preview_readImageError: "读取图片失败",
  preview_readFileError: "读取文件失败",
  preview_videoError: "无法播放此视频文件",
  preview_videoLabel: "视频预览: {0}",

  // Code viewer
  code_loading: "加载中...",

  // Skill menu
  skill_loading: "正在加载技能...",
  skill_notFound: '未找到匹配 "{0}" 的技能',
  skill_searchHint: "输入技能名称进行搜索",

  // Skill approval
  skillApproval_title: "技能审批请求",
  skillApproval_name: "技能名称：",
  skillApproval_source: "来源路径：",
  skillApproval_commands: "将执行的命令：",
  skillApproval_hooks: "Hooks 脚本：",
  skillApproval_reject: "拒绝",
  skillApproval_approve: "批准",

  // Skills modal
  skillsModal_title: "技能管理",
  skillsModal_search: "搜索技能...",
  skillsModal_all: "全部 ({0})",
  skillsModal_notFound: "未找到匹配的技能",
  skillsModal_task: "任务",
  skillsModal_tool: "工具",
  skillsModal_autoMatch: "自动匹配",
  skillsModal_loading: "加载中...",
  skillsModal_notFoundInfo: "未找到技能信息",
  skillsModal_taskType: "任务型",
  skillsModal_toolType: "工具型",
  skillsModal_isolatedContext: "独立上下文",
  skillsModal_manualOnly: "仅手动触发",
  skillsModal_description: "描述",
  skillsModal_usage: "使用方式",
  skillsModal_usageCommand: "/{0} <你的指令>",
  skillsModal_usageAuto:
    "在对话中直接描述需求即可，AI 会根据关键词自动匹配此技能。",
  skillsModal_suggestions: "建议提示词",
  skillsModal_keywords: "关键词",
  skillsModal_sourcePath: "来源路径",
  skillsModal_showInFinder: "在 Finder 中显示",
  skillsModal_allowedTools: "允许的工具",
  skillsModal_dependencies: "运行依赖",
  skillsModal_depCommand: "命令",
  skillsModal_depEnvVar: "环境变量",
  skillsModal_depSystem: "系统",
  skillsModal_lifecycle: "生命周期",
  skillsModal_lifecycleHint: "此技能包含 pre-activate / post-complete 钩子脚本",
  skillsModal_sourceBuiltIn: "内置",
  skillsModal_sourceProject: "项目",
  skillsModal_sourcePersonal: "个人",
  skillsModal_sourceAdditional: "扩展",

  // Usage panel
  usage_loading: "加载用量数据...",
  usage_empty: "暂无用量数据",
  usage_title: "Token 用量统计",
  usage_total: "总消耗",
  usage_input: "输入",
  usage_output: "输出",
  usage_byModel: "按模型",
  usage_tasks: "({0} 次)",
  usage_recent: "最近使用",

  // Memory debug panel
  memoryDebug_title: "内存调试",
  memoryDebug_savedLabel: "已节省",
  memoryDebug_contextCompression: "Context 压缩",
  memoryDebug_compressionSkipped: "压缩跳过",
  memoryDebug_compressionError: "压缩失败",
  memoryDebug_compressionErrorShort: "失败",
  memoryDebug_resultSummarize: "结果摘要",
  memoryDebug_resultsSummarized: "已摘要 {0} 个结果",
  memoryDebug_truncationDrop: "消息丢弃",
  memoryDebug_messagesDroppedCount: "丢弃 {0} 条消息",
  memoryDebug_cacheWrite: "Cache 写入",
  memoryDebug_cacheHit: "Cache 命中",
  memoryDebug_messagesCompressed: "({0} 条)",
  memoryDebug_notOverLimit: "(未超限)",
  memoryDebug_cacheWriteTokens: "写入 {0} tokens",
  memoryDebug_cacheReadTokens: "命中 {0} tokens",
  memoryDebug_loading: "加载调试数据...",
  memoryDebug_empty: "暂无 Memory 事件",
  memoryDebug_emptyHint: "对话触发 Context 压缩或 Cache 后将显示在这里",
  memoryDebug_clear: "清除",
  memoryDebug_hitTimes: "{0} 次命中",
  memoryDebug_eventLog: "事件日志 ({0})",
  memoryDebug_visualization: "可视化",
  memoryDebug_tokenTimeline: "Token 压缩",
  memoryDebug_cacheActivity: "缓存活动",
  memoryDebug_eventTypes: "事件类型",
  memoryDebug_original: "原始",
  memoryDebug_compressed: "压缩后",
  memoryDebug_written: "写入",
  memoryDebug_read: "读取",
  memoryDebug_noData: "暂无数据",

  // Sidebar extras
  sidebar_refresh: "刷新目录",
  sidebar_closeDir: "关闭目录",
  sidebar_skills: "技能",

  // useChatSession
  chat_userStopped: "用户已停止执行",
  chat_planExecution: "执行计划: {0}",
  chat_planFailed: "计划生成失败: {0}",
  chat_connectionTimeout: "连接超时，未能建立与 AI 服务的连接",
  chat_unknownError: "未知错误",

  // Errors
  error_unknown: "发生未知错误",
  error_aiConnection: "无法连接 AI 服务",
  error_fileAccess: "无法访问文件或目录",
};

export default zhCN;

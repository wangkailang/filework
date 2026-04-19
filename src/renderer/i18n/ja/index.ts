import type { Translation } from "../i18n-types";

const ja: Translation = {
  appName: "FileWork",
  tagline: "ローカルファイルAIアシスタント",

  welcome_title: "FileWork",
  welcome_description:
    "ローカルファイルAIアシスタント。作業ディレクトリを選択して、やりたいことを教えてください。",
  welcome_selectDirectory: "作業ディレクトリを選択",
  welcome_privacy:
    "FileWorkは選択したディレクトリ内でのみ動作します。データはコンピュータから離れません。",

  chat_placeholder: "やりたいことを教えてください... (⌘+Enter で送信)",
  chat_emptyTitle: "何かお手伝いできますか？",
  chat_emptyDescription: "このディレクトリで何をしたいか教えてください",

  suggestion_organize: "このディレクトリのファイルを種類別に整理",
  suggestion_report: "このディレクトリの内容を分析してレポートを生成",
  suggestion_duplicates: "重複ファイルをすべて検出",
  suggestion_stats: "ファイルの種類とサイズを集計",

  sidebar_settings: "設定",
  sidebar_collapse: "サイドバーを折りたたむ",

  settings_title: "設定",
  settings_aiProvider: "AIプロバイダー",
  settings_apiKey: "APIキー",
  settings_model: "モデル",
  settings_language: "言語",
  settings_theme: "テーマ",
  settings_themeDark: "ダーク",
  settings_themeLight: "ライト",
  settings_themeSystem: "システム",
  settings_testConnection: "接続テスト",

  task_pending: "待機中",
  task_running: "実行中",
  task_completed: "完了",
  task_failed: "失敗",
  task_undo: "元に戻す",

  llmConfig_title: "LLMチャネル設定",
  llmConfig_add: "設定を追加",
  llmConfig_edit: "編集",
  llmConfig_delete: "削除",
  llmConfig_name: "表示名",
  llmConfig_provider: "プロバイダー",
  llmConfig_apiKey: "APIキー",
  llmConfig_baseUrl: "ベースURL",
  llmConfig_model: "モデル",
  llmConfig_default: "デフォルト",
  llmConfig_setDefault: "デフォルトに設定",
  llmConfig_deleteConfirm: "この設定を削除してもよろしいですか？",
  llmConfig_deleteLastError:
    "デフォルト設定を少なくとも1つ保持する必要があります",
  llmConfig_validationRequired: "この項目は必須です",
  llmConfig_authError:
    "APIキーが無効または期限切れです。設定でチャネル構成を確認してください",
  llmConfig_notFound: "選択されたLLM設定が存在しません",
  llmConfig_save: "保存",
  llmConfig_cancel: "キャンセル",

  // Welcome extras
  welcome_recentlyOpened: "最近開いた",
  welcome_remove: "削除",

  // Session list
  session_history: "チャット履歴",
  session_close: "閉じる",
  session_empty: "チャット履歴がありません",
  session_delete: "チャットを削除",
  session_newChat: "新しいチャット",

  // Chat panel
  chat_reject: "拒否",
  chat_approve: "承認",
  chat_approved: "承認済み",
  chat_rejected: "拒否済み",
  chat_error: "エラーが発生しました",
  chat_retrying: "リトライ中 ({0}/{1})...",
  chat_planGenerating: "タスクを分析し、実行計画を生成中...",
  chat_thinking: "考え中...",
  chat_forkHere: "ここから分岐",
  chat_inputPlaceholder: "やりたいことを教えてください... (Enter で送信)",

  // Error types
  errorType_auth: "認証失敗",
  errorType_authHint:
    "APIキーが無効または期限切れです。設定で構成を確認してください",
  errorType_billing: "残高不足",
  errorType_billingHint:
    "APIアカウントの残高が不足しています。プラットフォームでチャージしてください",
  errorType_rateLimit: "レート制限超過",
  errorType_rateLimitHint:
    "リクエスト頻度が高すぎます。自動リトライしましたが失敗しました",
  errorType_contextOverflow: "コンテキスト超過",
  errorType_contextOverflowHint:
    "会話が長すぎます。新しいチャットを開始してください",
  errorType_serverError: "サービス利用不可",
  errorType_serverErrorHint:
    "サーバーが一時的に利用できません。しばらくしてから再試行してください",
  errorType_timeout: "リクエストタイムアウト",
  errorType_timeoutHint:
    "接続がタイムアウトしました。しばらくしてから再試行してください",
  errorType_proxyIntercepted: "ネットワークブロック",
  errorType_proxyInterceptedHint:
    "リクエストがプロキシまたはファイアウォールにブロックされました。ネットワーク設定を確認してください",

  // Retry labels
  retry_rateLimit: "レート制限",
  retry_contextOverflow: "コンテキスト圧縮",
  retry_serverError: "サーバーエラー",
  retry_timeout: "接続タイムアウト",

  // Recovery actions
  recovery_retry: "リトライ",
  recovery_settings: "設定を確認",
  recovery_newChat: "新しいチャット",

  // Tool states
  tool_preparing: "準備中",
  tool_running: "実行中",
  tool_done: "完了",
  tool_error: "エラー",
  tool_params: "パラメータ",
  tool_result: "結果",
  tool_errorLabel: "エラー",

  // Tool names
  toolName_listDirectory: "ディレクトリ一覧",
  toolName_readFile: "ファイル読取",
  toolName_writeFile: "ファイル書込",
  toolName_moveFile: "ファイル移動",
  toolName_createDirectory: "ディレクトリ作成",
  toolName_deleteFile: "ファイル削除",
  toolName_directoryStats: "ディレクトリ統計",
  toolName_findDuplicates: "重複ファイル検出",
  toolName_runCommand: "コマンド実行",

  // Plan viewer
  plan_title: "実行計画",
  plan_stalled: "応答が遅い",
  plan_artifacts: "操作詳細 ({0})",
  plan_reject: "拒否",
  plan_start: "実行開始",
  plan_cancel: "実行キャンセル",
  plan_completed: "計画完了",
  plan_failed: "計画失敗",
  plan_cancelled: "計画キャンセル済み",
  plan_stepError: "エラー: {0}",

  // Conversation
  conv_scrollToBottom: "一番下にスクロール",
  conv_newMessages: "新しいメッセージ",
  conv_roleUser: "ユーザー",
  conv_roleAssistant: "アシスタント",
  conv_download: "会話をダウンロード",

  // File preview
  preview_close: "プレビューを閉じる",
  preview_loading: "ファイルを読み込み中...",
  preview_unsupported: "プレビュー非対応",
  preview_unsupportedType: "このタイプ",
  preview_files: "ファイル",
  preview_zoomIn: "拡大",
  preview_zoomOut: "縮小",
  preview_readImageError: "画像の読み込みに失敗しました",
  preview_readFileError: "ファイルの読み込みに失敗しました",
  preview_videoError: "この動画ファイルを再生できません",
  preview_videoLabel: "動画プレビュー: {0}",

  // Code viewer
  code_loading: "読み込み中...",

  // Skill menu
  skill_loading: "スキルを読み込み中...",
  skill_notFound: '"{0}" に一致するスキルが見つかりません',
  skill_searchHint: "スキル名を入力して検索",

  // Skill approval
  skillApproval_title: "スキル承認リクエスト",
  skillApproval_name: "スキル名：",
  skillApproval_source: "ソースパス：",
  skillApproval_commands: "実行するコマンド：",
  skillApproval_hooks: "Hooksスクリプト：",
  skillApproval_reject: "拒否",
  skillApproval_approve: "承認",

  // Skills modal
  skillsModal_title: "スキル管理",
  skillsModal_search: "スキルを検索...",
  skillsModal_all: "すべて ({0})",
  skillsModal_notFound: "一致するスキルが見つかりません",
  skillsModal_task: "タスク",
  skillsModal_tool: "ツール",
  skillsModal_autoMatch: "自動マッチ",
  skillsModal_loading: "読み込み中...",
  skillsModal_notFoundInfo: "スキル情報が見つかりません",
  skillsModal_taskType: "タスク型",
  skillsModal_toolType: "ツール型",
  skillsModal_isolatedContext: "独立コンテキスト",
  skillsModal_manualOnly: "手動トリガーのみ",
  skillsModal_description: "説明",
  skillsModal_usage: "使用方法",
  skillsModal_usageCommand: "/{0} <指示>",
  skillsModal_usageAuto:
    "会話で要件を説明するだけで、AIがキーワードに基づいてこのスキルを自動マッチします。",
  skillsModal_suggestions: "おすすめプロンプト",
  skillsModal_keywords: "キーワード",
  skillsModal_sourcePath: "ソースパス",
  skillsModal_showInFinder: "Finderで表示",
  skillsModal_allowedTools: "許可されたツール",
  skillsModal_dependencies: "実行依存",
  skillsModal_depCommand: "コマンド",
  skillsModal_depEnvVar: "環境変数",
  skillsModal_depSystem: "システム",
  skillsModal_lifecycle: "ライフサイクル",
  skillsModal_lifecycleHint:
    "このスキルにはpre-activate / post-completeフックスクリプトが含まれています",
  skillsModal_sourceBuiltIn: "ビルトイン",
  skillsModal_sourceProject: "プロジェクト",
  skillsModal_sourcePersonal: "個人",
  skillsModal_sourceAdditional: "拡張",

  // Usage panel
  usage_loading: "使用量データを読み込み中...",
  usage_empty: "使用量データがありません",
  usage_title: "トークン使用量統計",
  usage_total: "合計",
  usage_input: "入力",
  usage_output: "出力",
  usage_byModel: "モデル別",
  usage_tasks: "({0} 回)",
  usage_recent: "最近の使用",

  // Memory debug panel
  memoryDebug_contextCompression: "Context圧縮",
  memoryDebug_compressionSkipped: "圧縮スキップ",
  memoryDebug_cacheWrite: "Cache書き込み",
  memoryDebug_cacheHit: "Cacheヒット",
  memoryDebug_messagesCompressed: "({0} 件)",
  memoryDebug_notOverLimit: "(制限内)",
  memoryDebug_cacheWriteTokens: "{0} tokens書き込み",
  memoryDebug_cacheReadTokens: "{0} tokensヒット",
  memoryDebug_loading: "デバッグデータを読み込み中...",
  memoryDebug_empty: "Memoryイベントがありません",
  memoryDebug_emptyHint: "Context圧縮やCacheイベントがここに表示されます",
  memoryDebug_clear: "クリア",
  memoryDebug_compressionCount: "圧縮回数",
  memoryDebug_avgRatio: "平均圧縮率 {0}",
  memoryDebug_compressionSaved: "圧縮節約",
  memoryDebug_cacheHitCount: "Cacheヒット",
  memoryDebug_hitTimes: "{0} 回ヒット",
  memoryDebug_eventLog: "イベントログ ({0})",

  // Sidebar extras
  sidebar_refresh: "ディレクトリを更新",
  sidebar_closeDir: "ディレクトリを閉じる",
  sidebar_skills: "スキル",

  // useChatSession
  chat_userStopped: "ユーザーが実行を停止しました",
  chat_planExecution: "実行計画: {0}",
  chat_planFailed: "計画生成に失敗: {0}",
  chat_connectionTimeout:
    "接続タイムアウト、AIサービスへの接続を確立できませんでした",
  chat_unknownError: "不明なエラー",

  // Errors
  error_unknown: "不明なエラーが発生しました",
  error_aiConnection: "AIプロバイダーに接続できません",
  error_fileAccess: "ファイルまたはディレクトリにアクセスできません",
};

export default ja;

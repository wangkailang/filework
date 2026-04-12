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

  error_unknown: "不明なエラーが発生しました",
  error_aiConnection: "AIプロバイダーに接続できません",
  error_fileAccess: "ファイルまたはディレクトリにアクセスできません",
};

export default ja;

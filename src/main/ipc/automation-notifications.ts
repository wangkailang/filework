import { app, Notification as ElectronNotification } from "electron";

import type { AutomationRunRecord } from "../db";

type AutomationNotificationOptions = {
  body: string;
  title: string;
};

type AutomationNotification = {
  on?: (event: "click", handler: () => void) => void;
  show: () => void;
};

type AutomationNotificationFactory = unknown;

interface AutomationRunNotifierDeps {
  Notification?: AutomationNotificationFactory;
  getLocale?: () => string | null | undefined;
  isSupported?: () => boolean;
  onClick?: (run: AutomationRunRecord) => void;
}

const defaultIsSupported = (): boolean => {
  try {
    return ElectronNotification.isSupported();
  } catch {
    return false;
  }
};

type AutomationNotificationLocale = "en" | "ja" | "zh-CN";

const normalizeLocale = (
  locale: string | null | undefined,
): AutomationNotificationLocale => {
  const normalized = locale?.toLowerCase() ?? "";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("zh")) return "zh-CN";
  return "en";
};

const notificationCopy: Record<
  AutomationNotificationLocale,
  {
    failedFallback: string;
    failedTitle: string;
    needsActionFallback: string;
    needsActionTitle: string;
  }
> = {
  en: {
    failedFallback: "Open Triage for details",
    failedTitle: "Automation run failed",
    needsActionFallback: "Open Triage for details",
    needsActionTitle: "Automation needs attention",
  },
  ja: {
    failedFallback: "Triage で詳細を確認してください",
    failedTitle: "自動化の実行に失敗しました",
    needsActionFallback: "Triage で詳細を確認してください",
    needsActionTitle: "自動化の対応が必要です",
  },
  "zh-CN": {
    failedFallback: "请打开 Triage 查看详情",
    failedTitle: "自动化运行失败",
    needsActionFallback: "请打开 Triage 查看详情",
    needsActionTitle: "自动化需要处理",
  },
};

const getAttentionMessage = (
  run: AutomationRunRecord,
  locale: AutomationNotificationLocale,
): { body: string; title: string } | null => {
  const copy = notificationCopy[locale];
  if (run.status === "failed") {
    return {
      title: copy.failedTitle,
      body: `${run.automationTitle}: ${run.errorMessage ?? copy.failedFallback}`,
    };
  }

  if (run.status === "needs_action") {
    return {
      title: copy.needsActionTitle,
      body: `${run.automationTitle}: ${
        run.needsActionReason ?? run.errorMessage ?? copy.needsActionFallback
      }`,
    };
  }

  return null;
};

const createNotification = (
  Notification: AutomationNotificationFactory,
  options: AutomationNotificationOptions,
): AutomationNotification => {
  try {
    return (
      Notification as (
        options: AutomationNotificationOptions,
      ) => AutomationNotification
    )(options);
  } catch {
    const NotificationConstructor = Notification as new (
      options: AutomationNotificationOptions,
    ) => AutomationNotification;
    return new NotificationConstructor(options);
  }
};

let automationRunNotificationClickHandler:
  | ((run: AutomationRunRecord) => void)
  | null = null;

export const setAutomationRunNotificationClickHandler = (
  handler: ((run: AutomationRunRecord) => void) | null,
): void => {
  automationRunNotificationClickHandler = handler;
};

export const createAutomationRunNotifier = ({
  Notification = ElectronNotification,
  getLocale = () => app?.getLocale?.() ?? "zh-CN",
  isSupported = defaultIsSupported,
  onClick,
}: AutomationRunNotifierDeps = {}) => {
  return (run: AutomationRunRecord): void => {
    const message = getAttentionMessage(run, normalizeLocale(getLocale()));
    if (!message || !isSupported()) return;

    try {
      const notification = createNotification(Notification, message);
      const clickHandler =
        onClick ??
        ((clickedRun: AutomationRunRecord) =>
          automationRunNotificationClickHandler?.(clickedRun));
      notification.on?.("click", () => clickHandler(run));
      notification.show();
    } catch (error) {
      console.warn("Failed to show automation notification", error);
    }
  };
};

export const notifyAutomationRunAttention = createAutomationRunNotifier();

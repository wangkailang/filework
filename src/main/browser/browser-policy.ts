import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";

import {
  BROWSER_SETTING_STORAGE_KEYS,
  type BrowserAction,
  type BrowserApprovalDecision,
  type BrowserApprovalRequest,
  type BrowserObservation,
  type BrowserSettings,
  type BrowserSettingsPatch,
  decodeBrowserSettings,
  encodeBrowserSetting,
  parseBrowserUrl,
} from "../../shared/browser";
import type { BeforeToolCallHook } from "../core/agent/tool-registry";
import { getSetting, setSetting } from "../db";
import type { BrowserManagerContract } from "./browser-manager";
import type { BrowserObserver } from "./browser-observer";
import { browserActionTarget, classifyBrowserActionRisk } from "./browser-risk";

const BROWSER_TOOL_NAMES = new Set([
  "browserOpen",
  "browserTabs",
  "browserSwitchTab",
  "browserSnapshot",
  "browserClick",
  "browserType",
  "browserPress",
  "browserScroll",
  "browserClose",
]);

const BROWSER_ACTION_TOOL_NAMES = new Set([
  "browserClick",
  "browserType",
  "browserPress",
  "browserScroll",
]);

interface PendingBrowserApproval {
  taskId: string;
  request: BrowserApprovalRequest;
  resolve: (decision: BrowserApprovalDecision) => void;
}

const pendingBrowserApprovals = new Map<string, PendingBrowserApproval>();
const taskOriginGrants = new Map<string, Set<string>>();

export interface BrowserPolicyDependencies {
  manager: Pick<BrowserManagerContract, "listTabs">;
  observer: Pick<BrowserObserver, "requireSnapshot">;
  sender: Pick<WebContents, "isDestroyed" | "send">;
  taskId: string;
  getSettings?: () => BrowserSettings;
  updateSettings?: (patch: BrowserSettingsPatch) => BrowserSettings;
  requestApproval?: (
    request: BrowserApprovalRequest,
    signal: AbortSignal,
  ) => Promise<BrowserApprovalDecision>;
  createRequestId?: () => string;
}

const readSettings = (): BrowserSettings => decodeBrowserSettings(getSetting);

const writeSettings = (patch: BrowserSettingsPatch): BrowserSettings => {
  for (const [rawKey, value] of Object.entries(patch)) {
    const key = rawKey as keyof BrowserSettings;
    setSetting(
      BROWSER_SETTING_STORAGE_KEYS[key],
      encodeBrowserSetting(key, value as never),
    );
  }
  return readSettings();
};

export const isBrowserToolName = (toolName: string): boolean =>
  BROWSER_TOOL_NAMES.has(toolName);

const requestThroughRenderer = (
  sender: Pick<WebContents, "isDestroyed" | "send">,
  request: BrowserApprovalRequest,
  signal: AbortSignal,
): Promise<BrowserApprovalDecision> => {
  if (sender.isDestroyed()) return Promise.resolve("deny");
  return new Promise((resolve) => {
    const settle = (decision: BrowserApprovalDecision) => {
      signal.removeEventListener("abort", onAbort);
      pendingBrowserApprovals.delete(request.requestId);
      resolve(decision);
    };
    const onAbort = () => settle("deny");
    pendingBrowserApprovals.set(request.requestId, {
      taskId: request.taskId,
      request,
      resolve: settle,
    });
    sender.send("browser:approval-request", request);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
};

export const respondBrowserApproval = (
  requestId: string,
  decision: BrowserApprovalDecision,
): boolean => {
  const pending = pendingBrowserApprovals.get(requestId);
  if (!pending) return false;
  const allowed =
    pending.request.kind === "origin"
      ? new Set<BrowserApprovalDecision>([
          "allow-once",
          "always-allow",
          "block",
        ])
      : new Set<BrowserApprovalDecision>(["approve-once", "deny"]);
  if (!allowed.has(decision)) return false;
  pending.resolve(decision);
  return true;
};

export const clearBrowserPolicyTask = (taskId: string): void => {
  taskOriginGrants.delete(taskId);
  for (const [requestId, pending] of pendingBrowserApprovals) {
    if (pending.taskId !== taskId) continue;
    pendingBrowserApprovals.delete(requestId);
    pending.resolve("deny");
  }
};

const onceGrantsFor = (taskId: string): Set<string> => {
  const current = taskOriginGrants.get(taskId);
  if (current) return current;
  const created = new Set<string>();
  taskOriginGrants.set(taskId, created);
  return created;
};

const actionFromCall = (
  toolName: string,
  args: Record<string, unknown>,
): BrowserAction | null => {
  const ref = typeof args.ref === "string" ? args.ref : undefined;
  switch (toolName) {
    case "browserClick":
      return ref ? { type: "click", ref } : null;
    case "browserType":
      return ref && typeof args.text === "string"
        ? {
            type: "type",
            ref,
            text: args.text,
            clear: args.clear !== false,
          }
        : null;
    case "browserPress":
      return typeof args.key === "string"
        ? { type: "press", key: args.key, ...(ref && { ref }) }
        : null;
    case "browserScroll":
      return {
        type: "scroll",
        ...(typeof args.deltaX === "number" && { deltaX: args.deltaX }),
        ...(typeof args.deltaY === "number" && { deltaY: args.deltaY }),
      };
    default:
      return null;
  }
};

export const buildBrowserPolicyHook = (
  dependencies: BrowserPolicyDependencies,
): BeforeToolCallHook => {
  const getSettings = dependencies.getSettings ?? readSettings;
  const updateSettings = dependencies.updateSettings ?? writeSettings;
  const createRequestId = dependencies.createRequestId ?? randomUUID;
  const requestApproval =
    dependencies.requestApproval ??
    ((request, signal) =>
      requestThroughRenderer(dependencies.sender, request, signal));

  return async (call, ctx) => {
    if (!isBrowserToolName(call.toolName)) return { allow: true };
    if (call.toolName === "browserTabs" || call.toolName === "browserClose") {
      return { allow: true };
    }

    const args =
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : {};
    let rawUrl: string | undefined;
    if (call.toolName === "browserOpen") {
      rawUrl = typeof args.url === "string" ? args.url : undefined;
    } else {
      const tabId = typeof args.tabId === "string" ? args.tabId : "";
      rawUrl = dependencies.manager
        .listTabs()
        .find((tab) => tab.id === tabId && tab.kind === "web")?.url;
    }
    if (!rawUrl) {
      return { allow: false, reason: "Browser target is unavailable" };
    }

    let origin: string;
    try {
      origin = parseBrowserUrl(rawUrl).origin;
    } catch {
      return { allow: false, reason: "Browser target URL is invalid" };
    }

    let settings = getSettings();
    if (settings.blockedOrigins.includes(origin)) {
      return { allow: false, reason: `Browser origin is blocked: ${origin}` };
    }
    if (
      !settings.allowedOrigins.includes(origin) &&
      !onceGrantsFor(dependencies.taskId).has(origin)
    ) {
      const decision = await requestApproval(
        {
          requestId: createRequestId(),
          taskId: dependencies.taskId,
          kind: "origin",
          origin,
        },
        ctx.signal,
      );
      if (decision === "block") {
        settings = updateSettings({
          allowedOrigins: settings.allowedOrigins.filter(
            (candidate) => candidate !== origin,
          ),
          blockedOrigins: [...new Set([...settings.blockedOrigins, origin])],
        });
        onceGrantsFor(dependencies.taskId).delete(origin);
        return {
          allow: false,
          reason: `Browser origin was blocked: ${origin}`,
        };
      }
      if (decision === "always-allow") {
        settings = updateSettings({
          allowedOrigins: [...new Set([...settings.allowedOrigins, origin])],
          blockedOrigins: settings.blockedOrigins.filter(
            (candidate) => candidate !== origin,
          ),
        });
      } else if (decision === "allow-once") {
        onceGrantsFor(dependencies.taskId).add(origin);
      } else {
        return { allow: false, reason: "Browser origin access was denied" };
      }
    }

    if (!BROWSER_ACTION_TOOL_NAMES.has(call.toolName)) {
      return { allow: true };
    }
    const tabId = typeof args.tabId === "string" ? args.tabId : "";
    const navigationId =
      typeof args.navigationId === "string" ? args.navigationId : "";
    const snapshotId =
      typeof args.snapshotId === "string" ? args.snapshotId : "";
    const action = actionFromCall(call.toolName, args);
    if (!action) return { allow: false, reason: "Browser action is invalid" };

    let snapshot: BrowserObservation;
    try {
      snapshot = dependencies.observer.requireSnapshot(
        tabId,
        navigationId,
        snapshotId,
      );
    } catch (error) {
      return {
        allow: false,
        reason:
          error instanceof Error
            ? error.message
            : "Browser snapshot is stale; request a fresh snapshot",
      };
    }
    const element =
      action.type === "scroll" ||
      (action.type === "press" && action.ref === undefined)
        ? undefined
        : snapshot.elements.find((candidate) => candidate.ref === action.ref);
    const risk = classifyBrowserActionRisk(action, element);
    if (risk === "forbidden") {
      return {
        allow: false,
        reason:
          "Browser action targets a forbidden secret, payment, or file control",
      };
    }
    if (risk !== "external-effect") return { allow: true };

    const decision = await requestApproval(
      {
        requestId: createRequestId(),
        taskId: dependencies.taskId,
        kind: "sensitive-action",
        origin,
        action: {
          type: action.type,
          target: browserActionTarget(element),
          risk,
        },
      },
      ctx.signal,
    );
    return decision === "approve-once"
      ? { allow: true }
      : { allow: false, reason: "Sensitive browser action was denied" };
  };
};

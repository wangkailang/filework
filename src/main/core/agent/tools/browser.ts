import { z } from "zod/v4";

import type {
  BrowserAction,
  BrowserActionRequest,
  BrowserObservation,
  BrowserTabState,
} from "../../../../shared/browser";
import { parseBrowserUrl } from "../../../../shared/browser";
import type { BrowserActionExecutor } from "../../../browser/browser-actions";
import type { BrowserCaptureStore } from "../../../browser/browser-capture-store";
import type { BrowserManagerContract } from "../../../browser/browser-manager";
import type {
  BrowserObserveOptions,
  BrowserObserver,
} from "../../../browser/browser-observer";
import type { ToolDefinition } from "../tool-registry";
import {
  projectBrowserObservationModelOutput,
  textModelOutput,
} from "./model-output";

type BrowserToolManager = Pick<
  BrowserManagerContract,
  | "activateTab"
  | "closeTab"
  | "createTab"
  | "getActiveTabId"
  | "listTabs"
  | "navigate"
>;

interface BrowserToolObserver {
  observe(
    tabId: string,
    options?: BrowserObserveOptions,
  ): Promise<BrowserObservation>;
}

interface BrowserToolActions {
  execute(
    request: BrowserActionRequest,
    observeOptions?: BrowserObserveOptions,
  ): Promise<BrowserObservation>;
}

interface BrowserToolCaptureStore {
  toModelOutput: BrowserCaptureStore["toModelOutput"];
}

export interface BuildBrowserToolsDependencies {
  manager: BrowserToolManager;
  observer: BrowserToolObserver | Pick<BrowserObserver, "observe">;
  actions: BrowserToolActions | Pick<BrowserActionExecutor, "execute">;
  captureStore: BrowserToolCaptureStore;
  supportsMultimodalToolResults?: boolean;
}

interface BrowserToolExecutionState {
  snapshotStateHashes: Map<string, string>;
  unchangedActionKeys: Set<string>;
}

const snapshotStateKey = (tabId: string, snapshotId: string): string =>
  `${tabId}\u0000${snapshotId}`;

const unchangedActionKey = (
  tabId: string,
  navigationId: string,
  stateHash: string,
  action: BrowserAction,
): string =>
  `${tabId}\u0000${navigationId}\u0000${stateHash}\u0000${JSON.stringify(action)}`;

const rememberObservation = (
  state: BrowserToolExecutionState,
  observation: BrowserObservation,
): BrowserObservation => {
  state.snapshotStateHashes.set(
    snapshotStateKey(observation.tabId, observation.snapshotId),
    observation.stateHash,
  );
  return observation;
};

const tabIdSchema = z.object({ tabId: z.string().min(1) }).strict();

const snapshotIdentitySchema = {
  tabId: z.string().min(1),
  navigationId: z.string().min(1),
  snapshotId: z.string().min(1),
} as const;

const openSchema = z
  .object({
    url: z.string().min(1),
    newTab: z.boolean().optional().default(false),
  })
  .strict();

const clickSchema = z
  .object({
    ...snapshotIdentitySchema,
    ref: z.string().min(1),
  })
  .strict();

const typeSchema = z
  .object({
    ...snapshotIdentitySchema,
    ref: z.string().min(1),
    text: z.string().max(100_000),
    clear: z.boolean().optional().default(true),
  })
  .strict();

const pressSchema = z
  .object({
    ...snapshotIdentitySchema,
    key: z.string().min(1).max(128),
    ref: z.string().min(1).optional(),
  })
  .strict();

const scrollSchema = z
  .object({
    ...snapshotIdentitySchema,
    deltaX: z.number().finite().optional(),
    deltaY: z.number().finite().optional(),
  })
  .strict()
  .refine(
    ({ deltaX, deltaY }) => deltaX !== undefined || deltaY !== undefined,
    { message: "At least one scroll delta is required" },
  );

const requireWebTab = (
  manager: BrowserToolManager,
  tabId: string,
): BrowserTabState => {
  const tab = manager.listTabs().find((candidate) => candidate.id === tabId);
  if (!tab || tab.kind !== "web") {
    throw new Error(`Shared web tab not found: ${tabId}`);
  }
  return tab;
};

const browserObservationProjection = (
  dependencies: BuildBrowserToolsDependencies,
) => {
  const latestStateHashByTab = new Map<string, string>();

  return ({ output }: { output: BrowserObservation }) => {
    const compact = latestStateHashByTab.get(output.tabId) === output.stateHash;
    latestStateHashByTab.set(output.tabId, output.stateHash);
    return projectBrowserObservationModelOutput({
      output,
      compact,
      supportsMultimodalToolResults:
        dependencies.supportsMultimodalToolResults !== false,
      resolveCapture: (captureId) =>
        dependencies.captureStore.toModelOutput(captureId),
    });
  };
};

const actionTool = <TInput extends object>(
  dependencies: BuildBrowserToolsDependencies,
  executionState: BrowserToolExecutionState,
  observationOutput: ReturnType<typeof browserObservationProjection>,
  definition: {
    name: "browserClick" | "browserType" | "browserPress" | "browserScroll";
    description: string;
    inputSchema: z.ZodType<TInput>;
    request: (input: TInput) => BrowserActionRequest;
  },
): ToolDefinition<TInput, BrowserObservation> => ({
  ...definition,
  safety: "destructive",
  execute: async (input) => {
    const request = definition.request(input);
    requireWebTab(dependencies.manager, request.tabId);
    const stateHash = executionState.snapshotStateHashes.get(
      snapshotStateKey(request.tabId, request.snapshotId),
    );
    const retryKey = stateHash
      ? unchangedActionKey(
          request.tabId,
          request.navigationId,
          stateHash,
          request.action,
        )
      : undefined;
    if (retryKey && executionState.unchangedActionKeys.has(retryKey)) {
      throw new Error(
        "This exact browser action already returned an unchanged page state. Choose a different visible ref or report the blocker.",
      );
    }

    const output = await dependencies.actions.execute(request, {
      capture: true,
    });
    rememberObservation(executionState, output);
    if (retryKey && output.actionResult?.outcome === "unchanged") {
      executionState.unchangedActionKeys.add(retryKey);
    }
    return output;
  },
  toModelOutput: observationOutput,
});

export const buildBrowserTools = (
  dependencies: BuildBrowserToolsDependencies,
): ToolDefinition[] => {
  const executionState: BrowserToolExecutionState = {
    snapshotStateHashes: new Map(),
    unchangedActionKeys: new Set(),
  };
  const observationOutput = browserObservationProjection(dependencies);

  const open: ToolDefinition<z.infer<typeof openSchema>, BrowserObservation> = {
    name: "browserOpen",
    description:
      "Open an HTTP(S) URL in the user-visible shared browser. Reuses the active web tab by default; set newTab=true only when parallel page state is necessary. Returns an untrusted page observation with stable element refs.",
    safety: "safe",
    inputSchema: openSchema,
    execute: async ({ url: rawUrl, newTab }) => {
      const url = parseBrowserUrl(rawUrl).href;
      const activeTabId = dependencies.manager.getActiveTabId();
      const activeTab = dependencies.manager
        .listTabs()
        .find(
          (candidate) =>
            candidate.id === activeTabId &&
            candidate.active &&
            candidate.kind === "web",
        );

      let tabId: string;
      if (newTab || !activeTab) {
        const created = await dependencies.manager.createTab({
          kind: "web",
          url,
          activate: true,
        });
        tabId = created.id;
      } else {
        tabId = activeTab.id;
        dependencies.manager.activateTab(tabId);
        if (activeTab.url !== url) {
          await dependencies.manager.navigate(tabId, url);
        }
      }
      return rememberObservation(
        executionState,
        await dependencies.observer.observe(tabId, { capture: true }),
      );
    },
    toModelOutput: observationOutput,
  };

  const tabs: ToolDefinition<
    Record<string, never>,
    { activeTabId: string | null; tabs: BrowserTabState[] }
  > = {
    name: "browserTabs",
    description:
      "List shared browser tab metadata (id, URL, title, loading and active state) without reading page content.",
    safety: "safe",
    inputSchema: z.object({}).strict(),
    execute: async () => ({
      activeTabId: dependencies.manager.getActiveTabId(),
      tabs: dependencies.manager.listTabs(),
    }),
    toModelOutput: ({ output }) =>
      textModelOutput(JSON.stringify(output, null, 2)),
  };

  const switchTab: ToolDefinition<
    z.infer<typeof tabIdSchema>,
    BrowserObservation
  > = {
    name: "browserSwitchTab",
    description:
      "Activate an existing shared web tab and return a fresh untrusted observation.",
    safety: "safe",
    inputSchema: tabIdSchema,
    execute: async ({ tabId }) => {
      requireWebTab(dependencies.manager, tabId);
      dependencies.manager.activateTab(tabId);
      return rememberObservation(
        executionState,
        await dependencies.observer.observe(tabId, { capture: true }),
      );
    },
    toModelOutput: observationOutput,
  };

  const snapshot: ToolDefinition<
    z.infer<typeof tabIdSchema>,
    BrowserObservation
  > = {
    name: "browserSnapshot",
    description:
      "Read the current shared web tab and issue fresh navigationId, snapshotId, text, refs and an ephemeral screenshot. Use again whenever refs become stale.",
    safety: "safe",
    inputSchema: tabIdSchema,
    execute: async ({ tabId }) => {
      requireWebTab(dependencies.manager, tabId);
      return rememberObservation(
        executionState,
        await dependencies.observer.observe(tabId, { capture: true }),
      );
    },
    toModelOutput: observationOutput,
  };

  const click = actionTool(dependencies, executionState, observationOutput, {
    name: "browserClick",
    description:
      "Click a ref from the latest shared-browser snapshot. Requires tabId, navigationId and snapshotId so stale refs fail safely.",
    inputSchema: clickSchema,
    request: ({ tabId, navigationId, snapshotId, ref }) => ({
      tabId,
      navigationId,
      snapshotId,
      action: { type: "click", ref },
    }),
  });

  const type = actionTool(dependencies, executionState, observationOutput, {
    name: "browserType",
    description:
      "Type non-sensitive text into a ref from the latest snapshot. Password, secret, payment and file inputs are forbidden. Use browserPress separately to submit.",
    inputSchema: typeSchema,
    request: ({ tabId, navigationId, snapshotId, ref, text, clear }) => ({
      tabId,
      navigationId,
      snapshotId,
      action: { type: "type", ref, text, clear },
    }),
  });

  const press = actionTool(dependencies, executionState, observationOutput, {
    name: "browserPress",
    description:
      "Send one keyboard key to the current page or a ref from the latest snapshot. Requires the full snapshot identity.",
    inputSchema: pressSchema,
    request: ({ tabId, navigationId, snapshotId, key, ref }) => ({
      tabId,
      navigationId,
      snapshotId,
      action: { type: "press", key, ...(ref && { ref }) },
    }),
  });

  const scroll = actionTool(dependencies, executionState, observationOutput, {
    name: "browserScroll",
    description:
      "Scroll the current page by trusted wheel input. Requires the full snapshot identity and at least one delta.",
    inputSchema: scrollSchema,
    request: ({ tabId, navigationId, snapshotId, deltaX, deltaY }) => ({
      tabId,
      navigationId,
      snapshotId,
      action: { type: "scroll", deltaX, deltaY },
    }),
  });

  const close: ToolDefinition<
    z.infer<typeof tabIdSchema>,
    { success: true; closedTabId: string }
  > = {
    name: "browserClose",
    description:
      "Close a shared browser tab that is no longer needed. Temporary research tabs should be closed when finished.",
    safety: "safe",
    inputSchema: tabIdSchema,
    execute: async ({ tabId }) => {
      requireWebTab(dependencies.manager, tabId);
      await dependencies.manager.closeTab(tabId);
      return { success: true, closedTabId: tabId };
    },
    toModelOutput: ({ output }) => textModelOutput(JSON.stringify(output)),
  };

  // ToolRegistry intentionally erases each tool's individual input/output
  // generic after registration; keep strong types while constructing them and
  // perform that erasure only at this collection boundary.
  return [
    open,
    tabs,
    switchTab,
    snapshot,
    click,
    type,
    press,
    scroll,
    close,
  ] as unknown as ToolDefinition[];
};

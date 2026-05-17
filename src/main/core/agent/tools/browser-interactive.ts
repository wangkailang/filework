/**
 * Interactive browser tools — give the agent a stateful, real-Chromium
 * session it can navigate, click, and type into. Closes the gap left
 * by the stateless `webFetchRendered` (which only loads + reads once
 * and discards the window), unblocking GAIA-style tasks that need to
 * search a site, click a result, paginate, or fill a form.
 *
 * All five tools delegate to `ipc/interactive-browser.ts` which owns
 * the BrowserWindow lifecycle and page-side scripts. The tools
 * themselves are domain-neutral and don't touch Electron directly, so
 * unit tests can stub the manager via module mocking.
 *
 * Element addressing is by `ref` (a `data-aix-ref` attribute injected
 * onto interactive elements by the snapshot script), not CSS selector.
 * The LLM picks `ref` values from the returned `elements[]`.
 *
 * Safety: all five tools are marked `safe` to mirror `webFetch` /
 * `webFetchRendered`. Note that clicks/submits on live pages can
 * trigger third-party side effects (e.g. form posts); callers wanting
 * approval-gated browsing should mark them `destructive` upstream.
 */
import { z } from "zod/v4";

import {
  clickInBrowserSession,
  closeBrowserSession,
  openBrowserSession,
  snapshotBrowserSession,
  typeInBrowserSession,
} from "../../../ipc/interactive-browser";
import type { ToolDefinition } from "../tool-registry";

// ─── Schemas ─────────────────────────────────────────────────────────

const openSchema = z.object({
  url: z.string().url().describe("Absolute HTTP(S) URL to open."),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .optional()
    .describe("Hard load timeout in ms. Default 15000."),
  settleMs: z
    .number()
    .int()
    .nonnegative()
    .max(10_000)
    .optional()
    .describe("Post-load hydration delay in ms for SPA pages. Default 1500."),
});

const clickSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe("Session id returned by `browserOpen`."),
  ref: z
    .string()
    .min(1)
    .describe(
      "Element ref from the latest snapshot's `elements[]` (e.g. 'r3').",
    ),
});

const typeSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe("Session id returned by `browserOpen`."),
  ref: z
    .string()
    .min(1)
    .describe("Input/textarea ref from the latest snapshot's `elements[]`."),
  text: z
    .string()
    .max(10_000)
    .describe("Text to set as the element's value (replaces existing)."),
  submit: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "When true, dispatch Enter / form submit after typing. Use for search boxes.",
    ),
});

const snapshotSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe("Session id returned by `browserOpen`."),
});

const closeSchema = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe("Session id returned by `browserOpen`."),
});

// ─── Tool definitions ────────────────────────────────────────────────

export const buildBrowserOpenTool = (): ToolDefinition => ({
  name: "browserOpen",
  description:
    "Open a URL in a persistent hidden Chromium session you can interact with across tool calls. " +
    "Returns a `sessionId` plus a snapshot: page url/title, reader-mode markdown, and `elements[]` " +
    "— each interactive element on the page has a `ref` you'll pass to `browserClick` / `browserType`. " +
    "Use this when you need to search a site, click a result, paginate, or fill a form. " +
    "For one-shot reading of a single SPA page, prefer `webFetchRendered` (cheaper, no session state). " +
    "Sessions auto-close after 5min idle; call `browserClose` explicitly when done.",
  safety: "safe",
  inputSchema: openSchema,
  execute: async (args, ctx) => {
    const a = args as z.infer<typeof openSchema>;
    return await openBrowserSession(a.url, {
      timeoutMs: a.timeoutMs,
      settleMs: a.settleMs,
      signal: ctx.signal,
    });
  },
});

export const buildBrowserClickTool = (): ToolDefinition => ({
  name: "browserClick",
  description:
    "Click an element in a live browser session, addressed by its `ref` from the latest snapshot. " +
    "If the click triggers navigation, waits for the new page to load and returns a snapshot of the result. " +
    "Side-effects warning: clicks on live pages may post forms, submit purchases, etc. — pick refs carefully.",
  safety: "safe",
  inputSchema: clickSchema,
  execute: async (args, ctx) => {
    const a = args as z.infer<typeof clickSchema>;
    return await clickInBrowserSession(a.sessionId, a.ref, {
      signal: ctx.signal,
    });
  },
});

export const buildBrowserTypeTool = (): ToolDefinition => ({
  name: "browserType",
  description:
    "Type text into an input/textarea/contenteditable in a live browser session. " +
    "Replaces (does not append to) the existing value. Set `submit: true` to also press Enter / submit " +
    "the form afterward — useful for search boxes.",
  safety: "safe",
  inputSchema: typeSchema,
  execute: async (args, ctx) => {
    const a = args as z.infer<typeof typeSchema>;
    return await typeInBrowserSession(a.sessionId, a.ref, a.text, a.submit, {
      signal: ctx.signal,
    });
  },
});

export const buildBrowserSnapshotTool = (): ToolDefinition => ({
  name: "browserSnapshot",
  description:
    "Re-read the current page in a live browser session without acting. " +
    "Use after waiting for dynamic content to load, or to refresh the `elements[]` list after a JS-driven " +
    "in-page update.",
  safety: "safe",
  inputSchema: snapshotSchema,
  execute: async (args) => {
    const a = args as z.infer<typeof snapshotSchema>;
    return await snapshotBrowserSession(a.sessionId);
  },
});

export const buildBrowserCloseTool = (): ToolDefinition => ({
  name: "browserClose",
  description:
    "Close a browser session. Call when done to free the hidden window early " +
    "(otherwise reaped after 5min idle). No-op if the session already expired.",
  safety: "safe",
  inputSchema: closeSchema,
  execute: async (args) => {
    const a = args as z.infer<typeof closeSchema>;
    return await closeBrowserSession(a.sessionId);
  },
});

/** Convenience: build all five tools at once for registration. */
export const buildBrowserInteractiveTools = (): ToolDefinition[] => [
  buildBrowserOpenTool(),
  buildBrowserClickTool(),
  buildBrowserTypeTool(),
  buildBrowserSnapshotTool(),
  buildBrowserCloseTool(),
];

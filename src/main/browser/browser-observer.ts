import { randomUUID } from "node:crypto";

import type { WebContents } from "electron";

import type {
  BrowserElementRef,
  BrowserObservation,
  BrowserTabState,
} from "../../shared/browser";
import { BrowserCaptureStore } from "./browser-capture-store";
import type { BrowserManagerContract } from "./browser-manager";

const BROWSER_OBSERVER_WORLD_ID = 1_001;
const DEFAULT_MAX_TEXT_CHARS = 60_000;
const DEFAULT_MAX_ELEMENTS = 150;
const UNTRUSTED_CONTENT_START = "--- BEGIN UNTRUSTED WEB CONTENT ---";
const UNTRUSTED_CONTENT_END = "--- END UNTRUSTED WEB CONTENT ---";

export interface BrowserObserveOptions {
  capture?: boolean;
}

export interface BrowserObserverOptions {
  captureStore?: BrowserCaptureStore;
  createId?: () => string;
  maxTextChars?: number;
  maxElements?: number;
}

interface TabObservationState {
  webContents: WebContents;
  navigationId: string;
  sequence: number;
  latest?: BrowserObservation;
  onDidStartNavigation: (
    event: unknown,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void;
}

interface RawBrowserObservation {
  url?: unknown;
  title?: unknown;
  viewport?: unknown;
  text?: unknown;
  elements?: unknown;
  elementsTruncated?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const boundedString = (
  value: unknown,
  maxLength: number,
): string | undefined => {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, maxLength);
};

const normalizeElement = (value: unknown): BrowserElementRef | null => {
  if (!isRecord(value) || !isRecord(value.rect)) return null;
  const ref = boundedString(value.ref, 128);
  const tag = boundedString(value.tag, 64);
  if (!ref || !tag) return null;

  return {
    ref,
    tag: tag.toLowerCase(),
    ...(boundedString(value.role, 128) && {
      role: boundedString(value.role, 128),
    }),
    ...(boundedString(value.name, 500) && {
      name: boundedString(value.name, 500),
    }),
    ...(typeof value.value === "string" && {
      value: value.value.slice(0, 1_000),
    }),
    ...(boundedString(value.href, 2_048) && {
      href: boundedString(value.href, 2_048),
    }),
    ...(boundedString(value.inputType, 128) && {
      inputType: boundedString(value.inputType, 128),
    }),
    ...(boundedString(value.autocomplete, 128) && {
      autocomplete: boundedString(value.autocomplete, 128),
    }),
    ...(boundedString(value.buttonType, 128) && {
      buttonType: boundedString(value.buttonType, 128),
    }),
    ...(value.inForm === true && { inForm: true }),
    ...(boundedString(value.formMethod, 16) && {
      formMethod: boundedString(value.formMethod, 16),
    }),
    ...(boundedString(value.formAction, 2_048) && {
      formAction: boundedString(value.formAction, 2_048),
    }),
    rect: {
      x: finiteNumber(value.rect.x),
      y: finiteNumber(value.rect.y),
      width: Math.max(0, finiteNumber(value.rect.width)),
      height: Math.max(0, finiteNumber(value.rect.height)),
    },
    visible: value.visible === true,
  };
};

const createObserverScript = (
  maxTextChars: number,
  maxElements: number,
): string => String.raw`(() => {
  const MAX_TEXT_CHARS = ${maxTextChars};
  const MAX_ELEMENTS = ${maxElements};
  const STATE_KEY = "__fileworkBrowserObserverV1";
  const existingState = globalThis[STATE_KEY];
  const state = existingState && existingState.refs instanceof WeakMap
    ? existingState
    : { refs: new WeakMap(), nextRef: 1 };
  globalThis[STATE_KEY] = state;

  const cleanText = (value, limit) => {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, limit);
  };
  const getRef = (element) => {
    const current = state.refs.get(element);
    if (current) return current;
    const next = "e" + state.nextRef;
    state.nextRef += 1;
    state.refs.set(element, next);
    return next;
  };
  const elementTag = (element) =>
    String(element.localName || element.tagName || "element").toLowerCase();
  const interactiveRoles = new Set([
    "button", "checkbox", "combobox", "link", "listbox", "menuitem",
    "option", "radio", "searchbox", "slider", "spinbutton", "switch",
    "tab", "textbox", "treeitem"
  ]);
  const implicitRole = (element, tag, inputType) => {
    const explicit = cleanText(element.getAttribute && element.getAttribute("role"), 128);
    if (explicit) return explicit;
    if (tag === "a" && element.getAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag !== "input") return tag === "iframe" ? "frame" : "";
    if (inputType === "checkbox") return "checkbox";
    if (inputType === "radio") return "radio";
    if (inputType === "range") return "slider";
    if (inputType === "button" || inputType === "submit" || inputType === "reset") {
      return "button";
    }
    return "textbox";
  };
  const isInteractive = (element, tag) => {
    if (tag === "button" || tag === "input" || tag === "textarea" ||
        tag === "select" || tag === "iframe") return true;
    if (tag === "a" && Boolean(element.getAttribute("href"))) return true;
    const role = cleanText(element.getAttribute && element.getAttribute("role"), 128);
    if (interactiveRoles.has(role)) return true;
    const editable = cleanText(
      element.getAttribute && element.getAttribute("contenteditable"),
      16,
    ).toLowerCase();
    return editable === "" ? Boolean(element.isContentEditable) : editable !== "false";
  };
  const accessibleName = (element, tag) => {
    const labelledBy = cleanText(
      element.getAttribute && element.getAttribute("aria-labelledby"),
      256,
    );
    if (labelledBy) {
      const labels = labelledBy.split(/\s+/).map((id) => {
        const label = element.ownerDocument && element.ownerDocument.getElementById(id);
        return label ? label.textContent : "";
      });
      const joined = cleanText(labels.join(" "), 500);
      if (joined) return joined;
    }
    const candidates = [
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("alt"),
      element.getAttribute && element.getAttribute("title"),
      tag === "input" && element.getAttribute && element.getAttribute("placeholder"),
      element.textContent,
    ];
    for (const candidate of candidates) {
      const name = cleanText(candidate, 500);
      if (name) return name;
    }
    return "";
  };
  const sensitiveValue = (element, inputType) => {
    if (inputType === "password" || inputType === "hidden" || inputType === "file") {
      return true;
    }
    const descriptors = [
      element.getAttribute && element.getAttribute("name"),
      element.getAttribute && element.getAttribute("id"),
      element.getAttribute && element.getAttribute("autocomplete"),
      element.getAttribute && element.getAttribute("aria-label"),
      element.getAttribute && element.getAttribute("placeholder"),
    ].filter(Boolean).join(" ");
    return /(pass(word)?|secret|token|api[\s_-]*key|credential|auth|one[\s_-]*time|otp|cvc|cvv|cc-number|card[\s_-]*number)/i.test(descriptors);
  };
  const elementRect = (element, offsetX, offsetY) => {
    let rect;
    try {
      rect = element.getBoundingClientRect();
    } catch {
      rect = { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 };
    }
    const x = Number.isFinite(rect.x) ? rect.x : Number(rect.left) || 0;
    const y = Number.isFinite(rect.y) ? rect.y : Number(rect.top) || 0;
    return {
      x: x + offsetX,
      y: y + offsetY,
      width: Math.max(0, Number(rect.width) || 0),
      height: Math.max(0, Number(rect.height) || 0),
    };
  };
  const isVisible = (element, tag, rect) => {
    if (tag === "input" && String(element.getAttribute("type") || "").toLowerCase() === "hidden") {
      return false;
    }
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    let style;
    try {
      style = typeof window.getComputedStyle === "function"
        ? window.getComputedStyle(element)
        : undefined;
    } catch {
      style = undefined;
    }
    if (style && (style.display === "none" || style.visibility === "hidden" ||
        Number(style.opacity) === 0)) return false;
    return rect.width > 0 && rect.height > 0 && rect.x < window.innerWidth &&
      rect.y < window.innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0;
  };

  const elements = [];
  const textChunks = [];
  let textLength = 0;
  let textTruncated = false;
  const appendText = (value) => {
    if (textLength >= MAX_TEXT_CHARS) {
      textTruncated = true;
      return;
    }
    const text = cleanText(value, MAX_TEXT_CHARS);
    if (!text) return;
    const separator = textChunks.length === 0 ? "" : "\n";
    const remaining = MAX_TEXT_CHARS - textLength - separator.length;
    if (remaining <= 0) {
      textTruncated = true;
      return;
    }
    const bounded = text.slice(0, remaining);
    textChunks.push(separator + bounded);
    textLength += separator.length + bounded.length;
    if (bounded.length < text.length) textTruncated = true;
  };
  const addElement = (element, offsetX, offsetY, frameUnavailable) => {
    const tag = elementTag(element);
    const inputType = tag === "input"
      ? cleanText(element.getAttribute("type") || "text", 128).toLowerCase()
      : undefined;
    const rect = elementRect(element, offsetX, offsetY);
    let name = accessibleName(element, tag);
    if (tag === "iframe" && frameUnavailable && !name) {
      name = "Unavailable or cross-origin frame";
    }
    const item = {
      ref: getRef(element),
      role: implicitRole(element, tag, inputType),
      tag,
      name,
      rect,
      visible: isVisible(element, tag, rect),
    };
    if (inputType) item.inputType = inputType;
    const autocomplete = cleanText(
      element.getAttribute && element.getAttribute("autocomplete"),
      128,
    ).toLowerCase();
    if (autocomplete) item.autocomplete = autocomplete;
    if (tag === "button") {
      item.buttonType = cleanText(
        element.getAttribute("type") || "submit",
        128,
      ).toLowerCase();
    }
    const form = element.form || (element.closest && element.closest("form"));
    if (form) {
      item.inForm = true;
      item.formMethod = cleanText(form.method || "get", 16).toLowerCase();
      item.formAction = cleanText(form.action || location.href, 2048);
    }
    if (tag === "a") {
      const href = cleanText(element.href || element.getAttribute("href"), 2048);
      if (href) item.href = href;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      item.value = sensitiveValue(element, inputType)
        ? "[REDACTED]"
        : cleanText(String(element.value == null ? "" : element.value), 1000);
    }
    elements.push(item);
  };

  const visitedDocuments = new Set();
  const walkRoot = (root, offsetX, offsetY, includeRootText) => {
    if (!root) return;
    if (includeRootText) appendText(root.body ? root.body.textContent : root.textContent);
    const start = root.documentElement || root;
    const visit = (element) => {
      if (!element || element.nodeType !== 1) return;
      const tag = elementTag(element);
      let frameDocument = null;
      let frameUnavailable = false;
      if (tag === "iframe") {
        try {
          frameDocument = element.contentDocument ||
            (element.contentWindow && element.contentWindow.document) || null;
          frameUnavailable = !frameDocument;
        } catch {
          frameUnavailable = true;
        }
      }
      if (isInteractive(element, tag)) {
        addElement(element, offsetX, offsetY, frameUnavailable);
      }
      if (element.shadowRoot) {
        const shadowChildren = Array.from(element.shadowRoot.children || []);
        appendText(
          element.shadowRoot.textContent ||
            shadowChildren.map((child) => child.textContent || "").join(" "),
        );
        for (const child of shadowChildren) visit(child);
      }
      for (const child of Array.from(element.children || [])) visit(child);
      if (frameDocument && !visitedDocuments.has(frameDocument)) {
        visitedDocuments.add(frameDocument);
        const frameRect = elementRect(element, offsetX, offsetY);
        walkRoot(frameDocument, frameRect.x, frameRect.y, true);
      }
    };
    visit(start);
  };

  visitedDocuments.add(document);
  walkRoot(document, 0, 0, true);
  const visible = elements.filter((element) => element.visible);
  const hidden = elements.filter((element) => !element.visible);
  const prioritized = visible.concat(hidden);

  return {
    url: cleanText(location && location.href, 2048),
    title: cleanText(document.title, 1000),
    viewport: {
      width: Math.max(0, Number(window.innerWidth) || 0),
      height: Math.max(0, Number(window.innerHeight) || 0),
      deviceScaleFactor: Math.max(0.1, Number(window.devicePixelRatio) || 1),
    },
    text: textChunks.join("").slice(0, MAX_TEXT_CHARS),
    textTruncated,
    elements: prioritized.slice(0, MAX_ELEMENTS),
    elementsTruncated: prioritized.length > MAX_ELEMENTS,
  };
})()`;

export const BROWSER_OBSERVER_SCRIPT = createObserverScript(
  DEFAULT_MAX_TEXT_CHARS,
  DEFAULT_MAX_ELEMENTS,
);

export class BrowserObserver {
  private readonly states = new Map<string, TabObservationState>();
  private readonly captureStore: BrowserCaptureStore;
  private readonly ownsCaptureStore: boolean;
  private readonly createId: () => string;
  private readonly maxTextChars: number;
  private readonly maxElements: number;

  constructor(
    private readonly manager: BrowserManagerContract,
    options: BrowserObserverOptions = {},
  ) {
    this.captureStore = options.captureStore ?? new BrowserCaptureStore();
    this.ownsCaptureStore = options.captureStore === undefined;
    this.createId = options.createId ?? randomUUID;
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
    this.maxElements = options.maxElements ?? DEFAULT_MAX_ELEMENTS;

    if (!Number.isSafeInteger(this.maxTextChars) || this.maxTextChars < 1) {
      throw new Error(
        "Browser observation text limit must be a positive integer",
      );
    }
    if (!Number.isSafeInteger(this.maxElements) || this.maxElements < 1) {
      throw new Error(
        "Browser observation element limit must be a positive integer",
      );
    }
  }

  async observe(
    tabId: string,
    options: BrowserObserveOptions = {},
  ): Promise<BrowserObservation> {
    const tab = this.requireTab(tabId);
    const webContents = this.manager.getWebContents(tabId);
    const state = this.stateFor(tabId, webContents);
    const navigationId = state.navigationId;
    const sequence = ++state.sequence;
    const raw = (await webContents.executeJavaScriptInIsolatedWorld(
      BROWSER_OBSERVER_WORLD_ID,
      [
        {
          code: createObserverScript(this.maxTextChars, this.maxElements),
        },
      ],
    )) as RawBrowserObservation;

    this.assertObservationStillCurrent(state, navigationId, sequence);

    let captureId: string | undefined;
    if (options.capture === true) {
      const image = await webContents.capturePage();
      captureId = this.captureStore.put(image.toPNG());
      try {
        this.assertObservationStillCurrent(state, navigationId, sequence);
      } catch (error) {
        this.captureStore.delete(captureId);
        throw error;
      }
    }

    const observation = this.normalizeObservation(
      tab,
      navigationId,
      this.createId(),
      raw,
      captureId,
    );
    state.latest = observation;
    return observation;
  }

  requireSnapshot(
    tabId: string,
    navigationId: string,
    snapshotId: string,
  ): BrowserObservation {
    const state = this.states.get(tabId);
    if (!state || state.navigationId !== navigationId) {
      throw new Error(
        "Browser navigation changed; request a fresh observation",
      );
    }
    if (!state.latest || state.latest.snapshotId !== snapshotId) {
      throw new Error("Browser snapshot is stale; request a fresh observation");
    }
    return state.latest;
  }

  getCapture(captureId: string): Buffer | null {
    return this.captureStore.get(captureId);
  }

  toCaptureModelOutput(captureId: string) {
    return this.captureStore.toModelOutput(captureId);
  }

  dispose(): void {
    for (const state of this.states.values()) {
      state.webContents.removeListener(
        "did-start-navigation",
        state.onDidStartNavigation,
      );
    }
    this.states.clear();
    if (this.ownsCaptureStore) this.captureStore.clear();
  }

  private requireTab(tabId: string): BrowserTabState {
    const tab = this.manager
      .listTabs()
      .find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Browser tab not found: ${tabId}`);
    return tab;
  }

  private stateFor(
    tabId: string,
    webContents: WebContents,
  ): TabObservationState {
    const current = this.states.get(tabId);
    if (current?.webContents === webContents) return current;
    if (current) {
      current.webContents.removeListener(
        "did-start-navigation",
        current.onDidStartNavigation,
      );
    }

    const state = {} as TabObservationState;
    state.webContents = webContents;
    state.navigationId = this.createId();
    state.sequence = 0;
    state.onDidStartNavigation = (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      state.navigationId = this.createId();
      state.latest = undefined;
      state.sequence += 1;
    };
    webContents.on("did-start-navigation", state.onDidStartNavigation);
    this.states.set(tabId, state);
    return state;
  }

  private assertObservationStillCurrent(
    state: TabObservationState,
    navigationId: string,
    sequence: number,
  ): void {
    if (state.navigationId !== navigationId) {
      throw new Error("Browser navigation changed during observation");
    }
    if (state.sequence !== sequence) {
      throw new Error("Browser observation was superseded by a newer snapshot");
    }
  }

  private normalizeObservation(
    tab: BrowserTabState,
    navigationId: string,
    snapshotId: string,
    raw: RawBrowserObservation,
    captureId: string | undefined,
  ): BrowserObservation {
    const rawRecord = isRecord(raw) ? raw : {};
    const viewport = isRecord(rawRecord.viewport) ? rawRecord.viewport : {};
    const rawText = typeof rawRecord.text === "string" ? rawRecord.text : "";
    const boundedText = rawText
      .slice(0, this.maxTextChars)
      .replaceAll(UNTRUSTED_CONTENT_START, "[web boundary text removed]")
      .replaceAll(UNTRUSTED_CONTENT_END, "[web boundary text removed]");
    const rawElements = Array.isArray(rawRecord.elements)
      ? rawRecord.elements
      : [];
    const normalizedElements = rawElements
      .map(normalizeElement)
      .filter((element): element is BrowserElementRef => element !== null);
    const prioritizedElements = [
      ...normalizedElements.filter((element) => element.visible),
      ...normalizedElements.filter((element) => !element.visible),
    ];
    const elements = prioritizedElements.slice(0, this.maxElements);

    return {
      tabId: tab.id,
      navigationId,
      snapshotId,
      url: boundedString(rawRecord.url, 2_048) ?? tab.url,
      title: boundedString(rawRecord.title, 1_000) ?? tab.title,
      viewport: {
        width: Math.max(0, finiteNumber(viewport.width)),
        height: Math.max(0, finiteNumber(viewport.height)),
        deviceScaleFactor: Math.max(
          0.1,
          finiteNumber(viewport.deviceScaleFactor, 1),
        ),
      },
      text: `${UNTRUSTED_CONTENT_START}\n${boundedText}\n${UNTRUSTED_CONTENT_END}`,
      elements,
      elementsTruncated:
        rawRecord.elementsTruncated === true ||
        normalizedElements.length > elements.length,
      ...(captureId && { captureId }),
      sourceTrust: "untrusted-web",
    };
  }
}

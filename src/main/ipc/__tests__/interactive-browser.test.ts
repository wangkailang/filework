import { describe, expect, it, vi } from "vitest";

// Electron is only needed for the runtime BrowserWindow paths, which we
// don't exercise here — we test the pure helpers. Stub the module so the
// import-time `import { BrowserWindow, app, session } from "electron"`
// in interactive-browser.ts resolves under vitest. Fakes live inside the
// factory (which is hoisted) so they're defined before the mock runs.
vi.mock("electron", () => {
  class FakeBrowserWindow {}
  return {
    BrowserWindow: FakeBrowserWindow,
    app: { on: () => undefined },
    session: {
      fromPartition: () => {
        return { clearStorageData: async () => undefined };
      },
    },
  };
});

import {
  buildClickScript,
  buildSnapshotFromRaw,
  buildTypeScript,
  type InteractiveElement,
  SNAPSHOT_SCRIPT,
} from "../interactive-browser";

// ─── Page-script builders ────────────────────────────────────────────

describe("buildClickScript", () => {
  it("embeds the ref via JSON.stringify so quotes are escaped", () => {
    const malicious = `r1"]; alert('xss'); //`;
    const script = buildClickScript(malicious);
    expect(script).toContain(JSON.stringify(malicious));
    expect(script).not.toContain(`'${malicious}'`);
    expect(script).not.toContain(`"${malicious}"`);
    // No unbalanced quote: the script should parse as a JS expression.
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it("returns ref-not-found shape (script contains the error marker)", () => {
    const script = buildClickScript("r99");
    expect(script).toContain("ref-not-found");
  });
});

describe("buildTypeScript", () => {
  it("escapes both ref and text safely", () => {
    const text = `hello "world"; '); fetch('/evil`;
    const script = buildTypeScript("r1", text, false);
    expect(script).toContain(JSON.stringify(text));
    expect(() => new Function(`return ${script}`)).not.toThrow();
  });

  it("hard-codes submit as a bare boolean (no string interpolation)", () => {
    expect(buildTypeScript("r1", "hi", true)).toMatch(/const SUBMIT = true;/);
    expect(buildTypeScript("r1", "hi", false)).toMatch(/const SUBMIT = false;/);
  });

  it("uses native value setter to defeat React's value tracker", () => {
    const script = buildTypeScript("r1", "x", false);
    expect(script).toContain("getOwnPropertyDescriptor(proto, 'value')");
    expect(script).toContain("desc.set.call(el, TEXT)");
  });

  it("dispatches Enter key events when submit is true", () => {
    const script = buildTypeScript("r1", "q", true);
    expect(script).toContain("KeyboardEvent");
    expect(script).toContain("'Enter'");
    expect(script).toContain("requestSubmit");
  });
});

describe("SNAPSHOT_SCRIPT", () => {
  it("is a single self-invoking IIFE expression", () => {
    expect(SNAPSHOT_SCRIPT.startsWith("(() => {")).toBe(true);
    expect(SNAPSHOT_SCRIPT.endsWith("})()")).toBe(true);
  });

  it("parses as valid JS source", () => {
    expect(() => new Function(`return ${SNAPSHOT_SCRIPT}`)).not.toThrow();
  });

  it("queries the documented interactive selectors", () => {
    expect(SNAPSHOT_SCRIPT).toContain("a[href]");
    expect(SNAPSHOT_SCRIPT).toContain("button");
    expect(SNAPSHOT_SCRIPT).toContain('input:not([type="hidden"])');
    expect(SNAPSHOT_SCRIPT).toContain("textarea");
    expect(SNAPSHOT_SCRIPT).toContain('[role="button"]');
    expect(SNAPSHOT_SCRIPT).toContain('[contenteditable="true"]');
  });

  it("assigns refs as r1, r2, ... persisted via data-aix-ref", () => {
    expect(SNAPSHOT_SCRIPT).toContain("data-aix-ref");
    expect(SNAPSHOT_SCRIPT).toContain("'r' + next");
  });
});

// ─── Snapshot post-processing ────────────────────────────────────────

const makeElement = (
  ref: string,
  visible: boolean,
  overrides: Partial<InteractiveElement> = {},
): InteractiveElement => ({
  ref,
  tag: "a",
  visible,
  ...overrides,
});

const minimalHtml = `<!doctype html><html><head><title>T</title></head><body><article><p>${"x".repeat(200)}</p><p>${"y".repeat(200)}</p><p>${"z".repeat(200)}</p></article></body></html>`;

describe("buildSnapshotFromRaw", () => {
  it("places visible elements before invisible ones", () => {
    const raw = {
      url: "https://example.com",
      title: "Example",
      html: minimalHtml,
      elements: [
        makeElement("r1", false),
        makeElement("r2", true),
        makeElement("r3", false),
        makeElement("r4", true),
      ],
    };
    const snap = buildSnapshotFromRaw(raw, "sess-1");
    expect(snap.elements.map((e) => e.ref)).toEqual(["r2", "r4", "r1", "r3"]);
    expect(snap.elementsTruncated).toBe(false);
  });

  it("caps elements at 150 and reports truncation", () => {
    const lots: InteractiveElement[] = [];
    for (let i = 0; i < 200; i++) lots.push(makeElement(`r${i}`, true));
    const snap = buildSnapshotFromRaw(
      {
        url: "https://example.com",
        title: "Example",
        html: minimalHtml,
        elements: lots,
      },
      "sess-1",
    );
    expect(snap.elements.length).toBe(150);
    expect(snap.elementsTruncated).toBe(true);
  });

  it("forwards sessionId and page url/title", () => {
    const snap = buildSnapshotFromRaw(
      {
        url: "https://example.com/path?q=1",
        title: "Example",
        html: minimalHtml,
        elements: [],
      },
      "sess-xyz",
    );
    expect(snap.sessionId).toBe("sess-xyz");
    expect(snap.url).toBe("https://example.com/path?q=1");
    expect(snap.title).toBe("Example");
  });

  it("derives markdown from the page HTML", () => {
    const snap = buildSnapshotFromRaw(
      {
        url: "https://example.com",
        title: "Example",
        html: minimalHtml,
        elements: [],
      },
      "sess-1",
    );
    expect(typeof snap.markdown).toBe("string");
    expect(snap.markdownTruncated).toBe(false);
  });

  it("truncates markdown when extracted content exceeds the 60KB cap", () => {
    const giant = `<p>${"lorem ipsum ".repeat(20_000)}</p>`;
    const html = `<!doctype html><html><head><title>Big</title></head><body><article>${giant}</article></body></html>`;
    const snap = buildSnapshotFromRaw(
      {
        url: "https://example.com",
        title: "Big",
        html,
        elements: [],
      },
      "sess-1",
    );
    expect(snap.markdown.length).toBeLessThanOrEqual(60_000);
    expect(snap.markdownTruncated).toBe(true);
  });
});

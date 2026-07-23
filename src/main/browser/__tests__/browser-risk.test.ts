import { describe, expect, it } from "vitest";

import type { BrowserElementRef } from "../../../shared/browser";
import { classifyBrowserActionRisk } from "../browser-risk";

const element = (
  overrides: Partial<BrowserElementRef> = {},
): BrowserElementRef => ({
  ref: "e1",
  tag: "input",
  role: "textbox",
  name: "Query",
  inputType: "text",
  rect: { x: 1, y: 1, width: 100, height: 30 },
  visible: true,
  ...overrides,
});

describe("classifyBrowserActionRisk", () => {
  it("forbids password, file, payment, and secret autofill controls", () => {
    expect(
      classifyBrowserActionRisk(
        { type: "type", ref: "e1", text: "secret" },
        element({ inputType: "password" }),
      ),
    ).toBe("forbidden");
    expect(
      classifyBrowserActionRisk(
        { type: "click", ref: "e1" },
        element({ inputType: "file" }),
      ),
    ).toBe("forbidden");
    expect(
      classifyBrowserActionRisk(
        { type: "type", ref: "e1", text: "4111" },
        element({ autocomplete: "cc-number" }),
      ),
    ).toBe("forbidden");
    expect(
      classifyBrowserActionRisk(
        { type: "type", ref: "e1", text: "token" },
        element({ autocomplete: "one-time-code" }),
      ),
    ).toBe("forbidden");
  });

  it("classifies ordinary search/filter typing as input", () => {
    expect(
      classifyBrowserActionRisk(
        { type: "type", ref: "e1", text: "browser architecture" },
        element({ name: "Search docs" }),
      ),
    ).toBe("input");
  });

  it("classifies GET links and side-effect-free controls as read", () => {
    expect(
      classifyBrowserActionRisk(
        { type: "click", ref: "e1" },
        element({
          tag: "a",
          role: "link",
          href: "https://example.com/search?q=browser",
        }),
      ),
    ).toBe("read");
    expect(
      classifyBrowserActionRisk(
        { type: "click", ref: "e1" },
        element({ tag: "button", role: "button", name: "Show filters" }),
      ),
    ).toBe("read");
  });

  it("classifies submit, non-GET forms, destructive and financial actions as external effects", () => {
    for (const candidate of [
      element({
        tag: "button",
        name: "Submit",
        buttonType: "submit",
        formMethod: "post",
      }),
      element({ tag: "button", name: "Buy now" }),
      element({ tag: "button", name: "Delete account" }),
      element({ tag: "button", name: "Invite member" }),
      element({ tag: "button", name: "", inForm: true }),
    ]) {
      expect(
        classifyBrowserActionRisk(
          { type: "click", ref: candidate.ref },
          candidate,
        ),
      ).toBe("external-effect");
    }
  });
});

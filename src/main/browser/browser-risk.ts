import type {
  BrowserAction,
  BrowserElementRef,
  BrowserRisk,
} from "../../shared/browser";

const FORBIDDEN_AUTOCOMPLETE_RE =
  /^(?:current-password|new-password|one-time-code|cc-name|cc-given-name|cc-additional-name|cc-family-name|cc-number|cc-exp|cc-exp-month|cc-exp-year|cc-csc)$/i;
const FORBIDDEN_DESCRIPTOR_RE =
  /\b(?:password|passcode|recovery code|backup code|api[\s_-]*key|secret|token|otp|one[\s_-]*time|card number|credit card|cvv|cvc|security code)\b/i;
const EXTERNAL_EFFECT_RE =
  /\b(?:buy|purchase|pay|checkout|order|send|post|publish|submit|invite|grant|allow|permission|delete|remove|archive|unsubscribe|cancel subscription|close account|create account|sign up|register|confirm|save changes|update account|transfer|withdraw|deposit)\b/i;
const READ_CONTROL_RE =
  /\b(?:show|hide|view|open|close|expand|collapse|filter|sort|search|next|previous|back|forward|more|details|menu|tab|preview|refresh|reload)\b/i;

const descriptor = (element: BrowserElementRef): string =>
  [
    element.name,
    element.role,
    element.tag,
    element.inputType,
    element.autocomplete,
  ]
    .filter(Boolean)
    .join(" ");

const isForbiddenControl = (element: BrowserElementRef): boolean => {
  const inputType = element.inputType?.toLowerCase();
  if (inputType === "password" || inputType === "file") return true;
  if (
    element.autocomplete &&
    FORBIDDEN_AUTOCOMPLETE_RE.test(element.autocomplete)
  ) {
    return true;
  }
  return FORBIDDEN_DESCRIPTOR_RE.test(descriptor(element));
};

const formSubmissionRisk = (element: BrowserElementRef): BrowserRisk => {
  const method = element.formMethod?.toLowerCase() || "get";
  if (method !== "get") return "external-effect";
  return "read";
};

export const classifyBrowserActionRisk = (
  action: BrowserAction,
  element?: BrowserElementRef,
): BrowserRisk => {
  if (action.type === "scroll") return "read";

  if (!element) {
    if (action.type === "press") {
      return /^(?:Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|PageUp|PageDown|Home|End|Tab)$/i.test(
        action.key,
      )
        ? "read"
        : "external-effect";
    }
    return "external-effect";
  }

  if (isForbiddenControl(element)) return "forbidden";
  if (action.type === "type") return "input";

  if (action.type === "press") {
    if (/^(?:Enter|Return)$/i.test(action.key) && element.inForm) {
      return formSubmissionRisk(element);
    }
    return "input";
  }

  const label = descriptor(element);
  if (EXTERNAL_EFFECT_RE.test(label)) return "external-effect";

  if (element.tag === "a" || element.role === "link") {
    if (!element.href) return "external-effect";
    try {
      const protocol = new URL(element.href).protocol;
      return protocol === "http:" || protocol === "https:"
        ? "read"
        : "external-effect";
    } catch {
      return "external-effect";
    }
  }

  const buttonLike =
    element.tag === "button" ||
    element.role === "button" ||
    ["button", "submit", "reset"].includes(
      element.inputType?.toLowerCase() ?? "",
    );
  if (buttonLike) {
    const buttonType = element.buttonType?.toLowerCase();
    if (element.inForm && (!buttonType || buttonType === "submit")) {
      if (!element.name?.trim()) return "external-effect";
      return formSubmissionRisk(element);
    }
    return READ_CONTROL_RE.test(label) ? "read" : "external-effect";
  }

  if (
    ["checkbox", "radio", "combobox", "listbox", "option", "switch"].includes(
      element.role?.toLowerCase() ?? "",
    )
  ) {
    return "input";
  }

  return "read";
};

export const browserActionTarget = (element?: BrowserElementRef): string =>
  element?.name?.trim() || element?.ref || "current page";

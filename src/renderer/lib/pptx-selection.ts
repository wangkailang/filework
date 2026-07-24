export const PPTX_SELECTION_EVENT = "filework:pptx-selection";

const SELECTION_BLOCK_START = "<pptx-selection>";
const SELECTION_BLOCK_END = "</pptx-selection>";
const MAX_SELECTION_TEXT_LENGTH = 2_000;

export interface PptxObjectSelection {
  editableText: boolean;
  objectId: string;
  objectType: string;
  shapeIndex: number;
  slideIndex: number;
  sourcePath: string;
  sourceRevision: string;
  text: string;
}

export interface PreparedPresentationSvg {
  objectCount: number;
  svg: string;
}

const isSafeSvgReference = (value: string): boolean => {
  const normalized = value.trim();
  return (
    normalized.startsWith("#") ||
    /^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(normalized)
  );
};

const hasUnsafeCss = (value: string): boolean =>
  /expression\s*\(|@import|url\s*\(\s*["']?(?!#)/i.test(value);

const sanitizeElementAttributes = (element: Element) => {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const value = attribute.value;
    if (
      name.startsWith("on") ||
      name === "src" ||
      name === "action" ||
      name === "formaction" ||
      name === "target"
    ) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (
      hasUnsafeCss(value) ||
      /^\s*(?:https?:|file:|javascript:|data:text\/html)/i.test(value)
    ) {
      element.removeAttribute(attribute.name);
      continue;
    }
    if (
      (name === "href" || name === "xlink:href") &&
      !isSafeSvgReference(value)
    ) {
      element.removeAttribute(attribute.name);
    }
  }
};

const parseIndex = (value: string | null): number | null => {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const prepareInteractivePresentationSvg = (
  rawSvg: string,
  slideIndex: number,
): PreparedPresentationSvg | null => {
  const document = new window.DOMParser().parseFromString(
    rawSvg,
    "image/svg+xml",
  );
  const root = document.documentElement;
  if (root.tagName.toLowerCase() !== "svg") return null;

  for (const unsafe of Array.from(
    root.querySelectorAll(
      "script, foreignObject, iframe, object, embed, audio, video, canvas, link, style, animate, animateMotion, animateTransform, set, discard",
    ),
  )) {
    unsafe.remove();
  }
  sanitizeElementAttributes(root);
  for (const element of Array.from(root.querySelectorAll("*"))) {
    sanitizeElementAttributes(element);
  }

  let objectCount = 0;
  for (const shape of Array.from(
    root.querySelectorAll("g[data-ooxml-shape-idx]"),
  )) {
    const shapeIndex = parseIndex(shape.getAttribute("data-ooxml-shape-idx"));
    if (shapeIndex === null) continue;
    const objectId = `slide:${slideIndex}/shape:${shapeIndex}`;
    shape.setAttribute("data-presentation-object-id", objectId);
    shape.setAttribute("data-presentation-selectable", "true");
    shape.setAttribute("role", "button");
    shape.setAttribute("tabindex", "0");
    objectCount++;

    for (const run of Array.from(
      shape.querySelectorAll("tspan[data-ooxml-run-idx]"),
    )) {
      const paragraph = run.closest("tspan[data-ooxml-para-idx]");
      const paragraphIndex = parseIndex(
        paragraph?.getAttribute("data-ooxml-para-idx") ?? null,
      );
      const runIndex = parseIndex(run.getAttribute("data-ooxml-run-idx"));
      if (paragraphIndex === null || runIndex === null) continue;
      run.setAttribute(
        "data-presentation-text-object-id",
        `${objectId}/text:${paragraphIndex}:${runIndex}`,
      );
    }
  }

  return {
    objectCount,
    svg: root.outerHTML,
  };
};

export const isPptxObjectSelection = (
  value: unknown,
): value is PptxObjectSelection => {
  if (!value || typeof value !== "object") return false;
  const selection = value as Partial<PptxObjectSelection>;
  return (
    typeof selection.editableText === "boolean" &&
    typeof selection.objectId === "string" &&
    selection.objectId.length > 0 &&
    typeof selection.objectType === "string" &&
    Number.isSafeInteger(selection.shapeIndex) &&
    Number.isSafeInteger(selection.slideIndex) &&
    typeof selection.sourcePath === "string" &&
    selection.sourcePath.toLowerCase().endsWith(".pptx") &&
    typeof selection.sourceRevision === "string" &&
    selection.sourceRevision.length > 0 &&
    typeof selection.text === "string"
  );
};

const selectionBlock = (selection: PptxObjectSelection): string =>
  [
    SELECTION_BLOCK_START,
    JSON.stringify(
      {
        ...selection,
        text: selection.text.slice(0, MAX_SELECTION_TEXT_LENGTH),
      },
      null,
      2,
    ),
    SELECTION_BLOCK_END,
  ].join("\n");

export const mergePptxSelectionIntoPrompt = (
  currentPrompt: string,
  selection: PptxObjectSelection,
): string => {
  const withoutSelection = currentPrompt
    .replace(/<pptx-selection>[\s\S]*?<\/pptx-selection>\s*/g, "")
    .replace(/^\/pptx-editor\b\s*/i, "")
    .trim();
  const instruction =
    withoutSelection || "请描述要如何修改选中的 PowerPoint 元素：";
  return [`/pptx-editor ${selectionBlock(selection)}`, "", instruction].join(
    "\n",
  );
};

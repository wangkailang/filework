import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, join, resolve } from "node:path";

import { DOMParser } from "linkedom";

const PPTX_RENDERER_VERSION = "pptx-svg@0.6.4";
const requirePptxSvg = createRequire(import.meta.url);

export interface PptxRendererAdapter {
  init(): Promise<void>;
  loadPptx(buffer: ArrayBuffer): Promise<{ slideCount: number }>;
  getSlideCount(): number;
  isSlideHidden(slideIndex: number): boolean;
  renderSlideSvg(slideIndex: number): string;
  getSlideNotes(slideIndex: number): string[];
  updateShapeText(
    slideIndex: number,
    shapeIndex: number,
    paragraphIndex: number,
    runIndex: number,
    text: string,
  ): string;
  exportPptx(): Promise<ArrayBuffer>;
}

type RendererFactory = () => Promise<PptxRendererAdapter>;

export interface PptxPreviewSlide {
  index: number;
  hidden: boolean;
  notes: string | null;
  previewPath: string;
}

export interface PptxPreviewResult {
  cacheKey: string;
  cacheHit: boolean;
  rendererVersion: string;
  slides: PptxPreviewSlide[];
  sourceMtimeMs: number;
  sourceSize: number;
}

export interface PresentationTextRun {
  objectId: string;
  paragraphIndex: number;
  runIndex: number;
  text: string;
}

export interface PresentationObject {
  geometry: string | null;
  objectId: string;
  shapeIndex: number;
  textRuns: PresentationTextRun[];
  type: string | null;
}

export interface InspectedPresentationSlide {
  hidden: boolean;
  index: number;
  notes: string[];
  objects: PresentationObject[];
}

export interface InspectedPresentation {
  slideCount: number;
  slides: InspectedPresentationSlide[];
  sourceRevision: string;
}

export interface PresentationTextEdit {
  objectId: string;
  text: string;
}

export interface EditPresentationRequest {
  sourcePath: string;
  sourceRevision?: string;
  outputPath?: string;
  edits: PresentationTextEdit[];
}

export interface EditPresentationResult {
  editedSlides: number[];
  outputPath: string;
  slideCount: number;
}

interface RendererOptions {
  createRenderer?: RendererFactory;
}

interface PreviewOptions extends RendererOptions {
  cacheRoot: string;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const defaultRendererFactory: RendererFactory = async () => {
  const [{ PptxRenderer }, wasmBytes] = await Promise.all([
    import("pptx-svg"),
    readFile(requirePptxSvg.resolve("pptx-svg/wasm")),
  ]);
  const renderer = new PptxRenderer({ logLevel: "error" });
  return {
    exportPptx: () => renderer.exportPptx(),
    getSlideCount: () => renderer.getSlideCount(),
    getSlideNotes: (slideIndex) => renderer.getSlideNotes(slideIndex),
    init: () => renderer.init(toArrayBuffer(wasmBytes)),
    isSlideHidden: (slideIndex) => renderer.isSlideHidden(slideIndex),
    loadPptx: (buffer) => renderer.loadPptx(buffer),
    renderSlideSvg: (slideIndex) => renderer.renderSlideSvg(slideIndex),
    updateShapeText: (slideIndex, shapeIndex, paragraphIndex, runIndex, text) =>
      renderer.updateShapeText(
        slideIndex,
        shapeIndex,
        paragraphIndex,
        runIndex,
        text,
      ),
  };
};

const assertPptxPath = (filePath: string, label: string) => {
  if (extname(filePath).toLowerCase() !== ".pptx") {
    throw new Error(`${label} must use the .pptx extension: ${filePath}`);
  }
};

const loadRenderer = async (
  sourcePath: string,
  createRenderer: RendererFactory = defaultRendererFactory,
  expectedSourceRevision?: string,
) => {
  assertPptxPath(sourcePath, "Presentation");
  const bytes = await readFile(sourcePath);
  const fingerprint = await buildFingerprint(sourcePath, bytes);
  if (
    expectedSourceRevision &&
    expectedSourceRevision !== fingerprint.cacheKey
  ) {
    throw new Error(
      "Presentation source revision changed after selection; inspect the PPTX again before editing.",
    );
  }
  const renderer = await createRenderer();
  await renderer.init();
  await renderer.loadPptx(toArrayBuffer(bytes));
  return {
    bytes,
    renderer,
    sourceRevision: fingerprint.cacheKey,
  };
};

const renderSlide = (
  renderer: PptxRendererAdapter,
  slideIndex: number,
): string => {
  const svg = renderer.renderSlideSvg(slideIndex);
  if (svg.startsWith("ERROR:")) {
    throw new Error(`PPTX slide ${slideIndex + 1} render failed: ${svg}`);
  }
  return svg;
};

const writeAtomically = async (
  filePath: string,
  content: string | Uint8Array,
) => {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, content);
  await rename(tempPath, filePath);
};

const readCachedPreview = async (
  manifestPath: string,
): Promise<PptxPreviewResult | null> => {
  try {
    const cached = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as PptxPreviewResult;
    if (
      cached.rendererVersion !== PPTX_RENDERER_VERSION ||
      !Array.isArray(cached.slides)
    ) {
      return null;
    }
    await Promise.all(cached.slides.map((slide) => stat(slide.previewPath)));
    return { ...cached, cacheHit: true };
  } catch {
    return null;
  }
};

const buildFingerprint = async (sourcePath: string, bytes: Uint8Array) => {
  const sourceStat = await stat(sourcePath);
  const canonicalPath = await realpath(sourcePath).catch(() =>
    resolve(sourcePath),
  );
  const sourceHash = createHash("sha256").update(bytes).digest("hex");
  const cacheKey = createHash("sha256")
    .update(
      [
        "filework-pptx-preview-v1",
        canonicalPath,
        String(sourceStat.mtimeMs),
        String(sourceStat.size),
        sourceHash,
        PPTX_RENDERER_VERSION,
      ].join("\0"),
    )
    .digest("hex");
  return {
    cacheKey,
    sourceMtimeMs: sourceStat.mtimeMs,
    sourceSize: sourceStat.size,
  };
};

export const preparePptxPreview = async (
  sourcePath: string,
  options: PreviewOptions,
): Promise<PptxPreviewResult> => {
  assertPptxPath(sourcePath, "Presentation");
  const sourceBytes = await readFile(sourcePath);
  const fingerprint = await buildFingerprint(sourcePath, sourceBytes);
  const cacheDir = join(options.cacheRoot, fingerprint.cacheKey);
  const manifestPath = join(cacheDir, "preview.json");
  const cached = await readCachedPreview(manifestPath);
  if (cached) return cached;

  const renderer = await (options.createRenderer ?? defaultRendererFactory)();
  await renderer.init();
  await renderer.loadPptx(toArrayBuffer(sourceBytes));

  const slides: PptxPreviewSlide[] = [];
  for (
    let slideIndex = 0;
    slideIndex < renderer.getSlideCount();
    slideIndex++
  ) {
    const previewPath = join(cacheDir, `slide-${slideIndex + 1}.svg`);
    await writeAtomically(previewPath, renderSlide(renderer, slideIndex));
    const notes = renderer.getSlideNotes(slideIndex);
    slides.push({
      hidden: renderer.isSlideHidden(slideIndex),
      index: slideIndex + 1,
      notes: notes.length > 0 ? notes.join("\n") : null,
      previewPath,
    });
  }

  const result: PptxPreviewResult = {
    ...fingerprint,
    cacheHit: false,
    rendererVersion: PPTX_RENDERER_VERSION,
    slides,
  };
  await writeAtomically(manifestPath, JSON.stringify(result));
  return result;
};

const parsePresentationObjects = (
  svg: string,
  slideNumber: number,
): PresentationObject[] => {
  type SvgElement = {
    getAttribute(name: string): string | null;
    querySelectorAll(selector: string): ArrayLike<SvgElement>;
    textContent: string | null;
  };
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (!document) return [];

  const shapes = Array.from(
    document.querySelectorAll("g[data-ooxml-shape-idx]"),
  ) as unknown as SvgElement[];
  return shapes.map((shape) => {
    const shapeIndex = Number.parseInt(
      shape.getAttribute("data-ooxml-shape-idx") ?? "",
      10,
    );
    const runs = new Map<string, PresentationTextRun>();
    for (const paragraph of Array.from(
      shape.querySelectorAll("tspan[data-ooxml-para-idx]"),
    )) {
      const paragraphIndex = Number.parseInt(
        paragraph.getAttribute("data-ooxml-para-idx") ?? "",
        10,
      );
      for (const run of Array.from(
        paragraph.querySelectorAll("tspan[data-ooxml-run-idx]"),
      )) {
        const runIndex = Number.parseInt(
          run.getAttribute("data-ooxml-run-idx") ?? "",
          10,
        );
        if (
          !Number.isInteger(shapeIndex) ||
          !Number.isInteger(paragraphIndex) ||
          !Number.isInteger(runIndex)
        ) {
          continue;
        }
        const objectId = `slide:${slideNumber}/shape:${shapeIndex}/text:${paragraphIndex}:${runIndex}`;
        const previous = runs.get(objectId);
        runs.set(objectId, {
          objectId,
          paragraphIndex,
          runIndex,
          text: `${previous?.text ?? ""}${run.textContent ?? ""}`,
        });
      }
    }
    return {
      geometry: shape.getAttribute("data-ooxml-geom"),
      objectId: `slide:${slideNumber}/shape:${shapeIndex}`,
      shapeIndex,
      textRuns: Array.from(runs.values()),
      type: shape.getAttribute("data-ooxml-shape-type"),
    };
  });
};

export const inspectPptxPresentation = async (
  sourcePath: string,
  options: RendererOptions = {},
): Promise<InspectedPresentation> => {
  const { renderer, sourceRevision } = await loadRenderer(
    sourcePath,
    options.createRenderer ?? defaultRendererFactory,
  );
  const slides: InspectedPresentationSlide[] = [];
  for (
    let slideIndex = 0;
    slideIndex < renderer.getSlideCount();
    slideIndex++
  ) {
    slides.push({
      hidden: renderer.isSlideHidden(slideIndex),
      index: slideIndex + 1,
      notes: renderer.getSlideNotes(slideIndex),
      objects: parsePresentationObjects(
        renderSlide(renderer, slideIndex),
        slideIndex + 1,
      ),
    });
  }
  return { slideCount: renderer.getSlideCount(), slides, sourceRevision };
};

const parseTextObjectId = (objectId: string) => {
  const match = objectId.match(/^slide:(\d+)\/shape:(\d+)\/text:(\d+):(\d+)$/);
  if (!match) {
    throw new Error(`Invalid presentation text object id: ${objectId}`);
  }
  return {
    paragraphIndex: Number(match[3]),
    runIndex: Number(match[4]),
    shapeIndex: Number(match[2]),
    slideNumber: Number(match[1]),
  };
};

const defaultEditedPath = (sourcePath: string) =>
  join(
    dirname(sourcePath),
    `${basename(sourcePath, extname(sourcePath))}-edited.pptx`,
  );

export const editPptxPresentation = async (
  request: EditPresentationRequest,
  options: RendererOptions = {},
): Promise<EditPresentationResult> => {
  if (request.edits.length === 0) {
    throw new Error("At least one presentation text edit is required.");
  }
  const outputPath = resolve(
    request.outputPath ?? defaultEditedPath(request.sourcePath),
  );
  assertPptxPath(outputPath, "Presentation output");
  if (resolve(request.sourcePath) === outputPath) {
    throw new Error("Presentation edits must be exported to a new .pptx file.");
  }

  const { renderer } = await loadRenderer(
    request.sourcePath,
    options.createRenderer ?? defaultRendererFactory,
    request.sourceRevision,
  );
  const editedSlides = new Set<number>();
  for (const edit of request.edits) {
    const target = parseTextObjectId(edit.objectId);
    if (
      target.slideNumber < 1 ||
      target.slideNumber > renderer.getSlideCount()
    ) {
      throw new Error(`Presentation slide is out of range: ${edit.objectId}`);
    }
    const response = renderer.updateShapeText(
      target.slideNumber - 1,
      target.shapeIndex,
      target.paragraphIndex,
      target.runIndex,
      edit.text,
    );
    if (response.startsWith("ERROR:")) {
      throw new Error(
        `Presentation edit failed for ${edit.objectId}: ${response}`,
      );
    }
    editedSlides.add(target.slideNumber);
  }

  const exported = new Uint8Array(await renderer.exportPptx());
  await writeAtomically(outputPath, exported);
  return {
    editedSlides: Array.from(editedSlides).sort((a, b) => a - b),
    outputPath,
    slideCount: renderer.getSlideCount(),
  };
};

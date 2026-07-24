import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  editPptxPresentation,
  inspectPptxPresentation,
  type PptxRendererAdapter,
  preparePptxPreview,
} from "../pptx";

const slideSvg = (text: string) =>
  `<svg data-ooxml-slide-cx="12192000" data-ooxml-slide-cy="6858000">
    <g data-ooxml-shape-idx="0" data-ooxml-shape-type="autoshape" data-ooxml-geom="rect">
      <text>
        <tspan data-ooxml-para-idx="0">
          <tspan data-ooxml-run-idx="0">${text.slice(0, 6)}</tspan>
          <tspan data-ooxml-run-idx="0">${text.slice(6)}</tspan>
        </tspan>
      </text>
    </g>
  </svg>`;

const makeRenderer = () => {
  const renderer: PptxRendererAdapter = {
    exportPptx: vi
      .fn()
      .mockResolvedValue(new TextEncoder().encode("edited-pptx").buffer),
    getSlideCount: vi.fn().mockReturnValue(2),
    getSlideNotes: vi
      .fn()
      .mockImplementation((index: number) =>
        index === 1 ? ["Speaker note"] : [],
      ),
    init: vi.fn().mockResolvedValue(undefined),
    isSlideHidden: vi.fn().mockImplementation((index: number) => index === 1),
    loadPptx: vi.fn().mockResolvedValue({ slideCount: 2 }),
    renderSlideSvg: vi
      .fn()
      .mockImplementation((index: number) =>
        slideSvg(index === 0 ? "Hello world" : "Launch plan"),
      ),
    updateShapeText: vi.fn().mockReturnValue("<g>Updated</g>"),
  };
  return renderer;
};

describe("PPTX presentation model", () => {
  let root: string;
  let sourcePath: string;

  beforeEach(async () => {
    root = join(
      tmpdir(),
      `filework-pptx-model-${process.pid}-${Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`,
    );
    await mkdir(root, { recursive: true });
    sourcePath = join(root, "deck.pptx");
    await writeFile(sourcePath, "source-pptx");
  });

  it("renders every slide to cached SVG without an external Office process", async () => {
    const renderer = makeRenderer();
    const createRenderer = vi.fn().mockResolvedValue(renderer);

    const first = await preparePptxPreview(sourcePath, {
      cacheRoot: join(root, "cache"),
      createRenderer,
    });
    const second = await preparePptxPreview(sourcePath, {
      cacheRoot: join(root, "cache"),
      createRenderer,
    });

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(first.slides).toEqual([
      {
        hidden: false,
        index: 1,
        notes: null,
        previewPath: expect.stringMatching(/slide-1\.svg$/),
      },
      {
        hidden: true,
        index: 2,
        notes: "Speaker note",
        previewPath: expect.stringMatching(/slide-2\.svg$/),
      },
    ]);
    const rendered = await readFile(first.slides[0].previewPath, "utf8");
    expect(rendered).toContain(">Hello </tspan>");
    expect(rendered).toContain(">world</tspan>");
    expect(renderer.renderSlideSvg).toHaveBeenCalledTimes(2);
    expect(createRenderer).toHaveBeenCalledTimes(1);
  });

  it("inspects rendered objects through stable text-run ids", async () => {
    const renderer = makeRenderer();

    const result = await inspectPptxPresentation(sourcePath, {
      createRenderer: vi.fn().mockResolvedValue(renderer),
    });

    expect(result.slideCount).toBe(2);
    expect(result.sourceRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.slides[0].objects).toEqual([
      {
        geometry: "rect",
        objectId: "slide:1/shape:0",
        shapeIndex: 0,
        textRuns: [
          {
            objectId: "slide:1/shape:0/text:0:0",
            paragraphIndex: 0,
            runIndex: 0,
            text: "Hello world",
          },
        ],
        type: "autoshape",
      },
    ]);
  });

  it("edits an exact text object and exports a new PPTX copy", async () => {
    const renderer = makeRenderer();
    const outputPath = join(root, "deck-edited.pptx");

    const result = await editPptxPresentation(
      {
        edits: [
          {
            objectId: "slide:2/shape:0/text:0:0",
            text: "Updated launch",
          },
        ],
        outputPath,
        sourcePath,
      },
      {
        createRenderer: vi.fn().mockResolvedValue(renderer),
      },
    );

    expect(renderer.updateShapeText).toHaveBeenCalledWith(
      1,
      0,
      0,
      0,
      "Updated launch",
    );
    expect(result).toEqual({
      editedSlides: [2],
      outputPath,
      slideCount: 2,
    });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("edited-pptx");
    await expect(readFile(sourcePath, "utf8")).resolves.toBe("source-pptx");
  });

  it("rejects an edit anchored to a stale source revision", async () => {
    const renderer = makeRenderer();
    const preview = await preparePptxPreview(sourcePath, {
      cacheRoot: join(root, "cache"),
      createRenderer: vi.fn().mockResolvedValue(renderer),
    });
    await writeFile(sourcePath, "externally-modified-pptx");

    await expect(
      editPptxPresentation(
        {
          edits: [
            {
              objectId: "slide:1/shape:0/text:0:0",
              text: "Must not apply",
            },
          ],
          outputPath: join(root, "stale-edit.pptx"),
          sourcePath,
          sourceRevision: preview.cacheKey,
        },
        {
          createRenderer: vi.fn().mockResolvedValue(renderer),
        },
      ),
    ).rejects.toThrow("source revision");
    expect(renderer.updateShapeText).not.toHaveBeenCalled();
  });
});

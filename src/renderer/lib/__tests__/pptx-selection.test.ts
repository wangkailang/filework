import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  mergePptxSelectionIntoPrompt,
  prepareInteractivePresentationSvg,
} from "../pptx-selection";

describe("PPTX local element selection", () => {
  beforeEach(() => {
    const { window } = parseHTML("<html></html>");
    vi.stubGlobal("window", window);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sanitizes SVG and decorates shapes and text runs with local object IDs", () => {
    const result = prepareInteractivePresentationSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="steal()">
        <script>steal()</script>
        <image href="https://example.com/private.png" />
        <g data-ooxml-shape-idx="4" data-ooxml-shape-type="autoshape">
          <rect width="20" height="10" onclick="steal()" />
          <text>
            <tspan data-ooxml-para-idx="1">
              <tspan data-ooxml-run-idx="2">Revenue</tspan>
            </tspan>
          </text>
        </g>
      </svg>`,
      3,
    );

    expect(result).not.toBeNull();
    expect(result?.objectCount).toBe(1);
    expect(result?.svg).toContain(
      'data-presentation-object-id="slide:3/shape:4"',
    );
    expect(result?.svg).toContain(
      'data-presentation-text-object-id="slide:3/shape:4/text:1:2"',
    );
    expect(result?.svg).not.toContain("<script");
    expect(result?.svg).not.toContain("onload=");
    expect(result?.svg).not.toContain("onclick=");
    expect(result?.svg).not.toContain("https://example.com/private.png");
  });

  it("replaces the selected object context without discarding the user instruction", () => {
    const first = mergePptxSelectionIntoPrompt("把它改成蓝色", {
      editableText: true,
      objectId: "slide:1/shape:2/text:0:0",
      objectType: "text",
      shapeIndex: 2,
      slideIndex: 1,
      sourcePath: "/workspace/deck.pptx",
      sourceRevision: "revision-a",
      text: "Old title",
    });
    const second = mergePptxSelectionIntoPrompt(first, {
      editableText: true,
      objectId: "slide:2/shape:5/text:0:0",
      objectType: "text",
      shapeIndex: 5,
      slideIndex: 2,
      sourcePath: "/workspace/deck.pptx",
      sourceRevision: "revision-a",
      text: "Other title",
    });

    expect(second.match(/\/pptx-editor/g)).toHaveLength(1);
    expect(second).toMatch(/^\/pptx-editor <pptx-selection>/);
    expect(second).toContain("slide:2/shape:5/text:0:0");
    expect(second).not.toContain("slide:1/shape:2/text:0:0");
    expect(second).toContain("把它改成蓝色");
  });
});

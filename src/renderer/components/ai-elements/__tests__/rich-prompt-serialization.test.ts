import { describe, expect, it } from "vitest";
import { readEditorPlainText } from "../prompt-input";
import { promptDocToText, textToPromptDoc } from "../rich-prompt-serialization";

describe("rich prompt serialization", () => {
  it("round-trips plain multiline text through the Tiptap document shape", () => {
    const doc = textToPromptDoc("first line\nsecond line\n\nfourth line");

    expect(doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "first line" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "second line" }],
        },
        { type: "paragraph" },
        {
          type: "paragraph",
          content: [{ type: "text", text: "fourth line" }],
        },
      ],
    });
    expect(promptDocToText(doc)).toBe("first line\nsecond line\n\nfourth line");
  });

  it("keeps empty editor content as an empty prompt", () => {
    expect(promptDocToText(textToPromptDoc(""))).toBe("");
  });

  it("serializes selected skill chips back to slash commands", () => {
    expect(
      promptDocToText({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "skillMention", attrs: { id: "pdf", name: "PDF" } },
              { type: "text", text: " summarize this" },
            ],
          },
        ],
      }),
    ).toBe("/pdf summarize this");
  });

  it("reads selected skill chips from the editor as slash commands", () => {
    const skillLeaf = {
      attrs: { id: "canvas-design" },
      type: { name: "skillMention" },
    };
    const text = readEditorPlainText({
      state: {
        doc: {
          content: { size: 1 },
          textBetween: (_from, _to, _blockSeparator, leafText) =>
            `${typeof leafText === "function" ? leafText(skillLeaf) : ""} 创建端午节划龙舟海报`,
        },
      },
    });

    expect(text).toBe("/canvas-design 创建端午节划龙舟海报");
  });
});

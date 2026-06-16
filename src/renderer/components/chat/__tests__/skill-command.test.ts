import { describe, expect, it } from "vitest";
import {
  filterSkillCommands,
  findActiveSkillSlash,
  resolveSkillSlashTextRange,
  SKILL_MENTION_TEXT_MARKER,
} from "../skill-command";

const skills = [
  {
    id: "pdf",
    name: "PDF Processor",
    description: "Read and summarize PDF files",
    source: "built-in",
  },
  {
    id: "pptx",
    name: "Presentation Builder",
    description: "Create slide decks",
    source: "project",
  },
];

describe("skill command helpers", () => {
  it("detects a slash command query at the start of the editor block", () => {
    expect(findActiveSkillSlash("/pd")).toEqual({ query: "pd", from: 0 });
    expect(findActiveSkillSlash("please /pd")).toBeNull();
    expect(findActiveSkillSlash("/pdf summarize")).toBeNull();
  });

  it("detects a slash command after existing selected skills", () => {
    expect(findActiveSkillSlash("/pdf /da")).toEqual({ query: "da", from: 5 });
    expect(findActiveSkillSlash("/pdf  /ppt")).toEqual({
      query: "ppt",
      from: 6,
    });
    expect(findActiveSkillSlash(`${SKILL_MENTION_TEXT_MARKER} /ppt`)).toEqual({
      query: "ppt",
      from: 2,
    });
  });

  it("detects another slash command after a selected skill and prompt text", () => {
    expect(findActiveSkillSlash("/project-scaffolder 搭建 /")).toEqual({
      query: "",
      from: 23,
    });
    expect(
      findActiveSkillSlash(`${SKILL_MENTION_TEXT_MARKER} 搭建 /pd`),
    ).toEqual({
      query: "pd",
      from: 5,
    });
  });

  it("allows a second slash from a later paragraph when the document starts with a selected skill", () => {
    const localTextBeforeCursor = "asdsdasds /";
    const documentTextBeforeCursor = `${SKILL_MENTION_TEXT_MARKER} 阿萨斯多\n${localTextBeforeCursor}`;

    expect(
      resolveSkillSlashTextRange({
        documentTextBeforeCursor,
        localTextBeforeCursor,
      }),
    ).toEqual({ query: "", from: 10 });
    expect(
      resolveSkillSlashTextRange({
        documentTextBeforeCursor: `阿萨斯多\n${localTextBeforeCursor}`,
        localTextBeforeCursor,
      }),
    ).toBeNull();
  });

  it("filters skills by id, name, or description", () => {
    expect(filterSkillCommands(skills, "pdf").map((s) => s.id)).toEqual([
      "pdf",
    ]);
    expect(filterSkillCommands(skills, "slide").map((s) => s.id)).toEqual([
      "pptx",
    ]);
  });
});

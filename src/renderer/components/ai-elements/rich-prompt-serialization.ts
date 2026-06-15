export type PromptTextNode = {
  type: "text";
  text: string;
};

export type PromptSkillMentionNode = {
  type: "skillMention";
  attrs?: {
    description?: string;
    id?: string;
    name?: string;
    source?: string;
  };
};

export type PromptInlineNode = PromptTextNode | PromptSkillMentionNode;

export type PromptParagraphNode = {
  type: "paragraph";
  content?: PromptInlineNode[];
};

export type PromptDocNode = {
  type: "doc";
  content?: PromptParagraphNode[];
};

export const textToPromptDoc = (text: string): PromptDocNode => ({
  type: "doc",
  content: text.split("\n").map((line) => {
    if (!line) return { type: "paragraph" };
    return {
      type: "paragraph",
      content: [{ type: "text", text: line }],
    };
  }),
});

export const promptDocToText = (doc: PromptDocNode | null | undefined) => {
  const paragraphs = doc?.content ?? [];
  if (paragraphs.length === 0) return "";

  return paragraphs
    .map((paragraph) =>
      (paragraph.content ?? [])
        .map((node) => {
          if (node.type === "text") return node.text;
          if (node.type === "skillMention") {
            return node.attrs?.id ? `/${node.attrs.id}` : "";
          }
          return "";
        })
        .join(""),
    )
    .join("\n");
};

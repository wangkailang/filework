import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      attachment_preview: (name: string) => `预览附件 ${name}`,
      attachment_remove: (name: string) => `移除附件 ${name}`,
      attachment_reveal: (name: string) => `在 Finder 中显示 ${name}`,
    },
  }),
}));

vi.mock("../ImageLightbox", () => ({
  ImageLightbox: () => null,
}));

import { AttachmentChips, AttachmentList } from "../AttachmentChips";

const imageAttachment = {
  attachmentId: "image-1",
  kind: "image" as const,
  mimeType: "image/png",
  name: "photo.png",
  path: "/workspace/photo.png",
  size: 2048,
};

const textAttachment = {
  attachmentId: "text-1",
  kind: "text" as const,
  mimeType: "text/plain",
  name: "notes.txt",
  path: "/workspace/notes.txt",
  size: 1024,
};

describe("attachment interactions", () => {
  it("localizes preview and remove actions in the composer", () => {
    const html = renderToStaticMarkup(
      <AttachmentChips attachments={[imageAttachment]} onRemove={vi.fn()} />,
    );

    expect(html).toContain('aria-label="预览附件 photo.png"');
    expect(html).toContain('aria-label="移除附件 photo.png"');
    expect(html).not.toContain('aria-label="Remove photo.png"');
  });

  it("localizes history actions and uses semantic file colors", () => {
    const html = renderToStaticMarkup(
      <AttachmentList attachments={[textAttachment]} />,
    );

    expect(html).toContain('title="在 Finder 中显示 notes.txt"');
    expect(html).toContain("text-file-code");
    expect(html).not.toContain("text-blue-500");
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: {
      browserDownload_cancelled: () => "下载已取消",
      browserDownload_completed: () => "下载完成",
      browserDownload_interrupted: () => "下载已中断",
      browserDownload_progress: ({ percent }: { percent: number }) =>
        `${percent}%`,
      browserDownload_showInFinder: () => "显示已下载文件",
      browserSettings_downloads: () => "下载",
    },
  }),
}));

import { BrowserDownloadShelf } from "../BrowserDownloadShelf";

describe("BrowserDownloadShelf", () => {
  it("shows progress and the final download path in browser chrome", () => {
    const html = renderToStaticMarkup(
      <BrowserDownloadShelf
        downloads={[
          {
            id: "download-1",
            filename: "report.pdf",
            status: "progressing",
            receivedBytes: 42,
            totalBytes: 100,
            savePath: "/Users/test/Downloads/report.pdf",
          },
          {
            id: "download-2",
            filename: "archive.zip",
            status: "completed",
            receivedBytes: 100,
            totalBytes: 100,
            savePath: "/Users/test/Downloads/archive.zip",
          },
        ]}
      />,
    );

    expect(html).toContain("report.pdf");
    expect(html).toContain("42%");
    expect(html).toContain("下载完成");
    expect(html).toContain("/Users/test/Downloads/archive.zip");
    expect(html).toContain('data-browser-downloads="true"');
  });
});

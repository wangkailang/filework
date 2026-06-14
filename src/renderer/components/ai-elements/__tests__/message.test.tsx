import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MessageResponse } from "../message";

describe("MessageResponse", () => {
  it("renders markdown tables with compact chat table styling", () => {
    const html = renderToStaticMarkup(
      <MessageResponse>
        {
          "| 日期 | 天气 | 气温 |\n| --- | --- | --- |\n| 6月14日 周日 | 阵雨、雷雨 | 26-29°C |\n| 6月15日 周一 | 上午雷雨，下午有雨 | 25-28°C |"
        }
      </MessageResponse>,
    );

    expect(html).toContain('data-chat-table-scroll="true"');
    expect(html).toContain('data-chat-table="true"');
    expect(html).toContain("<th");
    expect(html).toContain("border-b");
    expect(html).toContain("last:pr-0");
    expect(html).not.toContain("rounded-lg border");
  });
});

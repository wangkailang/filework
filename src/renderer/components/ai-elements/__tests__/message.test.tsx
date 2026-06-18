import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MessageActionFrame,
  MessageActions,
  MessageResponse,
  MessageSkillText,
  messageActionsHoverClass,
} from "../message";

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

  it("expands message action hover through the message frame without adding an action row", () => {
    const html = renderToStaticMarkup(
      <MessageActionFrame from="user">
        <div>message bubble</div>
        <MessageActions className={messageActionsHoverClass}>
          <button type="button">copy</button>
        </MessageActions>
      </MessageActionFrame>,
    );

    expect(html).toContain("group/message-actions");
    expect(html).toContain("after:absolute");
    expect(html).toContain("after:top-full");
    expect(html).toContain("after:h-8");
    expect(html).toContain("after:min-w-16");
    expect(html).toContain("w-fit");
    expect(html).toContain("absolute");
    expect(html).toContain("top-full");
    expect(html).toContain("-translate-y-1/2");
    expect(html).toContain("rounded-lg");
    expect(html).toContain("bg-background/95");
    expect(html).toContain("shadow-sm");
    expect(html).toContain("z-20");
    expect(html).toContain("group-hover/message-actions:opacity-100");
  });
});

describe("MessageSkillText", () => {
  it("renders leading slash skills as lightweight chips without command slashes", () => {
    const html = renderToStaticMarkup(
      <MessageSkillText text="/pdf-processor /algorithmic-art summarize this" />,
    );

    expect(html).toContain('data-skill-mention=""');
    expect(html).toContain('data-skill-id="pdf-processor"');
    expect(html).toContain('data-skill-id="algorithmic-art"');
    expect(html).toContain(">pdf-processor</span>");
    expect(html).toContain(">algorithmic-art</span>");
    expect(html).not.toContain(">/pdf-processor</span>");
    expect(html).not.toContain(">/algorithmic-art</span>");
    expect(html).toContain("summarize this");
  });

  it("does not chip slash text inside ordinary prose", () => {
    const html = renderToStaticMarkup(
      <MessageSkillText text="please use /pdf-processor" />,
    );

    expect(html).not.toContain("data-skill-mention");
    expect(html).toContain("please use /pdf-processor");
  });

  it("does not chip leading filesystem paths", () => {
    const html = renderToStaticMarkup(
      <MessageSkillText text="/Users/kailang/project" />,
    );

    expect(html).not.toContain("data-skill-mention");
    expect(html).toContain("/Users/kailang/project");
  });
});

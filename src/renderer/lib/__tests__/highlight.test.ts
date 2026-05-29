import { describe, expect, it } from "vitest";
import {
  highlightToLines,
  resolveHljsLang,
  splitHtmlByLines,
} from "../highlight";

/** 断言一行内 <span 开闭标签数量相等(即每行 HTML 自闭合)。 */
const isBalanced = (line: string): boolean => {
  const open = (line.match(/<span\b/g) ?? []).length;
  const close = (line.match(/<\/span>/g) ?? []).length;
  return open === close;
};

describe("splitHtmlByLines", () => {
  it("无标签纯文本:按换行原样切分", () => {
    expect(splitHtmlByLines("a\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("跨行 span:每行各自闭合并在下一行重开", () => {
    const input = '<span class="hljs-comment">/* a\nb */</span>';
    expect(splitHtmlByLines(input)).toEqual([
      '<span class="hljs-comment">/* a</span>',
      '<span class="hljs-comment">b */</span>',
    ]);
  });

  it("行内成对 span 不受影响", () => {
    const input = '<span class="hljs-keyword">const</span> x\ny';
    expect(splitHtmlByLines(input)).toEqual([
      '<span class="hljs-keyword">const</span> x',
      "y",
    ]);
  });

  it("末尾换行产生一个空行", () => {
    expect(splitHtmlByLines("a\n")).toEqual(["a", ""]);
  });
});

describe("highlightToLines", () => {
  it("行数与源文本(按 \\n)一致,且每行 span 自闭合 —— 含跨行块注释", () => {
    const code = ["/* 跨行", "注释 */", "const x = 1;"].join("\n");
    const lines = highlightToLines(code, "typescript");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(isBalanced(line)).toBe(true);
    }
  });

  it("lang 为 null:逐行转义为纯文本", () => {
    expect(highlightToLines("a<b>&\nc", null)).toEqual([
      "a&lt;b&gt;&amp;",
      "c",
    ]);
  });

  it("高亮结果拼回(去标签后)等于原文,不丢字符", () => {
    const code = 'const s = "hi";\nlet n = 42;';
    const lines = highlightToLines(code, "typescript");
    const stripped = lines
      .join("\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");
    expect(stripped).toBe(code);
  });
});

describe("resolveHljsLang", () => {
  it("已注册语言与别名解析正确", () => {
    expect(resolveHljsLang("ts")).toBe("typescript");
    expect(resolveHljsLang("tsx")).toBe("typescript");
    expect(resolveHljsLang(".py")).toBe("python");
    expect(resolveHljsLang("JSON")).toBe("json");
    expect(resolveHljsLang("yml")).toBe("yaml");
  });

  it("未注册/空 → null", () => {
    expect(resolveHljsLang("nosuchlang")).toBeNull();
    expect(resolveHljsLang("")).toBeNull();
  });
});

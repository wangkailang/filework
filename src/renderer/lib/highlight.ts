// highlight.js 的集中配置:聊天代码块(markdown-code-block)与文件预览(code-viewer)
// 共用同一套语言注册与高亮工具,避免重复注册、保证视觉一致。
// 主题颜色由全局加载的 styles/hljs-theme.css 提供(含 .dark 覆盖),
// 因此高亮产物与明暗模式无关——切主题不需要重新高亮。
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

/** 语言/扩展名别名 → 已注册的 hljs 语言名。 */
export const LANG_ALIAS: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  "c#": "csharp",
  html: "xml",
  htm: "xml",
  svg: "xml",
  toml: "ini",
  conf: "ini",
  env: "ini",
  editorconfig: "ini",
  text: "plaintext",
  txt: "plaintext",
};

/** 把文本里的 HTML 敏感字符转义,供 dangerouslySetInnerHTML 安全注入。 */
export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * 把语言提示(markdown 的 ```lang 或文件扩展名去点后的值)解析成
 * 已注册的 hljs 语言名;无法识别返回 null(交给调用方走纯文本)。
 */
export const resolveHljsLang = (hint: string): string | null => {
  const key = hint.toLowerCase().replace(/^\./, "");
  if (!key) return null;
  const name = LANG_ALIAS[key] ?? key;
  return hljs.getLanguage(name) ? name : null;
};

/**
 * 把 hljs 输出的整段高亮 HTML 按换行切成"每行自闭合"的片段。
 *
 * hljs 的 token <span> 可能跨多行(如块注释、多行字符串),直接按 "\n"
 * split 会产生未闭合标签、破坏渲染。这里维护一个开启中的 <span> 栈:
 * 每遇到换行就把所有未闭合 span 关掉、结束当前行,再在下一行开头重新打开,
 * 使每一行都是独立合法的 HTML —— 这是按行虚拟化渲染的前提。
 */
export const splitHtmlByLines = (html: string): string[] => {
  const lines: string[] = [];
  // 栈里保存"开启标签原文",用于换行后原样重开。
  const openTags: string[] = [];
  let current = "";

  // hljs 仅产出 <span ...> / </span> 标签;其余皆为文本(含 &lt; 等实体)。
  const parts = html.match(/<[^>]+>|[^<]+/g) ?? [];
  for (const part of parts) {
    if (part.charCodeAt(0) === 60 /* '<' */) {
      if (part.charCodeAt(1) === 47 /* '/' */) {
        openTags.pop();
      } else {
        openTags.push(part);
      }
      current += part;
      continue;
    }
    // 文本片段:可能含多个换行。
    const segments = part.split("\n");
    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        // 行结束:闭合所有未闭合 span → 收行 → 新行重开这些 span。
        current += "</span>".repeat(openTags.length);
        lines.push(current);
        current = openTags.join("");
      }
      current += segments[i];
    }
  }
  lines.push(current);
  return lines;
};

/**
 * 整段高亮一次,返回按行切分的 HTML 片段数组(供虚拟化逐行渲染)。
 * lang 为 null 时不高亮,逐行转义为纯文本。
 * 返回数组长度与源文本行数(按 "\n" 切)一致。
 */
export const highlightToLines = (
  code: string,
  lang: string | null,
): string[] => {
  if (!lang) {
    return code.split("\n").map(escapeHtml);
  }
  const html = hljs.highlight(code, {
    language: lang,
    ignoreIllegals: true,
  }).value;
  return splitHtmlByLines(html);
};

export { hljs };

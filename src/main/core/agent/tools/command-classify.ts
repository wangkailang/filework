/**
 * 在后端对 `runCommand` 调用进行分类,使本轮摘要(以及任何其他消费方)
 * 直接从工具结果读取事实,而不是在渲染层重新解析 stdout。纯字符串输入 /
 * 数据输出 —— 无 IO,无副作用。
 */

export type CommandKind = "test" | "build" | "generic";

// 测试运行器的特征签名。先于 build 检查,这样同时构建和测试的命令
// (例如 `npm run build && npm test`)会被报告为一次测试运行 ——
// 这是关于用户真正关心什么的更强信号。
const TEST_PATTERNS: RegExp[] = [
  /\b(?:vitest|jest|mocha|ava|rspec|phpunit|cypress)\b/,
  /\bpytest\b/,
  /\b(?:go|cargo|deno|dotnet)\s+test\b/,
  /\bplaywright\s+test\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
];

const BUILD_PATTERNS: RegExp[] = [
  /\btsc\b/,
  /\b(?:go|cargo)\s+build\b/,
  /\bvite\s+build\b/,
  /\b(?:webpack|rollup|esbuild|gulp|grunt)\b/,
  /\b(?:make|cmake|gradle|mvn)\b/,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/,
];

export function classifyCommand(command: string): CommandKind {
  const c = command.toLowerCase();
  if (TEST_PATTERNS.some((re) => re.test(c))) return "test";
  if (BUILD_PATTERNS.some((re) => re.test(c))) return "build";
  return "generic";
}

// 会改动文件系统的命令头 —— 真正构成交付物的那有限集合。我们采用白名单
// (而不是把只读命令列入黑名单,那是个无界集合:管道、`while` 循环、
// `$(...)`、awk、任意脚本),以便卡片倾向于隐藏噪声,而不是把它暴露出来。
const MUTATING_HEADS = new Set([
  // 文件操作
  "mv",
  "cp",
  "rm",
  "rmdir",
  "mkdir",
  "touch",
  "ln",
  "link",
  "install",
  "dd",
  "truncate",
  "rsync",
  "trash",
  "srm",
  "mktemp",
  "mkfile",
  "mkfifo",
  "tee",
  // 归档 / 压缩
  "zip",
  "unzip",
  "tar",
  "gzip",
  "gunzip",
  "bzip2",
  "bunzip2",
  "xz",
  "unxz",
  "zstd",
  "7z",
  "compress",
  "rar",
  "unrar",
  // 权限 / 属性
  "chmod",
  "chown",
  "chgrp",
  "chflags",
  "xattr",
  // 媒体 / 文档转换(常见的 filework 交付物)
  "sips",
  "convert",
  "magick",
  "ffmpeg",
  "pandoc",
  "qpdf",
  "gs",
]);

// 内联脚本解释器:只有当片段中出现文件系统写入(见 MUTATION_MARKERS)时
// 才算交付物;一个纯粹"计算磁盘占用"的脚本不含此类标记,因而不进入卡片。
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "ruby",
  "perl",
  "bash",
  "sh",
  "zsh",
]);

// 会改变仓库 / 工作区状态的 git 子命令。
const MUTATING_GIT = new Set([
  "add",
  "commit",
  "mv",
  "rm",
  "checkout",
  "switch",
  "reset",
  "restore",
  "stash",
  "apply",
  "clean",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "init",
  "clone",
  "pull",
  "push",
  "tag",
]);

// 解释器片段中暗示它会写入文件系统或外派 shell 的子串 ——
// 此时该片段被视为交付物。
const MUTATION_MARKERS = [
  "remove",
  "rmdir",
  "rmtree",
  "unlink",
  "makedirs",
  "mkdir",
  "rename",
  "shutil",
  "subprocess",
  "os.system",
  "popen",
  "chmod",
  "chown",
  "truncate",
  "'w'",
  '"w"',
  "'wb'",
  '"wb"',
  "'a'",
  "'a+'",
  "mode='w'",
  'mode="w"',
];

function stripEnvAssignments(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length && /^\w+=/.test(tokens[i])) i++;
  return tokens.slice(i);
}

/**
 * 按 shell 运算符 `&&`、`||`、`;`、`|` 以及换行符把命令行拆分为多个片段,
 * 但仅当它们出现在引号之外时才拆分。朴素的 `.split()` 会在
 * `python3 -c "import os; print(...)"` 里字符串内的 `;` 处错误地拆开。
 * 引号内的管道符(例如 grep 的模式)也会保持完整。
 */
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      segments.push(buf);
      buf = "";
      i++; // 消费运算符的第二个字符
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      segments.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  segments.push(buf);
  return segments.map((s) => s.trim()).filter(Boolean);
}

/**
 * 当某个片段通过 `>` / `>>` 重定向写入真实文件时返回 true。
 * 忽略文件描述符复制(`2>&1`、`>&2`)和 `/dev/null`,它们不产生任何交付物。
 */
function hasWriteRedirect(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      if (segment[i + 1] === "&") continue; // 文件描述符复制,而非写文件
      const target = segment
        .slice(i + 1)
        .replace(/^>?\s*/, "")
        .split(/\s/)[0];
      if (target && target !== "/dev/null" && !target.startsWith("&")) {
        return true;
      }
    }
  }
  return false;
}

function segmentIsDeliverable(segment: string): boolean {
  if (hasWriteRedirect(segment)) return true;
  const tokens = stripEnvAssignments(segment.split(/\s+/).filter(Boolean));
  if (tokens.length === 0) return false;
  const head = tokens[0].replace(/^.*\//, ""); // 去掉任何前导路径
  if (MUTATING_HEADS.has(head)) return true;
  if (head === "git") return tokens.length > 1 && MUTATING_GIT.has(tokens[1]);
  if (head === "sed") return tokens.some((t) => t.startsWith("-i")); // 原地修改
  if (INTERPRETERS.has(head)) {
    const lower = segment.toLowerCase();
    return MUTATION_MARKERS.some((m) => lower.includes(m));
  }
  return false;
}

/**
 * 当一次 `runCommand` 调用改动了文件系统时返回 true —— 命令链中的任意片段
 * 运行了已知的文件改动命令(或通过重定向写入)。用于在本轮卡片中只保留
 * 真正的交付物;只读的检查类命令(`du`、`find | while ... stat`、计算脚本)
 * 返回 false 并被隐藏。在另一个方向上保持保守:无法识别的改动命令会被
 * 漏报,而绝不会被当作噪声展示出来。
 */
export function isDeliverableCommand(command: string): boolean {
  return splitSegments(command).some(segmentIsDeliverable);
}

/**
 * 从测试运行器的输出中提取 `{ passed, failed }`。通过简单地在合并后的输出中
 * 任意位置取第一个 `N passed` 和 `N failed` 计数,兼容常见格式
 * (jest / vitest / pytest)—— 这些运行器都会打印含这些 token 的汇总行。
 * 当两个 token 都不存在时(例如 go test 或非测试命令)返回 undefined,
 * 以便调用方可以完全省略 `testStats`。
 */
export function parseTestStats(
  stdout: string,
  stderr: string,
): { passed: number; failed: number } | undefined {
  const text = `${stdout}\n${stderr}`;
  const passedMatch = text.match(/(\d+)\s+passed/i);
  const failedMatch = text.match(/(\d+)\s+failed/i);
  if (!passedMatch && !failedMatch) return undefined;
  return {
    passed: passedMatch ? Number.parseInt(passedMatch[1], 10) : 0,
    failed: failedMatch ? Number.parseInt(failedMatch[1], 10) : 0,
  };
}

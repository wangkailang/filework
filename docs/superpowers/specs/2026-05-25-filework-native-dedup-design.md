# 设计:`@filework/native` 试水模块 — 并行去重(阶段一)

**日期**: 2026-05-25
**分支**: `feat/filework-native-dedup`
**状态**: 已批准,待实现

## 背景与目标

为项目引入 Rust 优化,采用「单点试水」策略。阶段一的**真正目的是打通
「Rust → napi-rs `.node` → electron-builder 跨平台分发」全链路**,性能提升是顺带验证。

选定的试水点是文件去重(`src/main/skills/duplicate-finder.ts`),因为它接口干净、
现有 JS 实现有明确硬伤(整文件读入内存、逐文件串行哈希、无 size 预过滤),
且与现有 skill 框架对接面小。

现有基础设施已就绪:`package.json` 已有 `better-sqlite3` + `electron-rebuild`
的 native 模块构建链路,新增 napi-rs 模块复用同一套打包/分发机制。

## 决策摘要

| 维度 | 决策 |
|------|------|
| 模块边界 | 通用 `@filework/native` 包,内部按能力拆模块;底层遍历器做成可复用单元,阶段二的 `directoryStats` 直接复用 |
| 构建分发 | 本地编译,跟 `better-sqlite3` 一样(postinstall 编译,不做预编译二进制) |
| 降级策略 | 硬依赖 native,加载失败即报错,删除旧 JS 实现 |
| 去重算法 | 先按 size 分桶,只哈希同 size 的文件;哈希用 blake3 |
| 类型映射 | `totalWastedBytes` / `size` 用 f64(JS `number`),不用 bigint |
| 执行模型 | napi `AsyncTask`,跑在 libuv 线程池,不阻塞主进程 |

## 架构与目录

native 做成**本地 workspace 包**,在 `node_modules` 里待遇与 `better-sqlite3` 一致,
electron-builder 打包 / asarUnpack 自动复用现有机制。

```
native/filework-native/
  Cargo.toml          # crate: filework-native, crate-type = ["cdylib"]
  package.json        # name: @filework/native, napi 配置 + build 脚本
  src/lib.rs          # #[napi] 导出 + 模块组装
  src/walker.rs       # 可复用并行遍历器(阶段二 directoryStats 直接接它)
  src/dedup.rs        # 去重逻辑(size 分桶 + blake3)
  index.js / index.d.ts   # napi-rs 生成,TS 侧 import 入口
```

- 新增 `pnpm-workspace.yaml`(目前没有),纳入 `native/*`。
- 根 `package.json` 加 `"@filework/native": "workspace:*"`。
- `postinstall` 追加 `napi build --release`,与 `electron-rebuild -f -w better-sqlite3` 并列。
- **N-API 稳定 ABI**:产出的 `.node` 跨 Node/Electron 版本无需重编译,
  因此**不需要进 electron-rebuild**,比 better-sqlite3 更省心。

## Native API 契约

导出单个函数,输出形状与现有 tool 完全对齐,使 TS 侧 `execute()` 成为薄包装:

```ts
// index.d.ts (napi 生成)
export function findDuplicates(
  rootPath: string,
  extensions?: string[],
): Promise<{
  scanned: number;
  skipped: number;
  duplicateGroups: number;
  totalWastedBytes: number;
  groups: { path: string; size: number }[][];  // 按浪费空间降序,cap 50 组
}>;
```

现有 tool 的所有规则**全部下沉到 Rust**:
- 跳过隐藏文件(名以 `.` 开头)
- 跳过路径含 `/.filework/` 或 `/node_modules/` 的项
- 扩展名过滤(传入 `extensions` 时,小写比较)
- `> 100MB` 的文件跳过并计入 `skipped`
- 跳过空文件(size === 0)
- 结果按 `size * count` 浪费空间降序排序,cap 50 组

TS 侧只剩参数透传 + 返回 tool result。

## 去重算法(`dedup.rs`)

1. `walker.rs` 并行遍历(`jwalk`,内置 rayon 并行),应用过滤规则,产出 `(path, size)` 列表。
2. 按 `size` 分桶;**桶内仅 1 个文件的直接丢弃,不哈希**。
3. 对剩余文件用 `rayon` 并行、`blake3` 流式分块读取计算哈希(不整文件入内存)。
4. 同哈希分组 → 排序 → cap → 返回。

blake3 自带多线程,但文件级已在 rayon 池内并行,**哈希采用单线程模式**避免线程争用。

## 执行模型

用 napi-rs 的 `AsyncTask`,函数返回 `Promise`,整个扫描跑在 libuv 线程池,
不阻塞 Electron 主进程事件循环。

## 错误处理契约(硬依赖,失败即报错)

- **加载失败**:薄加载层 `src/main/native/index.ts` `require` `.node`,失败时抛带修复提示的错误:
  `Failed to load @filework/native — run 'pnpm install' to rebuild (requires Rust toolchain)`。
- **扫描内单文件错误**(权限/读失败):Rust 内捕获并计入 `skipped`,不让整个扫描失败
  (与现有 `duplicate-finder.ts:67` 行为一致)。
- **根路径不存在 / 无权限**:整体 reject,error message 沿用现有 `FS_ERROR_TAG` 前缀约定
  (`FS_NOT_FOUND` / `FS_PERMISSION_DENIED`),renderer 已有解析逻辑,不破坏。
- 删除旧的 `hashFile` 与 JS 扫描循环,native 是唯一路径。

## Skill 接口对接

`duplicate-finder.ts` 的 `execute` 收缩为:

```ts
import { findDuplicates } from "../native";
// ...
execute: async ({ path, extensions }) => findDuplicates(path, extensions),
```

`Skill` 定义(id/name/keywords/systemPrompt/suggestions)与 tool 的 `inputSchema`
**完全不动**,LLM 侧零感知。

## 测试

- **Rust**:`cargo test`,临时目录造 fixture(含重复、不同 size、隐藏文件、空文件、扩展名过滤),
  断言分组与 `skipped` 计数。
- **TS**:vitest 加集成测试,对 fixture 目录调 `findDuplicates`,断言输出形状与关键字段,
  同时验证 `.node` 能被正确加载。
- **Benchmark(不进主代码)**:一次性脚本,对比临时 checkout 的旧 JS 实现 vs native,
  量化加速比,结果写进 PR 描述。

## 明确不做(YAGNI)

- 不做预编译二进制 / 多平台 CI 产物(阶段一只本地编译)。
- 不动 `directoryStats`(阶段二),但 `walker.rs` 已为它留好可复用接口。
- 不做运行时 JS 降级、不做 env 切换开关。
- 不碰 git-diff / 文档解析 / DB 层。

## 风险

- **打包验证是试水核心**:必须确认 `.node` 经 electron-builder 打包后在 production
  构建(非 dev)中能正确加载(asarUnpack)。这是阶段一最该跑通的一环。
- 团队成员 / CI 需安装 Rust toolchain,否则 `pnpm install` 在 postinstall 阶段失败。
  本阶段接受此约束(硬依赖)。

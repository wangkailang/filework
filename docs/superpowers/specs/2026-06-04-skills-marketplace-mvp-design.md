# Skills 市场 MVP 设计

> 状态:已确认设计,待写实现计划
> 日期:2026-06-04
> 范围:仅 Skills 市场。MCP 市场本轮明确不做。

## 背景

filework(Workspace Agent)已内置完整的 skills 运行时(`src/main/skills-runtime/`):
本地目录发现(`~/.agents/skills`、`<workspace>/.agents/skills`)、SKILL.md 解析、
资格检查、信任门控、执行。但**没有「从远端获取并安装 skill」的能力** —— 全部依赖
用户手动把 skill 目录放进上述路径。

本设计补上这条链路:一个轻量「市场」,让用户浏览精选 registry 并一键安装。

### 同类产品参考

- **Codex(OpenAI)**:skill 存于 `.agents/skills`(repo)、`$HOME/.agents/skills`(用户)
  等,与 filework 现有约定几乎一致;通过 `$skill-installer` 从 repo 拉取;marketplace 是
  「plugin 的 JSON 目录」。
- **Hermes(Nous Research)**:全部装进 `~/.hermes/skills/`;多源 Hub(builtin / official /
  community + `skills.sh` + `.well-known/skills/index.json` 约定 + 直连 GitHub repo +
  单文件 SKILL.md 直链);分级信任 + community 强制过安全扫描器。

结论:`~/.agents/skills` 是事实标准(Codex 完全一致),filework 现有约定无需改动;
registry schema 向 `.well-known/skills/index.json` 约定对齐以便将来扩展。

## 核心原则

**安装只负责把文件落到 `~/.agents/skills/<skillId>/`。** 之后的解析、资格检查、注册、
启用全部复用现有 skills-runtime,内核零改动。

```
registry.json (自托管 URL)
      │  fetch + 缓存
      ▼
 marketplace 模块 ── install ──► ~/.agents/skills/<skillId>/  (git 子目录 / 单文件 URL)
      │                                    │
      │ catalog 数据                        ▼ 触发重扫
      ▼                          现有 discovery → registry → 启用
 SkillsModal「市场」tab ◄── 已装状态合并 ──┘
```

## 设计决策(已确认)

| 维度 | 选择 |
|---|---|
| 数据源 | **自托管 `registry.json`**(放在某 URL / GitHub raw),手工/半自动维护精选清单 |
| 安装方式 | **git 子目录** + **单文件 SKILL.md 直链** 两种 source 类型,均装进 `~/.agents/skills/` |
| registry schema | 向 `.well-known/skills/index.json` 约定对齐 |
| 信任 | **安装时审批 + 持久化到 SQLite**;community 起始信任更低 |
| UI | **现有 `SkillsModal` 加「市场」tab** |

## 模块划分(主进程,新增于 `src/main/skills-runtime/marketplace/`)

| 单元 | 职责 | 依赖 |
|---|---|---|
| `registry-client.ts` | 拉 `registry.json` + 内存缓存(TTL)+ schema 校验,产出 `MarketEntry[]` | fetch |
| `installer.ts` | 按 entry 的 `source` 类型安装:`git`(`git clone --depth 1` → 拷 subdir)/ `url`(下载单文件 SKILL.md);写入 `~/.agents/skills/<skillId>/`;失败回滚(删半成品目录) | node:child_process, fs |
| `index.ts` | 编排:list / install / uninstall;装完调 `computeSkillHash` + 落信任记录 + 触发重扫 | 上两者 + 现有 security / registry |

### MarketEntry schema

向 `.well-known/skills/index.json` 约定靠拢:

```ts
interface MarketEntry {
  id: string;            // kebab-case,= 安装后的 skillId / 目录名
  name: string;
  description: string;
  version?: string;
  level: "official" | "community";
  source:
    | { type: "git"; repo: string; ref?: string; subdir?: string }
    | { type: "url"; url: string };  // 单文件 SKILL.md
  requires?: { bins?: string[]; env?: string[]; os?: string[]; pip?: string[] };
  homepage?: string;
}
```

`market:list` 返回时附加运行时字段 `installed: boolean`(对比 `~/.agents/skills` 下已有
skillId 得出)。

## 信任(持久化,对应「方案 B」)

- 新增 SQLite 表 `skill_trust`,把现有内存 `trustStore`(`security.ts`)落盘。列对应
  `SkillTrustRecord`:`skillId / sourcePath / contentHash / approved / approvedAt /
  permissions(allowCommands, allowHooks)`。`security.ts` 的信任读写改为走该表。
- **安装即审批**:点「安装」→ 弹确认框(复用现有 `SkillApprovalDialog` 思路)展示来源
  等级、含哪些 `!command` / hook / 依赖 → 用户确认 → 安装 → 计算 `contentHash`
  (复用现有 `computeSkillHash`)→ 写 `skill_trust(approved: true)`。
- `level: "community"` 的条目给更醒目的警示文案;`official` 弱化。
- 安装时计算并存 `contentHash`,作为**安装审批 / 溯源记录**(记录"用户在何时批准了来自何处、内容哈希为何的这次安装")。
- ⚠️ **MVP 范围修正**:`skill_trust` 在 MVP 中是**持久化的安装审批记录**,而非运行时门控。命令/hook 的实际放行仍走现有的**按来源等级**门控(`getTrustLevel`:personal=medium → `isCommandAllowed`)。把 `isSkillTrusted`(基于哈希的"改动即失信")接入全局命令门控会改变**所有** personal skill 的现有行为、有回归风险,故**留待 v2**。即:本 MVP 不提供"安装后 SKILL.md 被篡改即自动失信"的运行时强制。
- MVP **不做**自动扫描器(留 v2)。

## IPC + 数据流(新增 3 个通道,挂 `src/main/ipc/ai-handlers.ts`)

- `market:list` → registry-client 拉清单,合并本地已装状态,返回 `(MarketEntry & { installed })[]`
- `market:install` → installer + 信任落库 + 触发重扫(复用 `ai:refreshSkills` 链路),返回结果
- `market:uninstall` → 删 `~/.agents/skills/<skillId>/` + 删信任记录 + 重扫

preload 在 `window.filework` 暴露对应三个方法。重扫需让 `skillRegistry` 的刷新覆盖
`personal` 源(现有 `refreshProjectSkills` 仅刷 project)。

## UI(`SkillsModal` 加「市场」tab,对应「方案 A」)

- filter tabs 末尾加「市场」。切到该 tab 时数据源从 `market:list` 取(而非本地
  `listAllSkills`),复用现有 `SkillCard` 渲染。
- 卡片右侧开关位置:未装显示**安装按钮**,已装显示**已安装标记**。
- detail 视图复用,底部按状态显示「安装 / 卸载」;安装走确认弹窗。
- community 条目卡片加橙色「社区」徽标(复用现有 badge 样式)。
- i18n:新增 `skillsModal_market*` 系列文案键(项目已用 typesafe-i18n)。

## 测试

- `registry-client`:schema 校验、缓存 TTL、坏 JSON 容错。
- `installer`:git / url 两路径用临时目录 + 假 registry,验证落盘结构 + 失败回滚。
- 信任落库:install → 表中存在 approved 记录;改动 SKILL.md → 失信。
- 沿用现有 skills-runtime 测试风格(`__tests__/`,vitest)。

## 明确不做(YAGNI / 留 v2)

- MCP 市场(本轮砍掉)
- 安全扫描器(Hermes 式自动检测外泄 / 注入 / 破坏命令)
- 版本升级 / 更新检测(MVP 只装最新,卸了重装)
- 第三方 marketplace URL、`skills.sh` 等多源聚合(schema 已预留兼容)
- 评分 / 热度 / 远程统计

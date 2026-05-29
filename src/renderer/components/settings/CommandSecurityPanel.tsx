import { useEffect, useState } from "react";

/**
 * 命令执行安全设置面板。
 *
 * 两层模型(对齐 Codex / Claude Code):
 *  - 沙箱模式(sandboxMode):命令"技术上能做什么",OS 内核层强制。
 *  - 审批策略(approvalPolicy):"何时弹窗打断你",与沙箱解耦。
 *
 * 取值与主进程 `core/sandbox` 保持一致;经 settings:set 持久化到
 * SQLite settings 表(key=sandboxMode / approvalPolicy)。
 */

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
type ApprovalPolicy = "untrusted" | "on-request" | "on-failure" | "never";

const SANDBOX_OPTIONS: { value: SandboxMode; label: string; desc: string }[] = [
  {
    value: "workspace-write",
    label: "仅工作区可写(默认)",
    desc: "命令只能写当前工作区,默认禁止联网。需要联网/写出工作区时由模型申请提权并弹窗确认。",
  },
  {
    value: "read-only",
    label: "只读",
    desc: "命令不能写任何文件,也不能联网。最严格。",
  },
  {
    value: "danger-full-access",
    label: "完全放开(危险)",
    desc: "不启用沙箱,命令等同直接在你电脑上裸跑。仅在完全信任时使用。",
  },
];

const APPROVAL_OPTIONS: {
  value: ApprovalPolicy;
  label: string;
  desc: string;
}[] = [
  {
    value: "on-request",
    label: "按需(默认)",
    desc: "沙箱内的命令直接执行不打断;仅当命令申请提权(联网/写出工作区)时弹窗确认。",
  },
  {
    value: "untrusted",
    label: "每条都问",
    desc: "每条命令执行前都弹窗确认(等同旧行为)。",
  },
  {
    value: "on-failure",
    label: "失败时问",
    desc: "沙箱内的命令直接执行;失败后再询问是否无沙箱重跑。",
  },
  {
    value: "never",
    label: "从不询问",
    desc: "从不弹窗。仅依赖沙箱兜底,失败就失败。",
  },
];

const SELECT_CLS =
  "w-full px-2 py-1.5 text-sm rounded-md border border-border bg-background";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac/i.test(navigator.platform || navigator.userAgent || "");

export const CommandSecurityPanel = () => {
  const [sandboxMode, setSandboxMode] =
    useState<SandboxMode>("workspace-write");
  const [approvalPolicy, setApprovalPolicy] =
    useState<ApprovalPolicy>("on-request");

  useEffect(() => {
    void (async () => {
      const sandbox = await window.filework.getSetting("sandboxMode");
      const approval = await window.filework.getSetting("approvalPolicy");
      if (sandbox) setSandboxMode(sandbox as SandboxMode);
      if (approval) setApprovalPolicy(approval as ApprovalPolicy);
    })();
  }, []);

  const handleSandboxChange = async (value: SandboxMode) => {
    setSandboxMode(value);
    await window.filework.setSetting("sandboxMode", value);
  };

  const handleApprovalChange = async (value: ApprovalPolicy) => {
    setApprovalPolicy(value);
    await window.filework.setSetting("approvalPolicy", value);
  };

  const sandboxDesc = SANDBOX_OPTIONS.find(
    (o) => o.value === sandboxMode,
  )?.desc;
  const approvalDesc = APPROVAL_OPTIONS.find(
    (o) => o.value === approvalPolicy,
  )?.desc;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium text-foreground">命令执行安全</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          控制 Agent 执行 shell 命令时的 OS 沙箱强度,以及何时需要你确认。
        </p>
      </div>

      {!isMac && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
          当前平台暂不支持 OS 内核沙箱(仅 macOS 生效)。沙箱将回落为不生效,
          为安全起见命令会被强制逐条弹窗审批,审批策略设置在此平台不改变这一兜底。
        </div>
      )}

      {/* 沙箱模式 */}
      <div className="space-y-2">
        <label
          htmlFor="sandbox-mode"
          className="block text-sm font-medium text-foreground"
        >
          沙箱模式
        </label>
        <select
          id="sandbox-mode"
          value={sandboxMode}
          onChange={(e) => handleSandboxChange(e.target.value as SandboxMode)}
          className={SELECT_CLS}
        >
          {SANDBOX_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {sandboxDesc && (
          <p className="mt-1 text-xs text-muted-foreground">{sandboxDesc}</p>
        )}
      </div>

      {/* 审批策略 */}
      <div className="space-y-2">
        <label
          htmlFor="approval-policy"
          className="block text-sm font-medium text-foreground"
        >
          审批策略
        </label>
        <select
          id="approval-policy"
          value={approvalPolicy}
          onChange={(e) =>
            handleApprovalChange(e.target.value as ApprovalPolicy)
          }
          className={SELECT_CLS}
        >
          {APPROVAL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {approvalDesc && (
          <p className="mt-1 text-xs text-muted-foreground">{approvalDesc}</p>
        )}
      </div>
    </div>
  );
};

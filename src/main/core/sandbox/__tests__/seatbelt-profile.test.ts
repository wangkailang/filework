import { describe, expect, it } from "vitest";

import {
  getSandboxLauncher,
  isSandboxEffective,
  resolveApprovalPolicy,
  resolveSandboxConfig,
} from "../index";
import { buildSeatbeltProfile } from "../seatbelt-profile";
import type { SandboxPolicy } from "../types";

const wsRoot = "/private/tmp/filework-ws";

describe("buildSeatbeltProfile", () => {
  it("workspace-write 档放开 workspace 子路径且默认禁网", () => {
    const policy: SandboxPolicy = {
      mode: "workspace-write",
      writableRoots: [wsRoot],
      allowNetwork: false,
    };
    const profile = buildSeatbeltProfile(policy);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(subpath "${wsRoot}")`);
    expect(profile).toContain("(deny network*)");
  });

  it("read-only 档不放开 workspace 写权限", () => {
    const profile = buildSeatbeltProfile({
      mode: "read-only",
      writableRoots: [wsRoot],
      allowNetwork: false,
    });
    expect(profile).not.toContain(`(subpath "${wsRoot}")`);
    // 标准设备仍可写,否则常规命令跑不起来。
    expect(profile).toContain('(literal "/dev/null")');
  });

  it("allowNetwork 时不追加 network 拒绝", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: [wsRoot],
      allowNetwork: true,
    });
    expect(profile).not.toContain("(deny network*)");
  });

  it("路径中的引号被转义", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      writableRoots: ['/tmp/a"b'],
      allowNetwork: false,
    });
    expect(profile).toContain('(subpath "/tmp/a\\"b")');
  });
});

describe("getSandboxLauncher", () => {
  it("danger-full-access 走 passthrough(保持裸 shell)", () => {
    const launch = getSandboxLauncher({
      mode: "danger-full-access",
      writableRoots: [],
      allowNetwork: true,
    }).buildSpawn("echo hi", { cwd: wsRoot });
    expect(launch).toEqual({ file: "echo hi", args: [], shell: true });
  });

  it("darwin 上 workspace-write 走 sandbox-exec", () => {
    const launch = getSandboxLauncher({
      mode: "workspace-write",
      writableRoots: [wsRoot],
      allowNetwork: false,
    }).buildSpawn("echo hi", { cwd: wsRoot });
    if (process.platform === "darwin") {
      expect(launch.file).toBe("/usr/bin/sandbox-exec");
      expect(launch.args.slice(0, 1)).toEqual(["-p"]);
      expect(launch.args).toContain("echo hi");
      expect(launch.shell).toBe(false);
    } else {
      // 非 macOS 当前回落 passthrough。
      expect(launch).toEqual({ file: "echo hi", args: [], shell: true });
    }
  });
});

describe("resolveSandboxConfig", () => {
  it("缺省 → workspace-write 且禁网", () => {
    expect(resolveSandboxConfig(null)).toEqual({
      mode: "workspace-write",
      allowNetwork: false,
    });
  });
  it("danger-full-access → 放网", () => {
    expect(resolveSandboxConfig("danger-full-access")).toEqual({
      mode: "danger-full-access",
      allowNetwork: true,
    });
  });
  it("非法值回落默认", () => {
    expect(resolveSandboxConfig("bogus").mode).toBe("workspace-write");
  });
});

describe("resolveApprovalPolicy", () => {
  it("缺省 → on-request", () => {
    expect(resolveApprovalPolicy(null)).toBe("on-request");
  });
  it("透传合法值", () => {
    expect(resolveApprovalPolicy("untrusted")).toBe("untrusted");
    expect(resolveApprovalPolicy("never")).toBe("never");
  });
});

describe("isSandboxEffective", () => {
  it("danger-full-access 永不生效", () => {
    expect(isSandboxEffective("danger-full-access")).toBe(false);
  });
  it("workspace-write 仅 darwin 生效", () => {
    expect(isSandboxEffective("workspace-write")).toBe(
      process.platform === "darwin",
    );
  });
});

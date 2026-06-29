export type ChatPermissionMode = "request" | "auto" | "full";
export type ChatPermissionApprovalPolicy = "on-request" | "never";
export type ChatPermissionSandboxMode =
  | "workspace-write"
  | "danger-full-access";

export const DEFAULT_CHAT_PERMISSION_MODE: ChatPermissionMode = "request";

export const CHAT_PERMISSION_MODES = [
  "request",
  "auto",
  "full",
] as const satisfies readonly ChatPermissionMode[];

export const isChatPermissionMode = (
  value: unknown,
): value is ChatPermissionMode =>
  typeof value === "string" &&
  (CHAT_PERMISSION_MODES as readonly string[]).includes(value);

export const resolveChatPermissionMode = (
  value: unknown,
): ChatPermissionMode =>
  isChatPermissionMode(value) ? value : DEFAULT_CHAT_PERMISSION_MODE;

export interface ChatPermissionRunConfig {
  approvalPolicy: ChatPermissionApprovalPolicy;
  autoApprovePlans: boolean;
  sandboxMode: ChatPermissionSandboxMode;
}

export const resolveChatPermissionRunConfig = (
  mode: ChatPermissionMode,
): ChatPermissionRunConfig => {
  switch (mode) {
    case "auto":
      return {
        approvalPolicy: "never",
        autoApprovePlans: true,
        sandboxMode: "workspace-write",
      };
    case "full":
      return {
        approvalPolicy: "never",
        autoApprovePlans: true,
        sandboxMode: "danger-full-access",
      };
    case "request":
      return {
        approvalPolicy: "on-request",
        autoApprovePlans: false,
        sandboxMode: "workspace-write",
      };
  }
};

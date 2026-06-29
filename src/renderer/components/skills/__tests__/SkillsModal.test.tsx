import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialogHarness = vi.hoisted(() => ({
  onOpenChange: null as ((open: boolean) => void) | null,
}));

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    LL: new Proxy(
      {
        session_cancel: () => "Cancel",
        session_close: () => "Close",
        skillsModal_all: (count: string) => `All (${count})`,
        skillsModal_market: () => "Marketplace",
        skillsModal_marketCommunity: () => "Community",
        skillsModal_marketConfirmCommunity: () => "Community skill warning",
        skillsModal_marketConfirmInstallDescription: (name: string) =>
          `Install ${name}?`,
        skillsModal_marketConfirmInstallTitle: (name: string) =>
          `Confirm install ${name}`,
        skillsModal_marketConfirmUninstallDescription: (name: string) =>
          `Uninstall ${name}?`,
        skillsModal_marketConfirmUninstallTitle: (name: string) =>
          `Confirm uninstall ${name}`,
        skillsModal_marketEmpty: () => "No marketplace skills",
        skillsModal_marketError: () => "Marketplace error",
        skillsModal_marketInstall: () => "Install",
        skillsModal_marketInstalled: () => "Installed",
        skillsModal_marketInstalling: () => "Installing...",
        skillsModal_marketOfficial: () => "Official",
        skillsModal_marketUninstall: () => "Uninstall",
        skillsModal_marketUninstalling: () => "Uninstalling...",
        skillsModal_search: () => "Search skills...",
        skillsModal_sourceAdditional: () => "Additional",
        skillsModal_sourceBuiltIn: () => "Built-in",
        skillsModal_sourcePersonal: () => "Personal",
        skillsModal_sourceProject: () => "Project",
        skillsModal_title: () => "Skill Manager",
      },
      {
        get(target, prop: string) {
          return prop in target
            ? target[prop as keyof typeof target]
            : (...args: string[]) =>
                args.length > 0 ? `${prop}:${args.join(",")}` : prop;
        },
      },
    ),
  }),
}));

vi.mock("../../ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
    open,
  }: {
    children: React.ReactNode;
    onOpenChange?: (open: boolean) => void;
    open: boolean;
  }) => {
    dialogHarness.onOpenChange = onOpenChange ?? null;
    return open ? <div data-dialog="true">{children}</div> : null;
  },
  DialogContent: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div className={className} data-dialog-content="true">
      {children}
    </div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

vi.mock("../../ui/confirm-dialog", () => ({
  ConfirmDialog: ({
    busy,
    cancelLabel,
    confirmLabel,
    destructive,
    description,
    onConfirm,
    onOpenChange,
    open,
    title,
  }: {
    busy?: boolean;
    cancelLabel: string;
    confirmLabel: string;
    destructive?: boolean;
    description?: string;
    onConfirm: () => void | Promise<void>;
    onOpenChange: (open: boolean) => void;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <div data-confirm-dialog="true" data-destructive={destructive}>
        <h3>{title}</h3>
        {description && <p>{description}</p>}
        <button type="button" onClick={() => onOpenChange(false)}>
          {cancelLabel}
        </button>
        <button type="button" disabled={busy} onClick={() => void onConfirm()}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { SkillsModal } from "../SkillsModal";

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const clickByText = async (text: string, index = 0) => {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent?.trim() === text,
  );
  const button = buttons[index];
  if (!button) throw new Error(`Button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new Event("click", { bubbles: true }));
  });
};

const clickByLabel = async (label: string) => {
  const button = document.querySelector(
    `button[aria-label="${label}"]`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`Button not found by label: ${label}`);
  await act(async () => {
    button.dispatchEvent(new Event("click", { bubbles: true }));
  });
};

const renderedText = () =>
  document.getElementById("root")?.textContent?.trim() ?? "";

describe("SkillsModal marketplace confirmations", () => {
  let root: Root | null = null;
  let filework: {
    listAllSkills: ReturnType<typeof vi.fn>;
    marketInstall: ReturnType<typeof vi.fn>;
    marketList: ReturnType<typeof vi.fn>;
    marketUninstall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    dialogHarness.onOpenChange = null;
    const parsed = parseHTML('<div id="root"></div>');
    Object.assign(globalThis, {
      document: parsed.document,
      Event: parsed.window.Event,
      HTMLElement: parsed.window.HTMLElement,
      IS_REACT_ACT_ENVIRONMENT: true,
      Node: parsed.window.Node,
      window: parsed.window,
    });
    filework = {
      listAllSkills: vi.fn(() => Promise.resolve([])),
      marketInstall: vi.fn(() => Promise.resolve({ ok: true })),
      marketList: vi.fn(() =>
        Promise.resolve({
          ok: true,
          entries: [
            {
              id: "official-skill",
              name: "Official Skill",
              description: "Official description",
              level: "official",
              installed: false,
              source: {},
            },
            {
              id: "installed-skill",
              name: "Installed Skill",
              description: "Installed description",
              level: "community",
              installed: true,
              source: {},
            },
          ],
        }),
      ),
      marketUninstall: vi.fn(() => Promise.resolve({ ok: true })),
    };
    Object.assign(parsed.window, { filework });
    root = createRoot(parsed.document.getElementById("root") as HTMLElement);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    vi.restoreAllMocks();
  });

  const renderMarket = async (onClose = vi.fn()) => {
    await act(async () => {
      root?.render(<SkillsModal open onClose={onClose} />);
    });
    await flush();
    await clickByText("Marketplace");
    await flush();
    return { onClose };
  };

  it("requires confirmation before installing a marketplace skill", async () => {
    await renderMarket();

    await clickByText("Install");

    expect(filework.marketInstall).not.toHaveBeenCalled();
    expect(renderedText()).toContain("Confirm install Official Skill");

    await clickByText("Install", 1);
    await flush();

    expect(filework.marketInstall).toHaveBeenCalledTimes(1);
    expect(filework.marketInstall).toHaveBeenCalledWith(
      expect.objectContaining({ id: "official-skill" }),
    );
  });

  it("keeps the skill manager open while marketplace confirmation is open", async () => {
    const { onClose } = await renderMarket();

    await clickByText("Install");
    await act(async () => {
      dialogHarness.onOpenChange?.(false);
    });

    expect(onClose).not.toHaveBeenCalled();
    expect(renderedText()).toContain("Confirm install Official Skill");
  });

  it("only closes the skill manager from the close button", async () => {
    const { onClose } = await renderMarket();

    await act(async () => {
      dialogHarness.onOpenChange?.(false);
    });

    expect(onClose).not.toHaveBeenCalled();

    await clickByLabel("Close");

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before uninstalling a marketplace skill", async () => {
    await renderMarket();

    await clickByText("Uninstall");

    expect(filework.marketUninstall).not.toHaveBeenCalled();
    expect(renderedText()).toContain("Confirm uninstall Installed Skill");

    await clickByText("Uninstall", 1);
    await flush();

    expect(filework.marketUninstall).toHaveBeenCalledTimes(1);
    expect(filework.marketUninstall).toHaveBeenCalledWith("installed-skill");
  });
});

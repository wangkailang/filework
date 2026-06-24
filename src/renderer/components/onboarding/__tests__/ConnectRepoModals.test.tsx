import { parseHTML } from "linkedom";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ui/dialog", () => ({
  Dialog: ({ children, open }: { children: ReactElement; open?: boolean }) =>
    open ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactElement }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogTitle: ({ children }: { children: ReactElement }) => (
    <h2>{children}</h2>
  ),
}));

import { GitHubConnectModal } from "../GitHubConnectModal";
import {
  buildGitLabCredentialCreatePayload,
  GitLabConnectModal,
} from "../GitLabConnectModal";

type CredentialSummary = {
  id: string;
  kind: "github_pat" | "gitlab_pat";
  label: string;
  scopes: string[] | null;
  createdAt: string;
  lastTestedHost?: string | null;
};

type FileworkMock = {
  credentials: {
    list: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  github: {
    listRepos: ReturnType<typeof vi.fn>;
    listBranches: ReturnType<typeof vi.fn>;
  };
  gitlab: {
    listProjects: ReturnType<typeof vi.fn>;
    listBranches: ReturnType<typeof vi.fn>;
  };
};

const credential = (
  overrides: Partial<CredentialSummary> = {},
): CredentialSummary => ({
  id: "cred-1",
  kind: "github_pat",
  label: "GitHub work",
  scopes: null,
  createdAt: "2026-06-23T00:00:00.000Z",
  lastTestedHost: null,
  ...overrides,
});

const installDom = (filework: FileworkMock) => {
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );

  Object.assign(window, {
    filework,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    ResizeObserver: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });

  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("Node", window.Node);
  vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("HTMLInputElement", window.HTMLInputElement);
  vi.stubGlobal("Event", window.Event);
  vi.stubGlobal("MouseEvent", window.MouseEvent);
  vi.stubGlobal("navigator", window.navigator);
  vi.stubGlobal("requestAnimationFrame", window.requestAnimationFrame);
  vi.stubGlobal("cancelAnimationFrame", window.cancelAnimationFrame);
  vi.stubGlobal("ResizeObserver", window.ResizeObserver);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  return { document };
};

const makeFilework = (credentials: CredentialSummary[]): FileworkMock => ({
  credentials: {
    list: vi.fn(async () => credentials),
    create: vi.fn(async (payload) =>
      credential({
        id: "created-1",
        kind: payload.kind,
        label: payload.label,
        lastTestedHost: payload.host ?? null,
      }),
    ),
  },
  github: {
    listRepos: vi.fn(async () => []),
    listBranches: vi.fn(async () => []),
  },
  gitlab: {
    listProjects: vi.fn(async () => []),
    listBranches: vi.fn(async () => []),
  },
});

const flushEffects = async () => {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
};

const renderModal = async (element: ReactElement, filework: FileworkMock) => {
  const { document } = installDom(filework);
  const root = createRoot(document.getElementById("root") as HTMLElement);

  await act(async () => {
    root.render(element);
  });
  await flushEffects();

  return { document, root };
};

const clickButton = async (document: Document, text: string) => {
  const button = Array.from(document.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(text),
  );
  if (!button) throw new Error(`Missing button: ${text}`);

  await act(async () => {
    button.dispatchEvent(new window.Event("click", { bubbles: true }));
  });
  await flushEffects();
};

describe("Connect repo modals", () => {
  let root: Root | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("shows only GitHub credentials in the GitHub connect modal", async () => {
    const filework = makeFilework([
      credential({ id: "github-1", kind: "github_pat", label: "GitHub work" }),
      credential({ id: "gitlab-1", kind: "gitlab_pat", label: "GitLab work" }),
    ]);

    const rendered = await renderModal(
      <GitHubConnectModal onCancel={vi.fn()} onConfirm={vi.fn()} />,
      filework,
    );
    root = rendered.root;

    expect(rendered.document.body.textContent).toContain("GitHub work");
    expect(rendered.document.body.textContent).not.toContain("GitLab work");
  });

  it("restores the remembered GitLab host from saved credentials", async () => {
    const filework = makeFilework([
      credential({
        id: "gitlab-1",
        kind: "gitlab_pat",
        label: "Self-hosted GitLab",
        lastTestedHost: "gitlab.example.com",
      }),
    ]);

    const rendered = await renderModal(
      <GitLabConnectModal onCancel={vi.fn()} onConfirm={vi.fn()} />,
      filework,
    );
    root = rendered.root;

    const hostInput = rendered.document.querySelector(
      "#gl-host",
    ) as HTMLInputElement | null;
    expect(hostInput?.value).toBe("gitlab.example.com");
  });

  it("opens a GitHub add-token dialog instead of rendering the form inline", async () => {
    const filework = makeFilework([
      credential({ id: "github-1", kind: "github_pat", label: "GitHub work" }),
    ]);

    const rendered = await renderModal(
      <GitHubConnectModal onCancel={vi.fn()} onConfirm={vi.fn()} />,
      filework,
    );
    root = rendered.root;

    expect(rendered.document.querySelector("#cred-token")).toBeNull();

    await clickButton(rendered.document, "Add new token");

    expect(rendered.document.body.textContent).toContain("Add GitHub token");
    expect(rendered.document.querySelector("#cred-token")).not.toBeNull();
  });

  it("opens a GitLab add-token dialog instead of rendering the form inline", async () => {
    const filework = makeFilework([
      credential({ id: "gitlab-1", kind: "gitlab_pat", label: "GitLab work" }),
    ]);

    const rendered = await renderModal(
      <GitLabConnectModal onCancel={vi.fn()} onConfirm={vi.fn()} />,
      filework,
    );
    root = rendered.root;

    expect(rendered.document.querySelector("#gl-cred-token")).toBeNull();

    await clickButton(rendered.document, "Add new token");

    expect(rendered.document.body.textContent).toContain("Add GitLab token");
    expect(rendered.document.querySelector("#gl-cred-token")).not.toBeNull();
  });

  it("builds new GitLab token payloads with the entered host", () => {
    expect(
      buildGitLabCredentialCreatePayload({
        label: " Self-hosted ",
        token: " glpat-token ",
        host: " gitlab.example.com ",
      }),
    ).toEqual({
      kind: "gitlab_pat",
      label: "Self-hosted",
      token: "glpat-token",
      host: "gitlab.example.com",
    });
  });
});

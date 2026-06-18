import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../i18n/i18n-react", () => ({
  useI18nContext: () => ({
    locale: "zh-CN",
    LL: {
      credentials_addToken: () => "添加 Token",
      credentials_description: () => "本地加密保存凭据。",
      credentials_loading: () => "正在加载凭据...",
      credentials_title: () => "凭据",
    },
  }),
}));

import { CredentialsPanel } from "../CredentialsPanel";

describe("CredentialsPanel", () => {
  it("renders localized panel chrome", () => {
    const html = renderToStaticMarkup(<CredentialsPanel />);

    expect(html).toContain("凭据");
    expect(html).toContain("本地加密保存凭据。");
    expect(html).toContain("添加 Token");
    expect(html).toContain("正在加载凭据...");
    expect(html).not.toContain(">Credentials<");
    expect(html).not.toContain("Add token");
  });
});

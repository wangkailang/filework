import { describe, expect, it } from "vitest";
import en from "../en";
import ja from "../ja";
import zhCN from "../zh-CN";

const asRecord = (value: unknown) => value as Record<string, string>;

describe("credentials translations", () => {
  it("provides credentials settings labels for every locale", () => {
    const enMessages = asRecord(en);
    const zhMessages = asRecord(zhCN);
    const jaMessages = asRecord(ja);

    expect(enMessages.settings_credentials).toBe("Credentials");
    expect(enMessages.credentials_addToken).toBe("Add token");
    expect(enMessages.credentials_editTitle).toBe("Edit token");
    expect(enMessages.credentials_keepExistingToken).toBe(
      "Leave blank to keep existing token",
    );

    expect(zhMessages.settings_credentials).toBe("凭据");
    expect(zhMessages.credentials_addToken).toBe("添加 Token");
    expect(zhMessages.credentials_editTitle).toBe("编辑 Token");
    expect(zhMessages.credentials_keepExistingToken).toBe(
      "留空则保留当前 token",
    );

    expect(jaMessages.settings_credentials).toBe("認証情報");
    expect(jaMessages.credentials_addToken).toBe("トークンを追加");
    expect(jaMessages.credentials_editTitle).toBe("トークンを編集");
    expect(jaMessages.credentials_keepExistingToken).toBe(
      "空欄のままなら既存のトークンを保持",
    );
  });
});

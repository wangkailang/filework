import { describe, expect, it } from "vitest";
import en from "../en";
import ja from "../ja";
import zhCN from "../zh-CN";

const asRecord = (value: unknown) => value as Record<string, string>;

describe("MCP config translations", () => {
  it("provides MCP config labels for every locale", () => {
    const enMessages = asRecord(en);
    const zhMessages = asRecord(zhCN);
    const jaMessages = asRecord(ja);

    expect(enMessages.mcpConfig_title).toBe("MCP Servers");
    expect(enMessages.mcpConfig_add).toBe("Add Server");
    expect(enMessages.mcpConfig_importJson).toBe("Import JSON");
    expect(enMessages.mcpConfig_authAuto).toBe("Auto");
    expect(enMessages.mcpConfig_oauthAdvanced).toBe("Advanced OAuth fallback");
    expect(enMessages.mcpConfig_authErrorCode).toBe("code: {code:string}");

    expect(zhMessages.mcpConfig_title).toBe("MCP 服务器");
    expect(zhMessages.mcpConfig_add).toBe("添加服务器");
    expect(zhMessages.mcpConfig_importJson).toBe("导入 JSON");
    expect(zhMessages.mcpConfig_authAuto).toBe("自动");
    expect(zhMessages.mcpConfig_oauthAdvanced).toBe("高级 OAuth 兜底");
    expect(zhMessages.mcpConfig_authErrorCode).toBe("错误代码：{code}");

    expect(jaMessages.mcpConfig_title).toBe("MCP サーバー");
    expect(jaMessages.mcpConfig_add).toBe("サーバーを追加");
    expect(jaMessages.mcpConfig_importJson).toBe("JSON をインポート");
    expect(jaMessages.mcpConfig_authAuto).toBe("自動");
    expect(jaMessages.mcpConfig_oauthAdvanced).toBe(
      "高度な OAuth フォールバック",
    );
    expect(jaMessages.mcpConfig_authErrorCode).toBe("コード：{code}");
  });
});

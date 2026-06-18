import { describe, expect, it } from "vitest";
import en from "../en";
import ja from "../ja";
import zhCN from "../zh-CN";

const asRecord = (value: unknown) => value as Record<string, string>;

describe("automation translations", () => {
  it("provides automation settings labels for every locale", () => {
    const enMessages = asRecord(en);
    const zhMessages = asRecord(zhCN);
    const jaMessages = asRecord(ja);

    expect(enMessages.settings_automations).toBe("Automations");
    expect(enMessages.automations_add).toBe("New automation");
    expect(enMessages.automations_typeThread).toBe("Current thread");
    expect(enMessages.automations_trigger).toBe("Run now");
    expect(enMessages.automations_statusDisabled).toBe("Disabled");
    expect(enMessages.automations_deleteConfirmTitle).toBe(
      "Delete automation?",
    );

    expect(zhMessages.settings_automations).toBe("自动化");
    expect(zhMessages.automations_add).toBe("新建自动化");
    expect(zhMessages.automations_typeThread).toBe("当前对话");
    expect(zhMessages.automations_trigger).toBe("手动触发");
    expect(zhMessages.automations_statusDisabled).toBe("已停用");
    expect(zhMessages.automations_deleteConfirmTitle).toBe("删除自动化？");

    expect(jaMessages.settings_automations).toBe("自動化");
    expect(jaMessages.automations_add).toBe("自動化を作成");
    expect(jaMessages.automations_typeThread).toBe("現在のスレッド");
    expect(jaMessages.automations_trigger).toBe("今すぐ実行");
    expect(jaMessages.automations_statusDisabled).toBe("無効");
    expect(jaMessages.automations_deleteConfirmTitle).toBe(
      "自動化を削除しますか?",
    );
  });
});

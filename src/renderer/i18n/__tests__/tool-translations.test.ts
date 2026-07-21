import { describe, expect, it } from "vitest";
import en from "../en";
import ja from "../ja";
import zhCN from "../zh-CN";

const asRecord = (value: unknown) => value as Record<string, string>;

describe("tool translations", () => {
  it("provides the searchFiles tool name for every locale", () => {
    expect(asRecord(en).toolName_searchFiles).toBe("Search Files");
    expect(asRecord(zhCN).toolName_searchFiles).toBe("搜索文件");
    expect(asRecord(ja).toolName_searchFiles).toBe("ファイル検索");
  });

  it("provides the subagent result submission name for every locale", () => {
    expect(asRecord(en).toolName_submitSubagentResult).toBe("Submit Result");
    expect(asRecord(zhCN).toolName_submitSubagentResult).toBe("提交结果");
    expect(asRecord(ja).toolName_submitSubagentResult).toBe("結果を送信");
  });
});

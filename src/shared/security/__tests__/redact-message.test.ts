import { describe, expect, it } from "vitest";

import type { MessagePart } from "../../../main/core/session/message-parts";
import { redactMessageParts } from "../redact-message";

const KEY = "tp-sxnbvy8nfbqn8ocd7o974kbohq6s1hh3nmak6req8qeenm41";

describe("redactMessageParts", () => {
  it("掩码 text part,并计数", () => {
    const parts: MessagePart[] = [{ type: "text", text: `api key: ${KEY}` }];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(1);
    expect((r.parts[0] as { text: string }).text).not.toContain("sxnbvy8");
  });

  it("掩码 tool part 的 args 与 result", () => {
    const parts: MessagePart[] = [
      {
        type: "tool",
        toolCallId: "c1",
        toolName: "updateMemory",
        args: { text: `密钥：${KEY}` },
        result: { stored: `api key ${KEY}` },
        state: "output-available",
      },
    ];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(2);
    expect(JSON.stringify(r.parts[0])).not.toContain("sxnbvy8");
  });

  it("不改动 image part 的数据(避免损坏 base64)", () => {
    const longB64 = "A".repeat(64);
    const parts = [
      { type: "image", url: `data:image/png;base64,${longB64}` },
    ] as unknown as MessagePart[];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(0);
    expect(JSON.stringify(r.parts[0])).toContain(longB64);
  });

  it("无密钥时返回原数组语义且 count=0", () => {
    const parts: MessagePart[] = [{ type: "text", text: "普通文本" }];
    const r = redactMessageParts(parts);
    expect(r.count).toBe(0);
    expect((r.parts[0] as { text: string }).text).toBe("普通文本");
  });

  it("掩码 clarification part 的 question 字段", () => {
    const parts: MessagePart[] = [
      {
        type: "clarification",
        question: `请输入密钥: ${KEY}`,
        options: ["选项A"],
      },
    ];
    const r = redactMessageParts(parts);
    expect(r.count).toBeGreaterThan(0);
    expect(JSON.stringify(r.parts[0])).not.toContain("sxnbvy8");
  });

  it("掩码 batch-approval part 的 entries[].args 字段", () => {
    const parts: MessagePart[] = [
      {
        type: "batch-approval",
        batchId: "batch-1",
        toolName: "writeFile",
        entries: [
          {
            toolCallId: "tc-1",
            args: { content: `secret=${KEY}` },
            description: "写入文件",
          },
        ],
        state: "approval-requested",
      },
    ];
    const r = redactMessageParts(parts);
    expect(r.count).toBeGreaterThan(0);
    expect(JSON.stringify(r.parts[0])).not.toContain("sxnbvy8");
  });

  it("掩码 plan part 的 steps[].artifacts[].args 字段", () => {
    const parts: MessagePart[] = [
      {
        type: "plan",
        plan: {
          id: "plan-1",
          goal: "完成任务",
          status: "executing",
          steps: [
            {
              id: 1,
              action: "run",
              description: "执行步骤",
              status: "running",
              artifacts: [
                {
                  toolCallId: "tc-2",
                  toolName: "bash",
                  args: { command: `TOKEN=${KEY} make deploy` },
                  success: true,
                },
              ],
            },
          ],
        },
      },
    ];
    const r = redactMessageParts(parts);
    expect(r.count).toBeGreaterThan(0);
    expect(JSON.stringify(r.parts[0])).not.toContain("sxnbvy8");
  });
});

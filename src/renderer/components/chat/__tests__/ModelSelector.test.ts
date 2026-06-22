import { describe, expect, it } from "vitest";

import { getSelectableLlmConfigs } from "../ModelSelector";

describe("getSelectableLlmConfigs", () => {
  it("only keeps enabled LLM configs with successful connection checks", () => {
    expect(
      getSelectableLlmConfigs([
        {
          id: "enabled",
          name: "Enabled model",
          provider: "custom",
          model: "gpt-4o-mini",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "success",
        },
        {
          id: "disabled",
          name: "Disabled model",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: false,
          lastCheckStatus: "success",
        },
        {
          id: "connection-error",
          name: "Connection error",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: true,
          lastCheckStatus: "error",
        },
        {
          id: "untested",
          name: "Untested model",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: true,
          lastCheckStatus: null,
        },
      ]).map((config) => config.id),
    ).toEqual(["enabled"]);
  });
});

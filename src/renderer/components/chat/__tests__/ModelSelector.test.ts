import { describe, expect, it } from "vitest";

import { getSelectableLlmConfigs } from "../ModelSelector";

describe("getSelectableLlmConfigs", () => {
  it("filters disabled LLM configs out of the chat selector", () => {
    expect(
      getSelectableLlmConfigs([
        {
          id: "enabled",
          name: "Enabled model",
          provider: "custom",
          model: "gpt-4o-mini",
          modality: "chat",
          enabled: true,
        },
        {
          id: "disabled",
          name: "Disabled model",
          provider: "custom",
          model: "gpt-4o",
          modality: "chat",
          enabled: false,
        },
      ]).map((config) => config.id),
    ).toEqual(["enabled"]);
  });
});

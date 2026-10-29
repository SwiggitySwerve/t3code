import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveSubagentModelLabel, resolveSubagentMetadata } from "./subagentDisplay.ts";

const provider: Pick<ServerProvider, "driver" | "models"> = {
  driver: ProviderDriverKind.make("codex"),
  models: [
    {
      slug: "gpt-6.1-sol",
      name: "GPT-6.1 Sol",
      shortName: "Sol",
      aliases: ["openai.gpt-6.1-sol"],
      isCustom: false,
      capabilities: null,
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      aliases: ["anthropic/claude-sonnet-4-6"],
      isCustom: false,
      capabilities: null,
    },
    { slug: "local-model", name: "Private analyst", isCustom: true, capabilities: null },
  ],
};

describe("subagent registry model labels", () => {
  it.each([
    ["gpt-6.1-sol", "Sol"],
    [" OPENAI.GPT-6.1-SOL ", "Sol"],
    ["gpt-6.1 sol", "Sol"],
    ["anthropic/claude-sonnet-4-6", "Sonnet 4.6"],
    ["local-model", "Private analyst"],
    ["openai/gpt-6.1-sol", null],
    ["unknown/claude-sonnet-4-6", null],
    ["claude-opus-5-5", null],
    ["", null],
    [null, null],
  ])("resolves %s only from the selected provider's registry", (model, label) => {
    expect(resolveSubagentModelLabel({ model, provider })).toBe(label);
    expect(resolveSubagentModelLabel({ model, provider: { ...provider, models: [] } })).toBeNull();
    expect(resolveSubagentModelLabel({ model })).toBeNull();
  });

  it("preserves shared short-name and sub-provider display rules and legacy metadata fallback", () => {
    const scoped = {
      ...provider,
      models: [
        {
          slug: "openai/gpt-6.1-sol",
          name: "OpenAI / GPT-6.1 Sol",
          subProvider: "OpenAI",
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    expect(resolveSubagentModelLabel({ model: "openai/gpt-6.1-sol", provider: scoped })).toBe(
      "GPT-6.1 Sol",
    );
    expect(
      resolveSubagentModelLabel({
        model: "gpt-6.1-sol",
        provider: { ...provider, models: [{ ...provider.models[0]!, shortName: undefined }] },
      }),
    ).toBe("6.1 Sol");
    expect(resolveSubagentMetadata({ model: "gpt-6-luna", provider }).modelLabel).toBe(
      "GPT-6-Luna",
    );
    expect(resolveSubagentMetadata({ model: null, provider }).modelLabel).toBe("Not reported");
  });
});

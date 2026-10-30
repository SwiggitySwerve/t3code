import { getDisplayModelName } from "./providerIconUtils";
import { expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";
import { resolveWorkflowIdentity, workflowModelName } from "./workflowIdentity";
import { workflowModelGlyphFixture } from "../../../test/workflow-fixtures/workflowFixtures";
import { QA_PROVIDERS } from "../../../test/workflow-fixtures/providers";

it.each([
  [0, "glyph"],
  [8, "package"],
  [9, "generic"],
  [10, "driver"],
  [11, "driver"],
] as const)("resolves fixture identity %i without initials", (index, kind) => {
  const member = workflowModelGlyphFixture().group.graph!.waves.flat()[index]!.member!;
  const provider = QA_PROVIDERS.find((entry) => entry.instanceId === member.providerInstanceId);
  const identity = resolveWorkflowIdentity(member, provider);
  expect(identity.icon.kind).toBe(kind);
  if (!provider) expect(identity.providerName).toBe("Provider removed");
  expect(resolveWorkflowIdentity(member, provider, "queued").icon.kind).toBe("generic");
});

it("uses only an allowed ACP icon and falls back for a removed unknown driver", () => {
  const member = workflowModelGlyphFixture().group.graph!.waves[0]![0]!.member!;
  const provider = QA_PROVIDERS.find((entry) => entry.instanceId === "qa-acp")!;
  const unknown = { ...member, model: "custom-model", driver: provider.driver };
  expect(resolveWorkflowIdentity(unknown, provider).icon.kind).toBe("acp");
  expect(
    resolveWorkflowIdentity(unknown, { ...provider, iconUrl: "https://example.com/icon.svg" }).icon
      .kind,
  ).toBe("generic");
  expect(
    resolveWorkflowIdentity(
      { ...unknown, driver: ProviderDriverKind.make("deleted-driver") },
      undefined,
    ),
  ).toMatchObject({ providerName: "Provider removed", icon: { kind: "generic" } });
  expect(resolveWorkflowIdentity(null, provider).icon.kind).toBe("generic");
});

it("resolves changed model identity without retaining the earlier attempt", () => {
  const member = workflowModelGlyphFixture().group.graph!.waves[0]![0]!.member!;
  const provider = QA_PROVIDERS.find((entry) => entry.instanceId === member.providerInstanceId);
  expect(resolveWorkflowIdentity(member, provider).icon).toMatchObject({ family: "gpt-sol" });
  expect(resolveWorkflowIdentity({ ...member, model: "claude-haiku-5-5" }, provider)).toMatchObject(
    { modelName: "Claude Haiku 5.5", icon: { family: "claude-haiku" } },
  );
});

it("keeps stopped unspawned identity planned and replaces it only with known actual facts", () => {
  const member = workflowModelGlyphFixture().group.graph!.waves[0]![0]!.member!;
  const provider = QA_PROVIDERS.find((entry) => entry.instanceId === member.providerInstanceId)!;
  const plannedIdentity = { providerInstanceId: provider.instanceId, model: "claude-opus-5-5" };
  expect(
    resolveWorkflowIdentity(null, undefined, "queued", plannedIdentity, provider),
  ).toMatchObject({
    planned: true,
    modelName: "Claude Opus 5.5",
    icon: { family: "claude-opus" },
  });
  expect(
    resolveWorkflowIdentity(
      { ...member, childThreadId: null, startedAt: null },
      provider,
      "stopped",
      plannedIdentity,
      provider,
    ),
  ).toMatchObject({ planned: true });
  expect(
    resolveWorkflowIdentity(member, provider, "running", plannedIdentity, provider),
  ).toMatchObject({
    planned: false,
    modelName: "GPT-6.1 Sol",
    plannedDescription: "CLI Proxy · Claude Opus 5.5",
  });
  expect(
    resolveWorkflowIdentity(
      { ...member, model: null },
      provider,
      "running",
      plannedIdentity,
      provider,
    ).plannedDescription,
  ).toBeUndefined();
  expect(
    resolveWorkflowIdentity(member, provider, "running", { model: "openai/gpt-6.1-sol" })
      .plannedDescription,
  ).toBeUndefined();
});

it.each([
  ["openai.gpt-6.1-sol", "GPT-6.1 Sol", "cliproxy"],
  ["gpt-6-astra", "GPT-6 Astra", "cliproxy"],
  ["openai/gpt-6.1-terra", "GPT-6.1 Terra", "cursor-work"],
  ["gpt-6-luna", "GPT-6 Luna", "cursor-work"],
  ["claude-opus-5-5", "Claude Opus 5.5", "cliproxy"],
  ["anthropic/claude-sonnet-4-6", "Claude Sonnet 4.6", "cliproxy"],
  ["claude-fable-5-1", "Claude Fable 5.1", "cursor-work"],
  ["claude-haiku-5-5", "Claude Haiku 5.5", "cliproxy"],
  ["custom-model", "Research Model", "cliproxy"],
])("uses the model picker name for %s", (model, name, instanceId) => {
  const source = QA_PROVIDERS.find((entry) => entry.instanceId === instanceId)!;
  const provider = {
    ...source,
    models: [
      ...source.models,
      {
        slug: "custom-model",
        name: "Lab: Research Model",
        subProvider: "Lab",
        shortName: "Short",
        isCustom: true,
        capabilities: null,
      },
    ],
  };
  const member = workflowModelGlyphFixture().group.graph!.waves[0]![0]!.member!;
  const catalogModel = provider.models.find(
    (entry) => entry.slug === model || entry.aliases?.includes(model),
  )!;
  expect(getDisplayModelName(catalogModel)).toBe(name);
  expect(workflowModelName(model, provider)).toBe(name);
  expect(resolveWorkflowIdentity({ ...member, model }, provider)).toMatchObject({
    modelName: name,
    displayName: name,
    ...(model === "custom-model" ? { icon: { kind: "driver" } } : {}),
  });
});

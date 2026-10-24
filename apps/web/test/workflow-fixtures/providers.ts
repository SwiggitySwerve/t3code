/** The provider catalog the workflow fixtures share, as the app's provider atoms report it (see atoms.ts). */
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

export const QA_ENVIRONMENT = EnvironmentId.make("qa");
export const QA_PROVIDER_INSTANCE = ProviderInstanceId.make("cliproxy");
export const QA_DRIVER = ProviderDriverKind.make("codex");

/** The lane's worker provider, with the two models the QA profiles use. */
export const QA_PROVIDERS: ReadonlyArray<ServerProvider> = [
  {
    instanceId: QA_PROVIDER_INSTANCE,
    displayName: "CLI Proxy",
    driver: QA_DRIVER,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-24T12:00:00Z",
    models: [
      {
        slug: "claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "reasoningEffort",
              label: "Reasoning effort",
              type: "select",
              currentValue: "high",
              options: [
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
];

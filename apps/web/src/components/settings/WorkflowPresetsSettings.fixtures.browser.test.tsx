import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
  type WorkflowPreset,
} from "@t3tools/contracts";
import { describe, it, vi } from "vite-plus/test";

import "../../index.css";
import { WORKFLOW_QA_SETTINGS_STATES } from "@t3tools/shared/testing/workflowQa";
import { captureSurface } from "../../../test/workflow-fixtures/capture";
import { QA_ENVIRONMENT, QA_PROVIDERS } from "../../../test/workflow-fixtures/providers";

type SettingsVariant = (typeof WORKFLOW_QA_SETTINGS_STATES)[number];

const state = vi.hoisted(() => ({
  settings: undefined as UnifiedSettings | undefined,
  providers: [] as ServerProvider[],
  canWrite: true,
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => state.settings!) as never,
  useEnvironmentModelPreferences: () => ({ favorites: [], providerModelPreferences: {} }),
  useToggleEnvironmentModelFavorite: () => vi.fn(),
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map([[QA_ENVIRONMENT, state.providers]]),
  useEnvironments: () => ({
    environments: [],
    isReady: true,
    networkStatus: "online" as const,
    presentationById: new Map(),
  }),
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.canWrite,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => {
    throw new Error("Fixtures never save.");
  },
}));

import { WorkflowPresetsSettings } from "./WorkflowPresetsSettings";

const effort = (value: string) => [{ id: "reasoningEffort", value }];

function preset(id: string, name: string, model: string, provider = "cliproxy"): WorkflowPreset {
  return {
    id,
    name,
    target: {
      providerInstanceId: ProviderInstanceId.make(provider),
      model,
      options: effort("high"),
    },
  };
}

const PRESETS = [
  preset("worker", "QA worker (Haiku)", "claude-haiku-5-5"),
  preset("verifier", "QA verifier (Opus)", "claude-opus-5-5"),
];

function presets(variant: SettingsVariant): NonNullable<UnifiedSettings["workflowPresets"]> {
  switch (variant) {
    case "empty":
      return { presets: [], defaultPresetId: null };
    case "long-labels":
      return {
        presets: [
          preset(
            "long",
            `Verifier for every dependency, lockfile and workspace override ${"in the monorepo ".repeat(12)}日本語 🧪`,
            "claude-sonnet-5-5-20261001-extended-thinking-preview",
            "claude-proxy-with-a-very-long-provider-instance-name",
          ),
          ...PRESETS,
        ],
        defaultPresetId: "long",
      };
    case "missing-model":
      return {
        // One model the catalog no longer serves, and one provider instance that is gone.
        presets: [
          preset("retired", "Retired model", "claude-retired-9-9"),
          preset("ghost", "Provider removed", "claude-haiku-5-5", "removed-provider"),
          ...PRESETS,
        ],
        defaultPresetId: "retired",
      };
    case "many-profiles":
      return {
        presets: Array.from({ length: 24 }, (_, index) =>
          preset(
            `p${index}`,
            `Profile ${index + 1}`,
            index % 2 === 0 ? "claude-haiku-5-5" : "claude-opus-5-5",
          ),
        ),
        defaultPresetId: "p0",
      };
    default:
      return { presets: PRESETS, defaultPresetId: "worker" };
  }
}

function setup(variant: SettingsVariant) {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, workflowPresets: presets(variant) };
  state.canWrite = variant !== "read-only";
  state.providers = [...QA_PROVIDERS];
}

describe("agent profile settings", () => {
  it.each(WORKFLOW_QA_SETTINGS_STATES)("%s", async (variant) => {
    setup(variant);
    await captureSurface({
      surface: "settings-agents",
      state: variant,
      selector: "#workflow-presets",
      frame: "[data-qa-settings]",
      router: true,
      element: () => (
        <div className="min-h-40 bg-background text-foreground" data-qa-settings>
          <WorkflowPresetsSettings environmentId={QA_ENVIRONMENT} />
        </div>
      ),
    });
  });
});

import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerSettings,
  ServerSettingsPatch,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { mergeEnvironmentSettings } from "../../hooks/useSettings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeSettings = Schema.encodeSync(ServerSettings);

const state = vi.hoisted(() => ({
  settings: undefined as UnifiedSettings | undefined,
  providers: [] as ServerProvider[],
  listeners: new Set<() => void>(),
  canWrite: true,
  fail: false,
  throwTransportError: false,
  disk: "",
  requests: [] as { environmentId: EnvironmentId; input: { patch: ServerSettingsPatch } }[],
}));

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useEnvironmentSettings: (() =>
      useSyncExternalStore(
        (notify) => {
          state.listeners.add(notify);
          return () => state.listeners.delete(notify);
        },
        () => state.settings!,
      )) as typeof actual.useEnvironmentSettings,
    useEnvironmentModelPreferences: () => ({ favorites: [], providerModelPreferences: {} }),
    useToggleEnvironmentModelFavorite: () => vi.fn(),
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: () => new Map([[EnvironmentId.make("remote"), state.providers]]),
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
  useAtomCommand:
    () =>
    async (request: { environmentId: EnvironmentId; input: { patch: ServerSettingsPatch } }) => {
      state.requests.push(request);
      if (state.throwTransportError) throw new Error("Transport disconnected");
      if (state.fail) return AsyncResult.failure(Cause.fail(new Error("Save refused")));
      const patch = decodePatch(request.input.patch);
      const next = applyServerSettingsPatch(state.settings!, patch);
      state.disk = JSON.stringify(encodeSettings(next));
      state.settings = mergeEnvironmentSettings(
        decodeSettings(JSON.parse(state.disk)),
        DEFAULT_UNIFIED_SETTINGS,
      );
      for (const notify of state.listeners) notify();
      return AsyncResult.success(undefined);
    },
}));

import { WorkflowPresetsSettings } from "./WorkflowPresetsSettings";

function setup() {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    textGenerationModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
  };
  state.providers = [
    {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "test",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-10-23T00:00:00Z",
      models: [
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
        {
          slug: "gpt-5.4-mini",
          name: "GPT-5.4 mini",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning effort",
                type: "select",
                currentValue: "medium",
                options: [
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ];
  state.canWrite = true;
  state.fail = false;
  state.throwTransportError = false;
  state.disk = "";
  state.requests = [];
}

describe("workflow preset settings interactions", () => {
  it("C4 labels each default switch with its preset name and keeps a single default", async () => {
    setup();
    const target = { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    state.settings = {
      ...state.settings!,
      workflowPresets: {
        presets: [
          { id: "reviewer", name: "Reviewer", target },
          { id: "writer", name: "Writer", target },
        ],
        defaultPresetId: null,
      },
    };
    await using screen = await render(
      <WorkflowPresetsSettings environmentId={EnvironmentId.make("remote")} />,
    );
    const reviewer = screen.getByRole("switch", { name: "Workflow worker default: Reviewer" });
    const writer = screen.getByRole("switch", { name: "Workflow worker default: Writer" });
    await expect.element(reviewer).toHaveAccessibleName("Workflow worker default: Reviewer");
    await expect.element(writer).toHaveAccessibleName("Workflow worker default: Writer");
    await userEvent.click(reviewer);
    await expect.element(reviewer).toBeChecked();
    await expect.element(writer).not.toBeChecked();
    await userEvent.click(writer);
    await expect.element(writer).toBeChecked();
    await expect.element(reviewer).not.toBeChecked();
    expect(state.settings.workflowPresets.defaultPresetId).toBe("writer");
  });
  it("C4 creates, edits model and options, renames, toggles default and deletes through settings commands", async () => {
    setup();
    await using screen = await render(
      <WorkflowPresetsSettings environmentId={EnvironmentId.make("remote")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Create preset" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Preset name" }), "Reviewer");
    await userEvent.click(screen.getByRole("button", { name: "Preset model" }));
    await userEvent.click(page.getByRole("option", { name: /GPT-5.4 mini/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await expect.element(screen.getByRole("button", { name: "Edit Reviewer" })).toBeVisible();
    expect(state.settings!.workflowPresets.presets[0]?.target.model).toBe("gpt-5.4-mini");
    await userEvent.click(screen.getByRole("button", { name: "Edit Reviewer" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Preset name" }), "Writer");
    await userEvent.click(screen.getByRole("button", { name: /Medium/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /High/ }).first());
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await expect.element(screen.getByRole("button", { name: "Edit Writer" })).toBeVisible();
    expect(state.settings!.workflowPresets.presets[0]?.target.options).toContainEqual({
      id: "reasoningEffort",
      value: "high",
    });
    await userEvent.click(screen.getByRole("switch", { name: "Workflow worker default: Writer" }));
    await vi.waitFor(() =>
      expect(state.settings!.workflowPresets.defaultPresetId).toBe(
        state.settings!.workflowPresets.presets[0]!.id,
      ),
    );
    await screen.unmount();
    state.settings = mergeEnvironmentSettings(
      decodeSettings(JSON.parse(state.disk)),
      DEFAULT_UNIFIED_SETTINGS,
    );
    await using reopened = await render(
      <WorkflowPresetsSettings environmentId={EnvironmentId.make("remote")} />,
    );
    await expect
      .element(reopened.getByRole("switch", { name: "Workflow worker default: Writer" }))
      .toBeChecked();
    await userEvent.click(
      reopened.getByRole("switch", { name: "Workflow worker default: Writer" }),
    );
    await vi.waitFor(() => expect(state.settings!.workflowPresets.defaultPresetId).toBeNull());
    await userEvent.click(
      reopened.getByRole("switch", { name: "Workflow worker default: Writer" }),
    );
    await expect
      .element(reopened.getByRole("switch", { name: "Workflow worker default: Writer" }))
      .toBeChecked();
    await userEvent.click(reopened.getByRole("button", { name: "Delete Writer" }));
    await expect.element(reopened.getByText(/No agent presets yet./)).toBeVisible();
    expect(decodeSettings(JSON.parse(state.disk)).workflowPresets).toEqual({
      presets: [],
      defaultPresetId: null,
    });
    expect(state.requests.every((request) => request.environmentId === "remote")).toBe(true);
  });

  it("C4 disables writes without permission and retains an edit after a save failure", async () => {
    setup();
    state.canWrite = false;
    await using screen = await render(
      <WorkflowPresetsSettings environmentId={EnvironmentId.make("remote")} />,
    );
    await expect.element(screen.getByRole("button", { name: "Create preset" })).toBeDisabled();
    expect(state.requests).toHaveLength(0);
    state.canWrite = true;
    await screen.rerender(<WorkflowPresetsSettings environmentId={EnvironmentId.make("remote")} />);
    await userEvent.click(screen.getByRole("button", { name: "Create preset" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Preset name" }), "Unsaved");
    state.fail = true;
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Save refused");
    await expect
      .element(screen.getByRole("textbox", { name: "Preset name" }))
      .toHaveValue("Unsaved");
    expect(state.settings!.workflowPresets.presets).toHaveLength(0);
    await expect.element(screen.getByRole("button", { name: "Save preset" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    state.fail = false;
    state.throwTransportError = true;
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not save agent presets. Reconnect and try again.");
    await expect
      .element(screen.getByRole("textbox", { name: "Preset name" }))
      .toHaveValue("Unsaved");
    expect(state.settings!.workflowPresets.presets).toHaveLength(0);
    await expect.element(screen.getByRole("button", { name: "Save preset" })).toBeEnabled();
    await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();

    state.throwTransportError = false;
    await userEvent.click(screen.getByRole("button", { name: "Save preset" }));
    await expect.element(screen.getByRole("button", { name: "Edit Unsaved" })).toBeVisible();
    await expect
      .element(screen.getByRole("form", { name: "Agent preset" }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Create preset" })).toBeEnabled();
    expect(state.requests).toHaveLength(3);
  });
});

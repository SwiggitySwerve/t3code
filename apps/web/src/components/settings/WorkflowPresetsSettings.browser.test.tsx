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

const REMOTE = EnvironmentId.make("remote");
const TARGET = { providerInstanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

function setup() {
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    workflows: true,
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

describe("agent role settings interactions", () => {
  it("keeps roles inactive until workflows are enabled and persists both toggle directions", async () => {
    setup();
    state.settings = { ...state.settings!, workflows: false };
    await using screen = await render(<WorkflowPresetsSettings environmentId={REMOTE} />);
    await expect.element(screen.getByRole("button", { name: "Add role" })).toBeDisabled();
    await userEvent.click(screen.getByRole("switch", { name: "Enable workflows" }));
    expect(decodeSettings(JSON.parse(state.disk)).workflows).toBe(true);
    await expect.element(screen.getByRole("button", { name: "Add role" })).toBeEnabled();
    await userEvent.click(screen.getByRole("switch", { name: "Enable workflows" }));
    expect(decodeSettings(JSON.parse(state.disk)).workflows).toBe(false);
    await expect.element(screen.getByRole("button", { name: "Add role" })).toBeDisabled();
  });

  it("labels each default switch with its role name and keeps a single default", async () => {
    setup();
    state.settings = {
      ...state.settings!,
      workflowPresets: {
        presets: [
          { id: "reviewer", name: "Reviewer", target: TARGET },
          { id: "writer", name: "Writer", target: TARGET },
        ],
        defaultPresetId: null,
      },
    };
    await using screen = await render(<WorkflowPresetsSettings environmentId={REMOTE} />);
    const reviewer = screen.getByRole("switch", { name: "Default role: Reviewer" });
    const writer = screen.getByRole("switch", { name: "Default role: Writer" });
    await userEvent.click(reviewer);
    await expect.element(reviewer).toBeChecked();
    await expect.element(writer).not.toBeChecked();
    await userEvent.click(writer);
    await expect.element(writer).toBeChecked();
    await expect.element(reviewer).not.toBeChecked();
    expect(state.settings.workflowPresets.defaultPresetId).toBe("writer");
  });

  it("draws Delete in the destructive red, not in the neutral grey of a plain ghost button", async () => {
    setup();
    await using screen = await render(<WorkflowPresetsSettings environmentId={REMOTE} />);
    state.settings = {
      ...state.settings!,
      workflowPresets: {
        presets: [{ id: "r", name: "Reviewer", target: TARGET }],
        defaultPresetId: null,
      },
    };
    await screen.rerender(<WorkflowPresetsSettings environmentId={REMOTE} />);
    const color = getComputedStyle(
      screen.getByRole("button", { name: "Delete Reviewer" }).element(),
    ).color;
    // Computed colours may be oklab or rgb; render the colour to a canvas pixel to read its channels.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    expect(red!).toBeGreaterThan(green! + 60);
    expect(red!).toBeGreaterThan(blue! + 60);
  });

  it("adds, edits model and effort, renames, toggles default and deletes in place", async () => {
    setup();
    await using screen = await render(<WorkflowPresetsSettings environmentId={REMOTE} />);
    await userEvent.click(screen.getByRole("button", { name: "Add role" }));
    // A new role starts on the app's model, and its name is ready to type.
    const added = screen.getByRole("textbox", { name: "Role name: New role" });
    await expect.element(added).toHaveFocus();
    expect(state.settings!.workflowPresets.presets[0]?.target.model).toBe("gpt-5.4");
    await userEvent.fill(added, "Reviewer");
    await userEvent.keyboard("{Enter}");
    const name = screen.getByRole("textbox", { name: "Role name: Reviewer" });
    await expect.element(name).toHaveValue("Reviewer");
    expect(screen.container.querySelector("form")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Model for Reviewer" }));
    await userEvent.click(page.getByRole("option", { name: /GPT-5.4 mini/ }));
    await vi.waitFor(() =>
      expect(state.settings!.workflowPresets.presets[0]?.target.model).toBe("gpt-5.4-mini"),
    );
    await userEvent.click(screen.getByRole("button", { name: /Medium/ }));
    await userEvent.click(page.getByRole("menuitemradio", { name: /High/ }).first());
    await vi.waitFor(() =>
      expect(state.settings!.workflowPresets.presets[0]?.target.options).toContainEqual({
        id: "reasoningEffort",
        value: "high",
      }),
    );

    // Escape drops an unsaved rename; an empty name keeps the stored one.
    await userEvent.fill(name, "Draft");
    await userEvent.keyboard("{Escape}");
    await expect.element(name).toHaveValue("Reviewer");
    await userEvent.fill(name, "   ");
    await userEvent.keyboard("{Enter}");
    await expect.element(name).toHaveValue("Reviewer");
    expect(state.settings!.workflowPresets.presets[0]?.name).toBe("Reviewer");

    await userEvent.click(screen.getByRole("switch", { name: "Default role: Reviewer" }));
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
    await using reopened = await render(<WorkflowPresetsSettings environmentId={REMOTE} />);
    await expect
      .element(reopened.getByRole("switch", { name: "Default role: Reviewer" }))
      .toBeChecked();
    await userEvent.click(reopened.getByRole("button", { name: "Delete Reviewer" }));
    await expect.element(reopened.getByText(/No roles yet./)).toBeVisible();
    expect(decodeSettings(JSON.parse(state.disk)).workflowPresets).toEqual({
      presets: [],
      defaultPresetId: null,
    });
    expect(state.requests.every((request) => request.environmentId === "remote")).toBe(true);
  });

  it("disables writes without permission and keeps a rename after a save failure", async () => {
    setup();
    state.settings = {
      ...state.settings!,
      workflowPresets: {
        presets: [{ id: "w", name: "Writer", target: TARGET }],
        defaultPresetId: null,
      },
    };
    state.canWrite = false;
    await using screen = await render(<WorkflowPresetsSettings environmentId={REMOTE} />);
    await expect.element(screen.getByRole("button", { name: "Add role" })).toBeDisabled();
    await expect.element(screen.getByRole("textbox", { name: "Role name: Writer" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Delete Writer" })).toBeDisabled();
    expect(state.requests).toHaveLength(0);

    state.canWrite = true;
    await screen.rerender(<WorkflowPresetsSettings environmentId={REMOTE} />);
    const name = screen.getByRole("textbox", { name: "Role name: Writer" });
    state.fail = true;
    await userEvent.fill(name, "Unsaved");
    await userEvent.keyboard("{Enter}");
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Save refused");
    await expect.element(name).toHaveValue("Unsaved");
    expect(state.settings!.workflowPresets.presets[0]?.name).toBe("Writer");

    state.fail = false;
    state.throwTransportError = true;
    await userEvent.click(screen.getByRole("button", { name: "Add role" }));
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Could not save agent roles. Reconnect and try again.");
    expect(state.settings!.workflowPresets.presets).toHaveLength(1);
    await expect.element(name).toHaveValue("Unsaved");

    state.throwTransportError = false;
    await userEvent.click(name);
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Role name: Unsaved" }))
      .toHaveValue("Unsaved");
    await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
    expect(state.requests).toHaveLength(3);
  });
});

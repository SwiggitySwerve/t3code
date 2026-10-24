import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import { describe, expect, it } from "vite-plus/test";
import { resolveServerBackgroundActivitySettings } from "./backgroundActivitySettings.ts";
import { createModelSelection } from "./model.ts";
import { resolveProjectScripts, projectScriptsInheritDefaults } from "./projectScripts.ts";
import {
  applyServerSettingsPatch,
  fallbackTextGenerationModelSelection,
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
  isModelSelectionProviderEnabled,
  parsePersistedServerObservabilitySettings,
  resolveSourceControlWriterModelSelection,
  resolveProjectAgentBrowserAccess,
  resolveProjectAutoPull,
  serverSettingsWriteProblems,
  WORKFLOW_PRESET_NAME_MAX_CHARS,
  workflowPresetsWriteProblems,
} from "./serverSettings.ts";

const FOLDED_SERVER_SETTINGS = { ...DEFAULT_SERVER_SETTINGS, projectSettingsFolded: true };

describe("workflow preset patches", () => {
  it("C4 creates, renames, replaces targets, clears default and deletes without deep merging", () => {
    const first = {
      id: "worker",
      name: "Worker",
      target: {
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    };
    const created = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      workflowPresets: { presets: [first], defaultPresetId: first.id },
    });
    expect(created.workflowPresets).toEqual({ presets: [first], defaultPresetId: first.id });
    const edited = {
      ...first,
      name: "Renamed",
      target: {
        providerInstanceId: ProviderInstanceId.make("claude"),
        model: "sonnet",
        options: [],
      },
    };
    const updated = applyServerSettingsPatch(created, {
      workflowPresets: { presets: [edited], defaultPresetId: null },
    });
    expect(updated.workflowPresets).toEqual({ presets: [edited], defaultPresetId: null });
    const deleted = applyServerSettingsPatch(updated, {
      workflowPresets: { presets: [], defaultPresetId: null },
    });
    expect(deleted.workflowPresets).toEqual(DEFAULT_SERVER_SETTINGS.workflowPresets);
    expect(
      applyServerSettingsPatch(created, { threadTitleInstructions: "title" }).workflowPresets,
    ).toEqual(created.workflowPresets);
    expect(created.workflowPresets.presets[0]).toEqual(first);
  });
});

describe("workflow trigger patches", () => {
  it("merges the switch and the extras separately and replaces the extras whole", () => {
    const withExtras = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      workflowTriggers: { extras: ["fan out", "orchestrate"] },
    });
    expect(withExtras.workflowTriggers).toEqual({
      enabled: true,
      extras: ["fan out", "orchestrate"],
    });
    const off = applyServerSettingsPatch(withExtras, { workflowTriggers: { enabled: false } });
    expect(off.workflowTriggers).toEqual({ enabled: false, extras: ["fan out", "orchestrate"] });
    const fewer = applyServerSettingsPatch(off, { workflowTriggers: { extras: ["orchestrate"] } });
    expect(fewer.workflowTriggers).toEqual({ enabled: false, extras: ["orchestrate"] });
    expect(
      applyServerSettingsPatch(fewer, { threadTitleInstructions: "title" }).workflowTriggers,
    ).toEqual(fewer.workflowTriggers);
  });
});

describe("workflow profile fallbacks and a writer that predates them", () => {
  const codex = ProviderInstanceId.make("codex");
  const primary = { providerInstanceId: codex, model: "gpt-5.4" };
  const backup = { providerInstanceId: codex, model: "gpt-5.5" };
  const stored = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    workflowPresets: {
      presets: [
        { id: "worker", name: "Worker", target: primary, fallbacks: [backup] },
        { id: "other", name: "Other", target: primary, fallbacks: [backup, primary] },
      ],
      defaultPresetId: "worker",
    },
  });
  // What an older client sends: every stored preset without the key it never decoded.
  const olderWriter = (
    edit: (preset: { id: string; name: string; target: typeof primary }) => unknown,
    defaultPresetId: string | null = "worker",
  ) => ({
    workflowPresets: {
      presets: stored.workflowPresets.presets.flatMap((preset) => {
        const edited = edit({ id: preset.id, name: preset.name, target: preset.target });
        return edited === null ? [] : [edited as typeof preset];
      }),
      defaultPresetId,
    },
  });

  it("keeps the stored fallbacks on rename, retarget and default change", () => {
    const renamed = applyServerSettingsPatch(
      stored,
      olderWriter((preset) => (preset.id === "worker" ? { ...preset, name: "Renamed" } : preset)),
    );
    expect(
      renamed.workflowPresets.presets.map((preset) => [preset.name, preset.fallbacks]),
    ).toEqual([
      ["Renamed", [backup]],
      ["Other", [backup, primary]],
    ]);
    const retargeted = applyServerSettingsPatch(
      stored,
      olderWriter((preset) => ({ ...preset, target: backup })),
    );
    expect(retargeted.workflowPresets.presets.map((preset) => preset.fallbacks)).toEqual([
      [backup],
      [backup, primary],
    ]);
    const defaultChanged = applyServerSettingsPatch(
      stored,
      olderWriter((preset) => preset, "other"),
    );
    expect(defaultChanged.workflowPresets.defaultPresetId).toBe("other");
    expect(defaultChanged.workflowPresets.presets).toEqual(stored.workflowPresets.presets);
  });

  it("keeps the other profile's fallbacks when one profile is deleted, and drops the deleted one", () => {
    const deleted = applyServerSettingsPatch(
      stored,
      olderWriter((preset) => (preset.id === "worker" ? null : preset), null),
    );
    expect(deleted.workflowPresets.presets).toEqual([
      { id: "other", name: "Other", target: primary, fallbacks: [backup, primary] },
    ]);
    // A preset deleted and later created again under the same id starts with no fallbacks.
    const recreated = applyServerSettingsPatch(deleted, {
      workflowPresets: {
        presets: [
          ...deleted.workflowPresets.presets,
          { id: "worker", name: "Worker", target: primary },
        ],
        defaultPresetId: null,
      },
    });
    expect("fallbacks" in recreated.workflowPresets.presets[1]!).toBe(false);
  });

  it("clears the list only for an explicit empty array, and a new profile inherits nothing", () => {
    const cleared = applyServerSettingsPatch(stored, {
      workflowPresets: {
        presets: [
          { id: "worker", name: "Worker", target: primary, fallbacks: [] },
          { id: "other", name: "Other", target: primary, fallbacks: [primary] },
          { id: "fresh", name: "Fresh", target: primary },
        ],
        defaultPresetId: null,
      },
    });
    expect(cleared.workflowPresets.presets.map((preset) => preset.fallbacks)).toEqual([
      [],
      [primary],
      undefined,
    ]);
    expect("fallbacks" in cleared.workflowPresets.presets[2]!).toBe(false);
  });

  it("leaves the fallbacks alone when the patch does not touch the profiles", () => {
    expect(
      applyServerSettingsPatch(stored, { workflowTriggers: { enabled: false } }).workflowPresets,
    ).toEqual(stored.workflowPresets);
  });
});

describe("settings write rules", () => {
  const target = {
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };
  const preset = (id: string, name: string) => ({ id, name, target });
  const presets = (...list: ReadonlyArray<ReturnType<typeof preset>>) => ({
    presets: list,
    defaultPresetId: null,
  });

  it("accepts distinct names up to the limit and an empty list", () => {
    expect(workflowPresetsWriteProblems(presets())).toEqual([]);
    expect(
      workflowPresetsWriteProblems(
        presets(preset("a", "x".repeat(WORKFLOW_PRESET_NAME_MAX_CHARS)), preset("b", "Other")),
      ),
    ).toEqual([]);
  });

  it("refuses a new name that is too long or already taken, ignoring case", () => {
    const tooLong = workflowPresetsWriteProblems(
      presets(preset("a", "x".repeat(WORKFLOW_PRESET_NAME_MAX_CHARS + 1))),
    );
    expect(tooLong).toMatchObject([{ presetId: "a", kind: "name_too_long" }]);
    const taken = workflowPresetsWriteProblems(
      presets(preset("a", "Worker"), preset("b", "worker")),
    );
    expect(taken.map((problem) => [problem.presetId, problem.kind])).toEqual([
      ["a", "name_duplicate"],
      ["b", "name_duplicate"],
    ]);
  });

  it("does not hold presets saved before these rules against an unrelated edit", () => {
    const legacy = presets(preset("a", "Same"), preset("b", "Same"), preset("c", "N".repeat(400)));
    expect(workflowPresetsWriteProblems(legacy, legacy)).toEqual([]);
    const renamed = presets(preset("a", "Same"), preset("b", "Same"), preset("c", "Short"));
    expect(workflowPresetsWriteProblems(renamed, legacy)).toEqual([]);
    const added = presets(...legacy.presets, preset("d", "same"));
    expect(workflowPresetsWriteProblems(added, legacy)).toMatchObject([
      { presetId: "d", kind: "name_duplicate" },
    ]);
    const lengthened = presets(
      preset("a", "Same"),
      preset("b", "x".repeat(401)),
      preset("c", "N".repeat(400)),
    );
    expect(workflowPresetsWriteProblems(lengthened, legacy)).toMatchObject([
      { presetId: "b", kind: "name_too_long" },
    ]);
  });

  it("checks trigger extras only when the write changes them", () => {
    const handEdited = {
      ...DEFAULT_SERVER_SETTINGS,
      workflowTriggers: { enabled: true, extras: ["fan out", "Fan Out", "workflow"] },
    };
    // An invalid list that is already stored does not block an unrelated write or a re-save.
    expect(serverSettingsWriteProblems(handEdited, { ...handEdited, ultracode: "off" })).toEqual(
      [],
    );
    expect(serverSettingsWriteProblems(handEdited, handEdited)).toEqual([]);
    // Changing the list checks the whole new list.
    expect(
      serverSettingsWriteProblems(handEdited, {
        ...handEdited,
        workflowTriggers: { enabled: true, extras: ["fan out", "Fan Out"] },
      }),
    ).toHaveLength(1);
    expect(serverSettingsWriteProblems(DEFAULT_SERVER_SETTINGS, handEdited)).toHaveLength(2);
  });

  it("reports preset and trigger problems together for a whole settings write", () => {
    const next = {
      ...DEFAULT_SERVER_SETTINGS,
      workflowPresets: presets(preset("a", "Same"), preset("b", "same")),
      workflowTriggers: { enabled: true, extras: ["fan out", "Fan Out", "workflow"] },
    };
    expect(serverSettingsWriteProblems(DEFAULT_SERVER_SETTINGS, next)).toHaveLength(4);
    expect(serverSettingsWriteProblems(DEFAULT_SERVER_SETTINGS, DEFAULT_SERVER_SETTINGS)).toEqual(
      [],
    );
  });
});

describe("fallbackTextGenerationModelSelection", () => {
  it("ignores a configured non-default instance at machine scope, matching no fallback", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(providerInstances, (instanceId) =>
      instanceId === configured ? true : false,
    );
    expect(fallback).toBeNull();
  });

  it("considers a configured non-default instance only when asked to", () => {
    const configured = ProviderInstanceId.make("codex_work");
    const providerInstances = {
      [configured]: { driver: ProviderDriverKind.make("codex"), config: {} },
    };
    const fallback = fallbackTextGenerationModelSelection(
      providerInstances,
      (instanceId) => instanceId === configured,
      { includeConfiguredInstances: true },
    );
    expect(fallback?.instanceId).toBe(configured);
  });
});

describe("serverSettings helpers", () => {
  it("translates a shipped client's idle compaction switch into a mode", () => {
    const off = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { idleCompaction: "off" });
    expect([off.idleCompaction, off.compactIdleThreads]).toEqual(["off", false]);
    // Turning the old switch off keeps "Never" instead of reverting to the default.
    const stillOff = applyServerSettingsPatch(off, { compactIdleThreads: false });
    expect(stillOff.idleCompaction).toBe("off");
    const on = applyServerSettingsPatch(off, { compactIdleThreads: true });
    expect([on.idleCompaction, on.compactIdleThreads]).toEqual(["beforeCacheExpires", true]);
  });

  it("changes a cleanup rule without replacing the machine's other rules", () => {
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      storageCleanup: { worktreeAfterDays: 8, worktreeOnMerge: true, logsAfterDays: 30 },
    });
    expect(
      applyServerSettingsPatch(enabled, {
        storageCleanup: { worktreeAfterDays: null },
      }).storageCleanup,
    ).toEqual({
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: true,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      worktreeKeepWhen: "uncommitted-changes",
      browserArtifactsAfterDays: null,
      logsAfterDays: 30,
    });
  });
  it("replaces a source control host's patched field so a cleared account pin does not survive", () => {
    const pinned = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: {
        github: { hosts: { "github.com": { account: "work", enabled: true } }, tokens: {} },
      },
    });
    const unpinned = applyServerSettingsPatch(pinned, {
      sourceControlHosts: { github: { hosts: { "github.com": { enabled: false } } } },
    });
    expect(unpinned.sourceControlHosts.github).toEqual({
      hosts: { "github.com": { enabled: false } },
      tokens: {},
    });
  });

  it("inherits actions, preserves existing actions, and supports empty overrides and reset", () => {
    const project = { id: ProjectId.make("project-actions"), scripts: [] };
    const action = {
      id: "check",
      name: "Check",
      command: "npm test",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const existing = { ...project, scripts: [{ ...action, command: "npm run lint" }] };
    const unfolded = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultProjectScripts: [action],
    });
    expect(resolveProjectScripts(unfolded, existing)).toEqual(existing.scripts);
    expect(projectScriptsInheritDefaults(unfolded, existing)).toBe(false);
    const defaults = applyServerSettingsPatch(FOLDED_SERVER_SETTINGS, {
      defaultProjectScripts: [action],
    });
    expect(resolveProjectScripts(defaults, project)).toEqual([action]);
    expect(projectScriptsInheritDefaults(defaults, project)).toBe(true);
    expect(resolveProjectScripts(defaults, existing)).toEqual([action]);
    const disabled = applyServerSettingsPatch(defaults, {
      projectScriptOverrides: { [project.id]: [] },
    });
    expect(resolveProjectScripts(disabled, project)).toEqual([]);
    expect(projectScriptsInheritDefaults(disabled, project)).toBe(false);
    const changedDefault = applyServerSettingsPatch(disabled, {
      defaultProjectScripts: [{ ...action, command: "npm run build" }],
    });
    expect(resolveProjectScripts(changedDefault, project)).toEqual([]);
    const reset = applyServerSettingsPatch(changedDefault, {
      projectScriptOverrides: { [project.id]: null },
    });
    expect(resolveProjectScripts(reset, existing)).toEqual(changedDefault.defaultProjectScripts);
    expect(projectScriptsInheritDefaults(reset, existing)).toBe(true);
    expect(
      resolveProjectScripts(
        applyServerSettingsPatch(reset, { defaultProjectScripts: [] }),
        existing,
      ),
    ).toEqual([]);
  });

  it("preserves other projects' actions when overriding, clearing, or resetting one project", () => {
    const firstProject = { id: ProjectId.make("first-project"), scripts: [] };
    const secondProject = { id: ProjectId.make("second-project"), scripts: [] };
    const defaultAction = {
      id: "check",
      name: "Check",
      command: "npm test",
      icon: "play" as const,
      runOnWorktreeCreate: false,
    };
    const firstAction = { ...defaultAction, command: "npm run lint" };
    const secondAction = { ...defaultAction, command: "npm run build" };
    const firstUpdate = applyServerSettingsPatch(FOLDED_SERVER_SETTINGS, {
      defaultProjectScripts: [defaultAction],
      projectScriptOverrides: { [firstProject.id]: [firstAction] },
    });
    const secondUpdate = applyServerSettingsPatch(firstUpdate, {
      projectScriptOverrides: { [secondProject.id]: [secondAction] },
    });
    expect(resolveProjectScripts(secondUpdate, firstProject)).toEqual([firstAction]);
    expect(resolveProjectScripts(secondUpdate, secondProject)).toEqual([secondAction]);

    const cleared = applyServerSettingsPatch(secondUpdate, {
      projectScriptOverrides: { [firstProject.id]: [] },
    });
    expect(resolveProjectScripts(cleared, firstProject)).toEqual([]);
    expect(resolveProjectScripts(cleared, secondProject)).toEqual([secondAction]);

    const reset = applyServerSettingsPatch(cleared, {
      projectScriptOverrides: { [firstProject.id]: null },
    });
    expect(resolveProjectScripts(reset, { ...firstProject, scripts: [firstAction] })).toEqual([
      defaultAction,
    ]);
    expect(resolveProjectScripts(reset, secondProject)).toEqual([secondAction]);
    expect(resolveProjectScripts(secondUpdate, firstProject)).toEqual([firstAction]);
  });

  it("inherits automatic pull while preserving legacy opt-ins and explicit overrides", () => {
    const projectId = ProjectId.make("project-pull");
    expect(resolveProjectAutoPull(DEFAULT_SERVER_SETTINGS, projectId, false)).toBe(false);
    expect(resolveProjectAutoPull(DEFAULT_SERVER_SETTINGS, projectId, true)).toBe(true);
    const enabled = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { defaultAutoPull: true });
    expect(resolveProjectAutoPull(enabled, projectId, false)).toBe(true);
    const overridden = applyServerSettingsPatch(enabled, {
      projectAutoPullOverrides: { [projectId]: false },
    });
    expect(resolveProjectAutoPull(overridden, projectId, true)).toBe(false);
    const reset = applyServerSettingsPatch(overridden, {
      projectAutoPullOverrides: { [projectId]: null },
    });
    expect(resolveProjectAutoPull(reset, projectId, false)).toBe(true);
    const disabled = applyServerSettingsPatch(reset, {
      defaultAutoPull: false,
      projectAutoPullOverrides: { [projectId]: true },
    });
    expect(resolveProjectAutoPull(disabled, projectId, false)).toBe(true);
    expect(resolveProjectAutoPull(disabled, ProjectId.make("other-project"), false)).toBe(false);
  });

  it("preserves other projects' boolean overrides across separate updates and resets", () => {
    const firstProjectId = ProjectId.make("first-project");
    const secondProjectId = ProjectId.make("second-project");
    const firstUpdate = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      defaultAutoPull: true,
      projectAutoPullOverrides: { [firstProjectId]: false },
      projectAgentBrowserAccessOverrides: { [firstProjectId]: false },
    });
    const secondUpdate = applyServerSettingsPatch(firstUpdate, {
      projectAutoPullOverrides: { [secondProjectId]: false },
      projectAgentBrowserAccessOverrides: { [secondProjectId]: false },
    });
    for (const projectId of [firstProjectId, secondProjectId]) {
      expect(resolveProjectAutoPull(secondUpdate, projectId, false)).toBe(false);
      expect(resolveProjectAgentBrowserAccess(secondUpdate, projectId)).toBe(false);
    }

    const reset = applyServerSettingsPatch(secondUpdate, {
      projectAutoPullOverrides: { [firstProjectId]: null },
      projectAgentBrowserAccessOverrides: { [firstProjectId]: null },
    });
    expect(resolveProjectAutoPull(reset, firstProjectId, false)).toBe(true);
    expect(resolveProjectAgentBrowserAccess(reset, firstProjectId)).toBe(true);
    expect(resolveProjectAutoPull(reset, secondProjectId, false)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(reset, secondProjectId)).toBe(false);
    expect(reset.projectAutoPullOverrides[firstProjectId]).toBeUndefined();
    expect(reset.projectAgentBrowserAccessOverrides[firstProjectId]).toBeUndefined();
    expect(resolveProjectAutoPull(secondUpdate, firstProjectId, false)).toBe(false);
    expect(resolveProjectAgentBrowserAccess(secondUpdate, firstProjectId)).toBe(false);
  });

  it("parses lenient persisted settings JSON and trims observability URLs", () => {
    expect(
      parsePersistedServerObservabilitySettings(
        JSON.stringify({
          observability: {
            otlpTracesUrl: "  http://localhost:4318/v1/traces  ",
            otlpMetricsUrl: "  http://localhost:4318/v1/metrics  ",
            otlpLogsUrl: "  http://localhost:4318/v1/logs  ",
          },
        }),
      ),
    ).toEqual({
      otlpTracesUrl: "http://localhost:4318/v1/traces",
      otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      otlpLogsUrl: "http://localhost:4318/v1/logs",
    });
  });

  it("falls back cleanly when persisted settings are invalid", () => {
    expect(parsePersistedServerObservabilitySettings("{")).toEqual({
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpLogsUrl: undefined,
    });
  });

  it("still deep merges text generation selection when only options are provided", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          options: [{ id: "fastMode", value: false }],
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4-mini",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: false },
      ],
    });
  });

  it("replaces text generation selection across providers without leaking stale options", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
        [
          { id: "reasoningEffort", value: "high" },
          { id: "fastMode", value: true },
        ],
      ),
    };

    expect(
      applyServerSettingsPatch(current, {
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      }).textGenerationModelSelection,
    ).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5",
    });
  });

  it("falls back from a disabled source control writer provider without clearing its selection", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };

    expect(isModelSelectionProviderEnabled(settings, sourceControlWriterModelSelection)).toBe(
      false,
    );
    expect(resolveSourceControlWriterModelSelection(settings, undefined, null)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from a writer provider that cannot generate application text", () => {
    const instanceId = ProviderInstanceId.make("acp_writer");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "default");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          config: {},
        },
      },
      sourceControlWriterModelSelection,
    };
    const incapableProvider = {
      instanceId,
      driver: ProviderDriverKind.make("acpRegistry"),
      supportsTextGeneration: false,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [incapableProvider], null)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(settings.sourceControlWriterModelSelection).toBe(sourceControlWriterModelSelection);
  });

  it("falls back from a writer provider a project turned off, keeping it for other projects", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const projectId = ProjectId.make("project-a");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
      sourceControlWriterModelSelection,
    };
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "available",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [provider], projectId)).toBe(
      settings.textGenerationModelSelection,
    );
    expect(resolveSourceControlWriterModelSelection(settings, [provider], null)).toBe(
      sourceControlWriterModelSelection,
    );
  });

  it("keeps a writer on an instance the project turned on while the machine has it off", () => {
    const instanceId = ProviderInstanceId.make("codex_writer");
    const projectId = ProjectId.make("project-a");
    const sourceControlWriterModelSelection = createModelSelection(instanceId, "gpt-5.4-mini");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
      },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
      sourceControlWriterModelSelection,
    };
    const provider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-07-27T00:00:00.000Z",
      availability: "available",
      models: [],
      slashCommands: [],
      skills: [],
    } satisfies ServerProvider;

    expect(resolveSourceControlWriterModelSelection(settings, [provider], projectId)).toBe(
      sourceControlWriterModelSelection,
    );
    expect(resolveSourceControlWriterModelSelection(settings, [provider], null)).toBe(
      settings.textGenerationModelSelection,
    );
  });

  it("replaces providerInstances maps so omitted instance fields are cleared", () => {
    const codexId = ProviderInstanceId.make("codex");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex Work",
          accentColor: "#7c3aed",
          enabled: true,
          config: { homePath: "~/.codex" },
        },
      },
    };

    expect(
      applyServerSettingsPatch(current, {
        providerInstances: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            displayName: "Codex Work",
            enabled: true,
            config: { homePath: "~/.codex" },
          },
        },
      }).providerInstances[codexId],
    ).toEqual({
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex Work",
      enabled: true,
      config: { homePath: "~/.codex" },
    });
  });

  it("keeps a project's providerInstances override when a patch entry omits the key", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const projectId = ProjectId.make("project-a");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    };

    const patched = applyServerSettingsPatch(current, {
      projectSettingsOverrides: {
        [projectId]: { newWorktreesStartFromOrigin: false },
      },
    });

    expect(patched.projectSettingsOverrides[projectId]).toEqual({
      newWorktreesStartFromOrigin: false,
      providerInstances: { [instanceId]: { enabled: false } },
    });
  });

  it("clears a project's providerInstances override when a patch entry sends an empty map", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const projectId = ProjectId.make("project-a");
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: false } },
        },
      },
    };

    const patched = applyServerSettingsPatch(current, {
      projectSettingsOverrides: {
        [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
      },
    });

    expect(patched.projectSettingsOverrides[projectId]).toEqual({
      newWorktreesStartFromOrigin: true,
      providerInstances: {},
    });
  });

  it("upserts and removes usageLimitSources per entry so concurrent edits cannot clobber", () => {
    const hubA = UsageLimitSourceId.make("cliproxy-a");
    const hubB = UsageLimitSourceId.make("cliproxy-b");
    const source = (url: string) => ({
      kind: "cliproxy" as const,
      url,
      managementKey: "secret",
      enabled: true,
    });
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      usageLimitSources: { [hubA]: source("http://a:8318") },
    };

    const added = applyServerSettingsPatch(current, {
      usageLimitSources: { [hubB]: source("http://b:8318") },
    });
    expect(Object.keys(added.usageLimitSources)).toEqual([hubA, hubB]);

    const removed = applyServerSettingsPatch(added, { usageLimitSources: { [hubA]: null } });
    expect(Object.keys(removed.usageLimitSources)).toEqual([hubB]);
  });

  it("replaces and removes individual usage prices without clobbering other models", () => {
    const prices = { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 8 };
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usagePriceOverrides: { "example-model": { ...prices, cacheReadCostPerMillionTokens: 0.5 } },
    });
    const added = applyServerSettingsPatch(current, {
      usagePriceOverrides: { "other-model": prices },
    });
    const replaced = applyServerSettingsPatch(added, {
      usagePriceOverrides: { "example-model": prices },
    });
    expect(replaced.usagePriceOverrides).toEqual({
      "example-model": prices,
      "other-model": prices,
    });
    const removed = applyServerSettingsPatch(replaced, {
      usagePriceOverrides: { "example-model": null },
    });
    expect(removed.usagePriceOverrides).toEqual({ "other-model": prices });
    expect(current.usagePriceOverrides["example-model"]?.cacheReadCostPerMillionTokens).toBe(0.5);
  });

  it("stores background activity profiles as a versioned object and syncs legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(
      Duration.toMillis(Duration.minutes(15)),
    );
  });

  it("turns legacy interval patches into custom background activity overrides", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
    expect(resolveServerBackgroundActivitySettings(next).profile).toBe("balanced");
    expect(
      Duration.toMillis(resolveServerBackgroundActivitySettings(next).automaticGitFetchInterval),
    ).toBe(15_000);
  });

  it("preserves legacy background activity settings when applying an unrelated patch", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivityProfile: "performance" as const,
      automaticGitFetchInterval: Duration.seconds(7),
      providerHealthRefreshInterval: Duration.minutes(4),
    };

    const next = applyServerSettingsPatch(current, {
      sourceControlWriterModelSelection: createModelSelection(
        ProviderInstanceId.make("codex"),
        "gpt-5.4-mini",
      ),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(7),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
    expect(next.backgroundActivityProfile).toBe("performance");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(7_000);
    expect(Duration.toMillis(next.providerHealthRefreshInterval)).toBe(240_000);
  });

  it("does not reactivate dormant overrides from a concrete profile", () => {
    const current = {
      ...DEFAULT_SERVER_SETTINGS,
      backgroundActivity: {
        schemaVersion: 1 as const,
        profile: "battery-saver" as const,
        overrides: {
          providerHealthRefreshInterval: Duration.seconds(5),
        },
      },
    };

    const next = applyServerSettingsPatch(current, {
      automaticGitFetchInterval: Duration.seconds(15),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(15),
      },
    });
  });

  it("prefers structured background activity settings over legacy aliases", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "battery-saver",
        overrides: {},
      },
      automaticGitFetchInterval: Duration.seconds(5),
      backgroundActivityProfile: "performance",
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "battery-saver",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("battery-saver");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(0);
  });

  it("reconciles custom background activity back to a preset when overrides match the preset", () => {
    const custom = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      automaticGitFetchInterval: Duration.seconds(15),
    });
    const next = applyServerSettingsPatch(custom, {
      automaticGitFetchInterval: Duration.seconds(30),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "balanced",
      overrides: {},
    });
    expect(next.backgroundActivityProfile).toBe("balanced");
    expect(Duration.toMillis(next.automaticGitFetchInterval)).toBe(30_000);
  });

  it("replaces the complete background override record", () => {
    const current = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivity: {
        schemaVersion: 1,
        profile: "custom",
        baseProfile: "balanced",
        overrides: {
          automaticGitFetchInterval: Duration.seconds(15),
          providerHealthRefreshInterval: Duration.minutes(3),
        },
      },
    });

    const next = applyServerSettingsPatch(current, {
      backgroundActivity: {
        overrides: {
          automaticGitFetchInterval: Duration.seconds(10),
        },
      },
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(10),
      },
    });
  });

  it("keeps interval overrides supplied with a profile patch", () => {
    const next = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      backgroundActivityProfile: "performance",
      automaticGitFetchInterval: Duration.seconds(0),
      providerHealthRefreshInterval: Duration.minutes(4),
    });

    expect(next.backgroundActivity).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval: Duration.seconds(0),
        providerHealthRefreshInterval: Duration.minutes(4),
      },
    });
  });
});

describe("worktreesDirectory", () => {
  it("remembers previous custom locations so their worktrees stay managed", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { worktreesDirectory: "/a" });
    expect(first.previousWorktreesDirectories).toEqual([]);
    const second = applyServerSettingsPatch(first, { worktreesDirectory: "/b" });
    expect(second.previousWorktreesDirectories).toEqual(["/a"]);
    const reset = applyServerSettingsPatch(second, { worktreesDirectory: "" });
    expect(reset.previousWorktreesDirectories).toEqual(["/a", "/b"]);
    const back = applyServerSettingsPatch(reset, { worktreesDirectory: "/a" });
    expect(back.previousWorktreesDirectories).toEqual(["/b"]);
  });
});

describe("synchronized model preferences", () => {
  const provider = ProviderInstanceId.make("codex_work");
  const legacy = {
    favorites: [{ provider, model: "sol" }],
    providerModelPreferences: { [provider]: { hiddenModels: ["astra"], modelOrder: ["sol"] } },
  };

  it("keeps concurrent adds and removes of the same favorite idempotent", () => {
    const add = { setModelFavorites: [{ provider, model: "sol", favorite: true }] };
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, add);
    expect(applyServerSettingsPatch(first, add).favorites).toEqual([{ provider, model: "sol" }]);
    const remove = { setModelFavorites: [{ provider, model: "sol", favorite: false }] };
    const removed = applyServerSettingsPatch(first, remove);
    expect(applyServerSettingsPatch(removed, remove).favorites).toEqual([]);
  });

  it("preserves unrelated models and providers during bulk visibility and order edits", () => {
    const otherProvider = ProviderInstanceId.make("claude_work");
    const initial = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      providerModelPreferences: {
        ...legacy.providerModelPreferences,
        [otherProvider]: { hiddenModels: ["opus"], modelOrder: ["sonnet", "opus"] },
      },
    });
    const mobile = applyServerSettingsPatch(initial, {
      setModelsHidden: [{ provider, model: "luna", hidden: true }],
    });
    const web = applyServerSettingsPatch(mobile, {
      setModelsHidden: [
        { provider, model: "astra", hidden: false },
        { provider, model: "sol", hidden: true },
      ],
      setProviderModelOrder: { provider, modelOrder: ["sol", "luna", "astra"] },
    });
    expect(web.providerModelPreferences?.[provider]).toEqual({
      hiddenModels: ["luna", "sol"],
      modelOrder: ["sol", "luna", "astra"],
    });
    expect(web.providerModelPreferences?.[otherProvider]).toEqual(
      initial.providerModelPreferences?.[otherProvider],
    );
    expect(
      applyServerSettingsPatch(web, {
        setProviderModelOrder: { provider, modelOrder: [] },
      }).providerModelPreferences?.[provider],
    ).toEqual({ hiddenModels: ["luna", "sol"], modelOrder: [] });
  });

  it("migrates saved lists independently without claiming empty legacy lists", () => {
    expect(modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, {})).toBeNull();
    const patch = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const migrated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    expect(resolveModelPreferences(migrated)).toEqual(legacy);
    expect(modelPreferencesMigrationPatch(migrated, legacy)).toBeNull();
    const favoritesOnly = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { favorites: [] });
    expect(modelPreferencesMigrationPatch(favoritesOnly, legacy)).toEqual({
      migrateModelPreferences: { providerModelPreferences: legacy.providerModelPreferences },
    });
  });

  it("keeps explicit clears when a delayed migration arrives from another device", () => {
    const staleMigration = modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!;
    const cleared = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      favorites: [],
      providerModelPreferences: {},
    });
    expect(
      resolveModelPreferences(applyServerSettingsPatch(cleared, staleMigration), legacy),
    ).toEqual({
      favorites: [],
      providerModelPreferences: {},
    });
  });

  it("replaces visibility records so showing every model clears removed entries", () => {
    const migrated = applyServerSettingsPatch(
      DEFAULT_SERVER_SETTINGS,
      modelPreferencesMigrationPatch(DEFAULT_SERVER_SETTINGS, legacy)!,
    );
    const cleared = applyServerSettingsPatch(migrated, { providerModelPreferences: {} });
    expect(cleared.providerModelPreferences).toEqual({});
    expect(cleared.favorites).toEqual(legacy.favorites);
  });

  it("sets favorites without losing changes from other clients", () => {
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider, model: "astra", favorite: true }],
      migrateModelPreferences: { favorites: [] },
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider, model: "astra" },
    ]);
    const removed = applyServerSettingsPatch(second, {
      setModelFavorites: [{ provider, model: "sol", favorite: false }],
    });
    expect(removed.favorites).toEqual([{ provider, model: "astra" }]);
    expect(
      applyServerSettingsPatch(removed, {
        setModelFavorites: [{ provider, model: "astra", favorite: false }],
      }).favorites,
    ).toEqual([]);
  });

  it("keeps the same model on different provider instances as separate favorites", () => {
    const otherProvider = ProviderInstanceId.make("codex_personal");
    const first = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      setModelFavorites: [{ provider, model: "sol", favorite: true }],
    });
    const second = applyServerSettingsPatch(first, {
      setModelFavorites: [{ provider: otherProvider, model: "sol", favorite: true }],
    });
    expect(second.favorites).toEqual([
      { provider, model: "sol" },
      { provider: otherProvider, model: "sol" },
    ]);
    expect(
      applyServerSettingsPatch(second, {
        setModelFavorites: [{ provider, model: "sol", favorite: false }],
      }).favorites,
    ).toEqual([{ provider: otherProvider, model: "sol" }]);
  });
});

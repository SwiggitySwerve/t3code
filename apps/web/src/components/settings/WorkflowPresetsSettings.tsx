import { PlusIcon } from "lucide-react";
import { useState } from "react";
import { randomUUID } from "../../lib/utils";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type WorkflowPreset,
} from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

export function WorkflowPresetsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [draft, setDraft] = useState<WorkflowPreset | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presets = settings.workflowPresets;
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const activeEntry = instanceEntries.find(
    (entry) => entry.instanceId === draft?.target.providerInstanceId,
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    draft?.target.providerInstanceId,
    draft?.target.model,
  );

  const save = async (next: typeof presets, closeEditor = false) => {
    if (!canWrite || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await persist({ environmentId, input: { patch: { workflowPresets: next } } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save agent presets.");
      } else if (closeEditor) setDraft(null);
    } catch {
      setError("Could not save agent presets. Reconnect and try again.");
    }
    setPending(false);
  };

  const editing = draft !== null && presets.presets.some((entry) => entry.id === draft.id);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="workflow-presets"
        title="Agent presets"
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canWrite || pending || draft !== null}
            onClick={() => {
              const selection = resolveAppModelSelectionState(settings, providers);
              setDraft({
                id: randomUUID(),
                name: "",
                target: {
                  providerInstanceId: selection.instanceId,
                  model: selection.model,
                  options: [],
                },
              });
              setError(null);
            }}
          >
            <PlusIcon className="size-3" />
            Create preset
          </Button>
        }
      >
        <SettingsRow
          title="Workflow workers"
          description="Save a provider, model and options for workflow workers. The coordinator keeps its own model."
          status={canWrite ? undefined : "This connection cannot change agent presets."}
        />
        {error ? (
          <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
            {error}
          </p>
        ) : null}
        {presets.presets.length === 0 ? (
          <p className="px-3 py-3 text-base text-muted-foreground sm:px-4 sm:text-sm">
            No agent presets yet.
          </p>
        ) : null}
        {presets.presets.map((preset) => (
          <SettingsRow
            key={preset.id}
            title={<span className="[overflow-wrap:anywhere]">{preset.name}</span>}
            description={
              <span className="[overflow-wrap:anywhere]">
                {preset.target.providerInstanceId} / {preset.target.model}
              </span>
            }
            control={
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={presets.defaultPresetId === preset.id}
                    disabled={!canWrite || pending}
                    onCheckedChange={(checked) =>
                      void save({ ...presets, defaultPresetId: checked ? preset.id : null })
                    }
                  />
                  <span aria-hidden>Worker default</span>
                  <span className="sr-only">{`Workflow worker default: ${preset.name}`}</span>
                </label>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canWrite || pending}
                  aria-label={`Edit ${preset.name}`}
                  onClick={() => {
                    setDraft(preset);
                    setError(null);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canWrite || pending}
                  aria-label={`Delete ${preset.name}`}
                  onClick={() =>
                    void save(
                      {
                        presets: presets.presets.filter((entry) => entry.id !== preset.id),
                        defaultPresetId:
                          presets.defaultPresetId === preset.id ? null : presets.defaultPresetId,
                      },
                      draft?.id === preset.id,
                    )
                  }
                >
                  Delete
                </Button>
              </div>
            }
          />
        ))}
      </SettingsSection>
      {draft ? (
        <SettingsSection id="workflow-preset-editor" title={editing ? "Edit preset" : "New preset"}>
          <form
            className="divide-y divide-border/50"
            aria-label="Agent preset"
            onSubmit={(event) => {
              event.preventDefault();
              if (!draft.name.trim() || pending || !canWrite) return;
              const saved = { ...draft, name: draft.name.trim() };
              void save(
                {
                  ...presets,
                  presets: [...presets.presets.filter((entry) => entry.id !== saved.id), saved],
                },
                true,
              );
            }}
          >
            <SettingsRow
              title="Name"
              control={
                <div className="w-full @min-[32rem]/settings-row:w-64">
                  <Input
                    aria-label="Preset name"
                    value={draft.name}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                    disabled={pending || !canWrite}
                  />
                </div>
              }
            />
            <SettingsRow
              title="Model"
              description="The provider, model and options a worker using this preset runs with."
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={draft.target.providerInstanceId}
                    model={draft.target.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptions}
                    triggerAriaLabel="Preset model"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    disabled={pending || !canWrite}
                    onInstanceModelChange={(providerInstanceId, model) =>
                      setDraft({ ...draft, target: { providerInstanceId, model, options: [] } })
                    }
                  />
                  {activeEntry ? (
                    <TraitsPicker
                      provider={activeEntry.driverKind}
                      models={activeEntry.models}
                      model={draft.target.model}
                      modelOptions={draft.target.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={settings.planModeEnabled}
                      disabled={pending || !canWrite}
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) => {
                        if (!pending && canWrite)
                          setDraft({
                            ...draft,
                            target: { ...draft.target, options: options ?? [] },
                          });
                      }}
                    />
                  ) : null}
                </div>
              }
            />
            <div className="flex justify-end gap-2 px-3 py-3 sm:px-4">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!draft.name.trim() || !canWrite || pending}>
                {pending ? "Saving…" : "Save preset"}
              </Button>
            </div>
          </form>
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

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

  return (
    <SettingsPageContainer>
      <SettingsSection id="workflow-presets" title="Agent presets">
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Save a provider, model and options for workflow workers. The coordinator keeps its own
          model.
        </p>
        {!canWrite ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            This connection cannot change agent presets.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="space-y-3 p-4">
          {presets.presets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agent presets yet.</p>
          ) : null}
          {presets.presets.map((preset) => (
            <div key={preset.id} className="flex min-w-0 flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{preset.name}</p>
                <p className="break-words text-xs text-muted-foreground">
                  {preset.target.providerInstanceId} / {preset.target.model}
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={presets.defaultPresetId === preset.id}
                  disabled={!canWrite || pending}
                  onCheckedChange={(checked) =>
                    void save({ ...presets, defaultPresetId: checked ? preset.id : null })
                  }
                />
                <span aria-hidden>Workflow worker default</span>
                <span className="sr-only">{`Workflow worker default: ${preset.name}`}</span>
              </label>
              <Button
                size="sm"
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
                size="sm"
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
          ))}
          <Button
            size="sm"
            variant="outline"
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
            Create preset
          </Button>
        </div>
        {draft ? (
          <form
            className="space-y-4 p-4"
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
            <label className="block space-y-2 text-sm">
              Name
              <Input
                aria-label="Preset name"
                value={draft.name}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                disabled={pending || !canWrite}
              />
            </label>
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
                      setDraft({ ...draft, target: { ...draft.target, options: options ?? [] } });
                  }}
                />
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!draft.name.trim() || !canWrite || pending}>
                {pending ? "Saving…" : "Save preset"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setDraft(null)}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

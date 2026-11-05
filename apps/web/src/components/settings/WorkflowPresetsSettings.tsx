import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerProvider,
  type UnifiedSettings,
  type WorkflowPreset,
} from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { providerInstanceEntriesFor } from "../../providerInstances";
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

type Roles = UnifiedSettings["workflowPresets"];

/** A name no role uses yet, so a new role never shares a label with an old one. */
function newRoleName(roles: Roles): string {
  const taken = new Set(roles.presets.map((role) => role.name.trim().toLowerCase()));
  for (let index = 1; ; index++) {
    const name = index === 1 ? "New role" : `New role ${index}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/**
 * The Workflow settings page: the switch that turns workflows on, when a message starts one, and
 * the agent roles workers run as. A role is edited in place like the default model in General:
 * its model and effort save on change, its name on Enter or blur.
 */
export function WorkflowPresetsSettings({
  environmentId,
  startSetting,
}: {
  environmentId: EnvironmentId;
  /** The project-scoped "Start a workflow" row, when the page has a scope to show it for. */
  startSetting?: ReactNode;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders().get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusRoleId, setFocusRoleId] = useState<string | null>(null);
  const roles = settings.workflowPresets;
  const editable = settings.workflows && canWrite && !pending;

  /** Saves the whole list; resolves true once the server took it. */
  const save = async (next: Roles): Promise<boolean> => {
    if (!canWrite || pending) return false;
    setPending(true);
    setError(null);
    let saved = false;
    try {
      const result = await persist({ environmentId, input: { patch: { workflowPresets: next } } });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not save agent roles.");
      } else saved = true;
    } catch {
      setError("Could not save agent roles. Reconnect and try again.");
    }
    setPending(false);
    return saved;
  };

  const replaceRole = (role: WorkflowPreset) =>
    save({
      ...roles,
      presets: roles.presets.map((entry) => (entry.id === role.id ? role : entry)),
    });

  const addRole = async () => {
    const selection = resolveAppModelSelectionState(settings, providers);
    const role: WorkflowPreset = {
      id: randomUUID(),
      name: newRoleName(roles),
      target: {
        providerInstanceId: selection.instanceId,
        model: selection.model,
        options: selection.options ?? [],
      },
    };
    if (await save({ ...roles, presets: [...roles.presets, role] })) setFocusRoleId(role.id);
  };

  const toggleWorkflows = async (workflows: boolean) => {
    if (!canWrite || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await persist({ environmentId, input: { patch: { workflows } } });
      if (result._tag === "Failure") setError("Could not save workflows. Reconnect and try again.");
    } catch {
      setError("Could not save workflows. Reconnect and try again.");
    }
    setPending(false);
  };

  return (
    <SettingsPageContainer>
      <SettingsSection id="workflows" title="Workflows">
        <SettingsRow
          title="Enable workflows"
          description="Takes effect when an agent session starts. Open chats pick it up when their agent restarts."
          control={
            <Switch
              aria-label="Enable workflows"
              checked={settings.workflows}
              disabled={!canWrite || pending}
              onCheckedChange={(checked) => void toggleWorkflows(checked)}
            />
          }
        />
        {startSetting}
      </SettingsSection>
      <SettingsSection
        id="workflow-presets"
        title="Agent Roles"
        headerAction={
          <Button size="xs" disabled={!editable} onClick={() => void addRole()}>
            <PlusIcon className="size-3" />
            Add role
          </Button>
        }
      >
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          {!settings.workflows
            ? "Workflows are off. Enable workflows to configure and run workers. Saved roles are kept."
            : "Each role sets the provider, model and effort a worker runs with. The coordinator gives each task a role and keeps its own model; a task that names no role or model uses the default role."}
        </p>
        {canWrite ? null : (
          <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
            This connection cannot change agent roles.
          </p>
        )}
        {error ? (
          <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
            {error}
          </p>
        ) : null}
        {roles.presets.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            No roles yet. Add one to choose the provider, model and effort a worker runs with.
          </p>
        ) : null}
        {roles.presets.map((role) => (
          <RoleRow
            // A saved rename remounts the row with the stored name; a failed one keeps the draft.
            key={`${role.id}:${role.name}`}
            role={role}
            isDefault={roles.defaultPresetId === role.id}
            autoFocusName={focusRoleId === role.id}
            onNameBlur={() => setFocusRoleId(null)}
            editable={editable}
            environmentId={environmentId}
            settings={settings}
            providers={providers}
            onChange={(next) => void replaceRole(next)}
            onRename={(name) => replaceRole({ ...role, name })}
            onDefaultChange={(checked) =>
              void save({ ...roles, defaultPresetId: checked ? role.id : null })
            }
            onDelete={() =>
              void save({
                presets: roles.presets.filter((entry) => entry.id !== role.id),
                defaultPresetId: roles.defaultPresetId === role.id ? null : roles.defaultPresetId,
              })
            }
          />
        ))}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function RoleRow(props: {
  readonly role: WorkflowPreset;
  readonly isDefault: boolean;
  readonly autoFocusName: boolean;
  readonly onNameBlur: () => void;
  readonly editable: boolean;
  readonly environmentId: EnvironmentId;
  readonly settings: UnifiedSettings;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onChange: (role: WorkflowPreset) => void;
  readonly onRename: (name: string) => Promise<boolean>;
  readonly onDefaultChange: (checked: boolean) => void;
  readonly onDelete: () => void;
}) {
  const { role, settings, providers, editable } = props;
  const [name, setName] = useState(role.name);
  const nameInput = useRef<HTMLInputElement>(null);
  // Escape blurs the field before its reset renders, so the blur must know not to save.
  const cancelRename = useRef(false);
  // A new role's name is ready to type once the row can be edited (it is disabled while saving).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- moves DOM focus to the new role's name input once it is enabled
  useEffect(() => {
    if (!props.autoFocusName || !editable) return;
    nameInput.current?.focus();
    nameInput.current?.select();
  }, [props.autoFocusName, editable]);
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null);
  const entry = instanceEntries.find(
    (candidate) => candidate.instanceId === role.target.providerInstanceId,
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    role.target.providerInstanceId,
    role.target.model,
  );

  const commitName = () => {
    props.onNameBlur();
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length === 0) setName(role.name);
    else if (trimmed !== role.name) void props.onRename(trimmed);
  };

  return (
    <SettingsRow
      title={
        <Input
          aria-label={`Role name: ${role.name}`}
          className="w-full max-w-56"
          size="sm"
          value={name}
          ref={nameInput}
          disabled={!editable}
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelRename.current = true;
              setName(role.name);
              event.currentTarget.blur();
            }
          }}
        />
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <ProviderModelPicker
            environmentId={props.environmentId}
            activeInstanceId={role.target.providerInstanceId}
            model={role.target.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptions}
            triggerAriaLabel={`Model for ${role.name}`}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            disabled={!editable}
            onInstanceModelChange={(providerInstanceId, model) =>
              props.onChange({ ...role, target: { providerInstanceId, model, options: [] } })
            }
          />
          {entry ? (
            <TraitsPicker
              provider={entry.driverKind}
              models={entry.models}
              model={role.target.model}
              modelOptions={role.target.options ?? []}
              allowPromptInjectedEffort={false}
              planModeEnabled={settings.planModeEnabled}
              disabled={!editable}
              triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
              onModelOptionsChange={(options) =>
                props.onChange({ ...role, target: { ...role.target, options: options ?? [] } })
              }
            />
          ) : null}
          <label className="ml-1.5 flex min-h-6 items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={props.isDefault}
              disabled={!editable}
              onCheckedChange={props.onDefaultChange}
            />
            <span aria-hidden>Default</span>
            <span className="sr-only">{`Default role: ${role.name}`}</span>
          </label>
          <Button
            size="xs"
            variant="destructive-outline"
            disabled={!editable}
            aria-label={`Delete ${role.name}`}
            onClick={props.onDelete}
          >
            Delete
          </Button>
        </div>
      }
    />
  );
}

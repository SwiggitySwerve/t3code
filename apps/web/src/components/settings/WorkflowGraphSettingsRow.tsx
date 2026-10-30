import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function WorkflowGraphSettingsRow() {
  const enabled = useScopedSettings((settings) => settings.verboseWorkflowGraph);
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("verbose-workflow-graph")}
      description="Show graph details with agent cards and dependency connections below the phase icons."
      resetAction={
        enabled !== DEFAULT_UNIFIED_SETTINGS.verboseWorkflowGraph ? (
          <SettingResetButton
            label="verbose workflow graph"
            onClick={() =>
              updateSettings({
                verboseWorkflowGraph: DEFAULT_UNIFIED_SETTINGS.verboseWorkflowGraph,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          aria-label="Verbose workflow graph"
          onCheckedChange={(checked) => updateSettings({ verboseWorkflowGraph: Boolean(checked) })}
        />
      }
    />
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { WorkflowPresetsSettings } from "../components/settings/WorkflowPresetsSettings";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";

function SettingsAgentsRoute() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind === "project" || scope.kind === "checkout") {
    return (
      <SettingsScopeNotice target="environment">
        Agent presets belong to an environment. Select the environment to manage its presets.
      </SettingsScopeNotice>
    );
  }
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its agent presets.`
          : "Connect an environment to manage its agent presets."}
      </p>
    );
  }
  return (
    <WorkflowPresetsSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/agents")({
  component: SettingsAgentsRoute,
});

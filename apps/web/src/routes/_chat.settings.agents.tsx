import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { WorkflowPresetsSettings } from "../components/settings/WorkflowPresetsSettings";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { WorkflowStartSetting } from "../components/settings/WorkflowStartSetting";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { useScopedSettings } from "../components/settings/useScopedSettings";

function SettingsAgentsRoute() {
  const { environment, scope } = useSettingsScope();
  const settings = useScopedSettings();
  if (scope.kind === "project" || scope.kind === "checkout") {
    // When a message starts a workflow can differ per project; agent roles cannot.
    return (
      <SettingsPageContainer>
        <SettingsSection id="workflows" title="Workflows">
          <WorkflowStartSetting workflows={settings.workflows} />
        </SettingsSection>
        <SettingsScopeNotice target="environment">
          Agent roles belong to an environment. Select the environment to manage its roles.
        </SettingsScopeNotice>
      </SettingsPageContainer>
    );
  }
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its agent roles.`
          : "Connect an environment to manage its agent roles."}
      </p>
    );
  }
  return (
    <WorkflowPresetsSettings
      key={environment.environmentId}
      environmentId={environment.environmentId}
      startSetting={<WorkflowStartSetting workflows={settings.workflows} />}
    />
  );
}

export const Route = createFileRoute("/_chat/settings/agents")({
  component: SettingsAgentsRoute,
});

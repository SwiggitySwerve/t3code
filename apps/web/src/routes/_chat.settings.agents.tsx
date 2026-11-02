import { createFileRoute } from "@tanstack/react-router";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { WorkflowEnableSetting } from "../components/settings/WorkflowEnableSetting";
import { WorkflowStartSetting } from "../components/settings/WorkflowStartSetting";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { useScopedSettings } from "../components/settings/useScopedSettings";

/**
 * Workflows: whether they are on, and when a message starts one. The coordinator chooses each
 * agent's provider, model and effort, so nothing here assigns agents.
 */
function SettingsAgentsRoute() {
  const { environment, scope } = useSettingsScope();
  const settings = useScopedSettings();
  const projectScoped = scope.kind === "project" || scope.kind === "checkout";
  if (!projectScoped && !environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to manage its workflows.`
          : "Connect an environment to manage its workflows."}
      </p>
    );
  }
  return (
    <SettingsPageContainer>
      <SettingsSection id="workflows" title="Workflows">
        {!projectScoped && environment ? (
          <WorkflowEnableSetting
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ) : null}
        <WorkflowStartSetting workflows={settings.workflows} />
      </SettingsSection>
      {projectScoped ? (
        // When a message starts a workflow can differ per project; turning workflows on cannot.
        <SettingsScopeNotice target="environment">
          Workflows are turned on per environment. Select the environment to change it.
        </SettingsScopeNotice>
      ) : null}
    </SettingsPageContainer>
  );
}

export const Route = createFileRoute("/_chat/settings/agents")({
  component: SettingsAgentsRoute,
});

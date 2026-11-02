import { useState } from "react";
import { AuthSettingsWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SAVE_FAILED = "Could not save workflows. Reconnect and try again.";

/**
 * The switch that turns workflows on for one environment. The coordinator chooses every agent's
 * provider, model and effort, so this is the only workflow setting an environment keeps.
 */
export function WorkflowEnableSetting({ environmentId }: { environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const persist = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleWorkflows = async (workflows: boolean) => {
    if (!canWrite || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await persist({ environmentId, input: { patch: { workflows } } });
      if (result._tag === "Failure") setError(SAVE_FAILED);
    } catch {
      setError(SAVE_FAILED);
    }
    setPending(false);
  };

  return (
    <>
      <SettingsRow
        {...searchableSetting("workflows-enable")}
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
      {canWrite ? null : (
        <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">
          This connection cannot change workflow settings.
        </p>
      )}
      {error ? (
        <p role="alert" className="px-3 py-3 text-sm text-destructive sm:px-4">
          {error}
        </p>
      ) : null}
    </>
  );
}

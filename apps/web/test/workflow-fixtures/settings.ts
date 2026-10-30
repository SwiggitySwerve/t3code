import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { __setClientSettingsForTests } from "../../src/hooks/useSettings";

export function workflowClientSettings(verboseWorkflowGraph = false): Disposable {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, verboseWorkflowGraph });
  return {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };
}

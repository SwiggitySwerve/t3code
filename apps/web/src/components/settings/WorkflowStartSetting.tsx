import { DEFAULT_UNIFIED_SETTINGS, WorkflowStartMode } from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";

import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

// The contract's modes: one it adds is listed here and must get a label and description below.
const WORKFLOW_START_MODES = WorkflowStartMode.literals;
const isWorkflowStartMode = Schema.is(WorkflowStartMode);

const WORKFLOW_START_LABELS: Record<WorkflowStartMode, string> = {
  keyword: "When a message says workflow",
  always: "Every message",
  off: "Never from a message",
};

const WORKFLOW_START_DESCRIPTIONS: Record<WorkflowStartMode, string> = {
  keyword:
    "A message with the word workflow asks the agent to plan one for your approval. Mentions like “GitHub Actions workflow” do not count.",
  always:
    "Every message asks the agent to run substantive work as a workflow. Saying workflow still asks for a plan first.",
  off: "Messages never start a workflow. Agents can still use the workflow tools.",
};

/** When a person's message starts a workflow. Project-scoped, so it uses the scoped settings. */
export function WorkflowStartSetting({ workflows }: { readonly workflows: boolean }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["workflowStart"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["workflowStart"]}
      {...searchableSetting("workflow-start")}
      description={
        !workflows
          ? "Workflows are off for this environment."
          : mixed
            ? "The selected targets start workflows differently."
            : WORKFLOW_START_DESCRIPTIONS[settings.workflowStart]
      }
      resetAction={
        settings.workflowStart !== DEFAULT_UNIFIED_SETTINGS.workflowStart ? (
          <SettingResetButton
            label="workflow start"
            onClick={() =>
              updateSettings({ workflowStart: DEFAULT_UNIFIED_SETTINGS.workflowStart })
            }
          />
        ) : null
      }
      control={
        <Select
          disabled={!workflows}
          value={mixed ? null : settings.workflowStart}
          onValueChange={(value) => {
            if (isWorkflowStartMode(value)) {
              updateSettings({ workflowStart: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-60" aria-label="Start a workflow">
            <SelectValue>
              {(value: WorkflowStartMode | null) =>
                value === null ? "Mixed" : WORKFLOW_START_LABELS[value]
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {WORKFLOW_START_MODES.map((mode) => (
              <SelectItem key={mode} hideIndicator value={mode}>
                {WORKFLOW_START_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

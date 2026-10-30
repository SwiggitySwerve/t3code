import {
  WORKFLOW_MEMBER_STATE,
  type RuntimeSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { WORKFLOW_STATE_TEXT } from "./workflowStatusAppearance";

/** Agent status words accompany colour so the Lineage list never relies on colour alone. */
export interface WorkflowStatusText {
  readonly label: string;
  readonly className: string;
}

export function workflowMemberStatusText(status: RuntimeSubagentStatus): WorkflowStatusText {
  const className = WORKFLOW_STATE_TEXT[WORKFLOW_MEMBER_STATE[status]];
  switch (status) {
    case "completed":
      return { label: "Done", className };
    case "running":
      return { label: "Running", className };
    case "failed":
      return { label: "Failed", className };
    case "pending":
      return { label: "Queued", className };
    case "waiting":
      return { label: "Waiting", className };
    case "idle":
      return { label: "Idle", className };
    case "cancelled":
    case "interrupted":
      return { label: "Stopped", className };
  }
}

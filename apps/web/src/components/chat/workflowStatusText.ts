import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";

/** The word the Lineage header shows for a workflow; its status icon carries the colour. */
export function workflowMemberStatusLabel(status: RuntimeSubagentStatus): string {
  switch (status) {
    case "completed":
      return "Done";
    case "running":
      return "Running";
    case "failed":
      return "Failed";
    case "pending":
      return "Queued";
    case "waiting":
      return "Waiting";
    case "idle":
      return "Idle";
    case "cancelled":
    case "interrupted":
      return "Stopped";
  }
}

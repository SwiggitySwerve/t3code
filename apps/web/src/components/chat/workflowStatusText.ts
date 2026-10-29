import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";

/** Agent status words accompany colour so the Lineage list never relies on colour alone. */
export interface WorkflowStatusText {
  readonly label: string;
  readonly className: string;
}

const GREY = "text-muted-foreground";

export function workflowMemberStatusText(status: RuntimeSubagentStatus): WorkflowStatusText {
  switch (status) {
    case "completed":
      return { label: "Done", className: "text-success-foreground" };
    case "running":
      return { label: "Running", className: "text-info-foreground" };
    case "failed":
      return { label: "Failed", className: "text-destructive-foreground" };
    case "pending":
      return { label: "Queued", className: GREY };
    case "waiting":
      return { label: "Waiting", className: GREY };
    case "idle":
      return { label: "Idle", className: GREY };
    case "cancelled":
    case "interrupted":
      return { label: "Stopped", className: GREY };
  }
}

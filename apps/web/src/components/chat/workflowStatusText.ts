import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";

/**
 * The words and text colour for how a workflow agent stands, shared by the block's agent rows and
 * the Lineage list so one status never has two spellings. Green is done, blue is running, red is
 * failed; waiting and stopped agents stay grey. The word is always shown, so colour never carries
 * the state alone.
 */
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

/** How a whole workflow stands, from its agents: any failure first, then any still working. */
export type WorkflowTone = "failed" | "running" | "passed" | "stopped";

export const WORKFLOW_TONE_TEXT: Readonly<Record<WorkflowTone, string>> = {
  failed: "text-destructive-foreground",
  running: "text-info-foreground",
  passed: "text-success-foreground",
  stopped: GREY,
};

export function workflowTone(
  statuses: ReadonlyArray<RuntimeSubagentStatus>,
): WorkflowTone | null {
  if (statuses.length === 0) return null;
  if (statuses.includes("failed")) return "failed";
  if (statuses.some((status) => status === "running" || status === "pending" || status === "waiting")) {
    return "running";
  }
  return statuses.every((status) => status === "completed") ? "passed" : "stopped";
}

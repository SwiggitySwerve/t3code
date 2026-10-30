import type { WorkflowTaskProgress } from "@t3tools/client-runtime/state/subagentRuntime";

type State = WorkflowTaskProgress["state"];

export const WORKFLOW_STATE_TEXT = {
  done: "text-info-foreground",
  running: "text-success-foreground",
  failed: "text-destructive-foreground",
  queued: "text-muted-foreground",
  stopped: "text-muted-foreground",
  skipped: "text-muted-foreground",
} as const satisfies Record<State, string>;

export const WORKFLOW_STATE_SEGMENT = {
  done: "bg-info-foreground forced-colors:bg-[Highlight]",
  running:
    "bg-success-foreground forced-colors:bg-[Canvas] forced-colors:border-y forced-colors:border-[Highlight]",
  failed:
    "bg-destructive-foreground text-background/70 bg-[repeating-linear-gradient(135deg,transparent_0px,transparent_3px,currentColor_3px,currentColor_4px)] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]",
  queued: "bg-muted-foreground/25 forced-colors:bg-[Canvas]",
  stopped:
    "bg-muted-foreground/35 border-y border-dashed border-muted-foreground forced-colors:bg-[Canvas] forced-colors:border-[CanvasText]",
  skipped:
    "bg-muted-foreground/35 border-y border-dotted border-muted-foreground forced-colors:bg-[Canvas] forced-colors:border-[CanvasText]",
} as const satisfies Record<State, string>;

export const WORKFLOW_STATE_MARKER = {
  done: "rounded-full bg-info-foreground forced-colors:bg-[Highlight]",
  running: "rounded-full border-2 border-success-foreground forced-colors:border-[Highlight]",
  failed: `${WORKFLOW_STATE_SEGMENT.failed} rotate-45 rounded-none border border-destructive-foreground forced-colors:border-[CanvasText]`,
  queued: "rounded-full border border-muted-foreground/60 forced-colors:border-[CanvasText]",
  stopped:
    "rounded-none bg-muted-foreground/50 border border-muted-foreground forced-colors:border-[CanvasText]",
  skipped:
    "rounded-none border border-dashed border-muted-foreground forced-colors:border-[CanvasText]",
} as const satisfies Record<State, string>;

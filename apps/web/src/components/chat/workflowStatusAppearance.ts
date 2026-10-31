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

export const WORKFLOW_STATE_CUE = {
  done: { dimmed: false, ring: "none", badge: null },
  running: { dimmed: false, ring: "solid", badge: null },
  failed: { dimmed: false, ring: "solid", badge: "!" },
  queued: { dimmed: true, ring: "none", badge: null },
  stopped: { dimmed: false, ring: "none", badge: "square" },
  skipped: { dimmed: false, ring: "dashed", badge: null },
} as const;

export const WORKFLOW_STATE_SEGMENT = {
  done: `${WORKFLOW_STATE_TEXT.done} bg-current forced-colors:bg-[Highlight]`,
  // A tint, so a bar of running work does not read as finished.
  running: `${WORKFLOW_STATE_TEXT.running} bg-current/40 forced-colors:bg-[Canvas] forced-colors:border-y forced-colors:border-[Highlight]`,
  failed: `${WORKFLOW_STATE_TEXT.failed} bg-current bg-[repeating-linear-gradient(135deg,transparent_0px,transparent_3px,var(--background)_3px,var(--background)_4px)] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]`,
  queued: `${WORKFLOW_STATE_TEXT.queued} bg-current forced-colors:bg-[Canvas]`,
  stopped: `${WORKFLOW_STATE_TEXT.stopped} bg-current forced-colors:bg-[Canvas] forced-colors:border forced-colors:border-[CanvasText]`,
  skipped: `${WORKFLOW_STATE_TEXT.skipped} border-y border-dashed border-current forced-colors:border-[CanvasText]`,
} as const satisfies Record<State, string>;

export const WORKFLOW_STATE_MARKER = {
  done: `${WORKFLOW_STATE_TEXT.done} rounded-full bg-current forced-colors:bg-[Highlight]`,
  running: `${WORKFLOW_STATE_TEXT.running} rounded-full border-2 border-current forced-colors:border-[Highlight]`,
  failed: `${WORKFLOW_STATE_SEGMENT.failed} rotate-45 rounded-none border border-current forced-colors:border-[CanvasText]`,
  queued: `${WORKFLOW_STATE_TEXT.queued} rounded-full border border-current forced-colors:border-[CanvasText]`,
  stopped: `${WORKFLOW_STATE_TEXT.stopped} rounded-none bg-current border border-current forced-colors:border-[CanvasText]`,
  skipped: `${WORKFLOW_STATE_TEXT.skipped} rounded-none border border-dashed border-current forced-colors:border-[CanvasText]`,
} as const satisfies Record<State, string>;

export function workflowIdentityStateClass(state: State, planned = false) {
  const cue = WORKFLOW_STATE_CUE[state];
  return [
    WORKFLOW_STATE_TEXT[state],
    cue.dimmed && !planned ? "opacity-40" : "",
    cue.ring === "solid"
      ? "rounded-full ring-2 ring-inset ring-current forced-colors:outline-2 forced-colors:-outline-offset-2 forced-colors:outline-[CanvasText]"
      : "",
    cue.ring === "dashed" ? WORKFLOW_STATE_MARKER.skipped : "",
    state === "stopped" || state === "skipped" ? "grayscale" : "",
  ].join(" ");
}

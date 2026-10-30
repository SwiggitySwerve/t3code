import {
  workflowCountEntries,
  workflowCountsText,
  workflowSettledText,
  type WorkflowProgressCounts,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { cn } from "../../lib/utils";
import { WORKFLOW_STATE_SEGMENT } from "./workflowStatusAppearance";

/** The segmented state bar every workflow progress surface draws, so states share one mapping. */
export function WorkflowProgressTrack({
  counts,
  decorative = false,
  className,
}: {
  readonly counts: WorkflowProgressCounts;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  const total = counts.total ?? counts.observed;
  if (counts.total === 0) return null;
  return (
    <div className={cn("relative h-1 w-full", className)} aria-hidden={decorative || undefined}>
      {decorative ? null : (
        <progress
          className={cn("absolute inset-0 h-full w-full opacity-0", PROGRESS_CLASS_NAME)}
          aria-label="Workflow tasks settled"
          aria-valuetext={`${workflowSettledText(counts)}; ${workflowCountsText(counts)}`}
          value={total === 0 ? undefined : counts.settled}
          max={total || 1}
        />
      )}
      <div
        aria-hidden="true"
        className={cn(
          // oxlint-disable-next-line shadcn/no-arbitrary-values -- system colors preserve the progress track in forced-colors mode.
          "absolute inset-0 flex overflow-hidden rounded-full bg-border forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-[CanvasText]",
          counts.total === null && "border-r-2 border-dashed border-muted-foreground",
        )}
      >
        {workflowCountEntries(counts).map(({ state, count }) =>
          state === "queued" ? null : (
            <span
              key={state}
              className={cn(
                "h-full shrink-0 forced-colors:forced-color-adjust-none",
                WORKFLOW_STATE_SEGMENT[state],
              )}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ),
        )}
      </div>
    </div>
  );
}

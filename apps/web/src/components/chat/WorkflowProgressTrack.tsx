import {
  workflowCountEntries,
  workflowCountsText,
  workflowSettledText,
  type WorkflowBarSegment,
  type WorkflowProgressCounts,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WORKFLOW_STATE_SEGMENT } from "./workflowStatusAppearance";

/** How a settled workflow draws work it never reached: skipped after a failure, stopped after Stop. */
export type WorkflowUnreachedState = "skipped" | "stopped";

/** The state fills of one count, left to right; queued work is the empty track behind them. */
function WorkflowStateFills(props: {
  readonly counts: WorkflowProgressCounts;
  readonly size: number;
  readonly unreached?: WorkflowUnreachedState | undefined;
}) {
  const { counts, size } = props;
  if (size <= 0) return null;
  const started = counts.settled + counts.running;
  const unreached = props.unreached === undefined ? 0 : Math.max(0, size - started);
  return (
    <>
      {workflowCountEntries(counts).map(({ state, count }) =>
        state === "queued" ? null : (
          <span
            key={state}
            className={cn(
              "h-full shrink-0 forced-colors:forced-color-adjust-none",
              WORKFLOW_STATE_SEGMENT[state],
            )}
            style={{ width: `${(count / size) * 100}%` }}
          />
        ),
      )}
      {props.unreached !== undefined && unreached > 0 ? (
        <span
          className={cn(
            "h-full shrink-0 forced-colors:forced-color-adjust-none",
            WORKFLOW_STATE_SEGMENT[props.unreached],
          )}
          style={{ width: `${(unreached / size) * 100}%` }}
          data-workflow-unreached={props.unreached}
        />
      ) : null}
    </>
  );
}

function SettledProgress({ counts }: { readonly counts: WorkflowProgressCounts }) {
  const total = counts.total ?? counts.observed;
  return (
    <progress
      className={cn("absolute inset-0 h-full w-full opacity-0", PROGRESS_CLASS_NAME)}
      aria-label="Workflow tasks settled"
      aria-valuetext={`${workflowSettledText(counts)}; ${workflowCountsText(counts)}`}
      value={total === 0 ? undefined : counts.settled}
      max={total || 1}
    />
  );
}

/** The thin state bar of a Lineage phase row. */
export function WorkflowProgressTrack({
  counts,
  decorative = false,
  className,
}: {
  readonly counts: WorkflowProgressCounts;
  readonly decorative?: boolean;
  readonly className?: string;
}) {
  if (counts.total === 0) return null;
  return (
    // Spans, so the bar can sit inside a button's phrasing content.
    <span
      className={cn("relative block h-1 w-full", className)}
      aria-hidden={decorative || undefined}
      data-workflow-track
    >
      {decorative ? null : <SettledProgress counts={counts} />}
      <span
        aria-hidden="true"
        className={cn(
          // oxlint-disable-next-line shadcn/no-arbitrary-values -- system colors preserve the progress track in forced-colors mode.
          "absolute inset-0 flex overflow-hidden rounded-full bg-border forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-[CanvasText]",
          counts.total === null && "border-r-2 border-dashed border-muted-foreground",
        )}
      >
        <WorkflowStateFills counts={counts} size={counts.total ?? counts.observed} />
      </span>
    </span>
  );
}

/**
 * The workflow block's bar: one segment per phase, sized by its agents. Without declared
 * totals the segments share the width equally and a dashed cap stands for work not yet known.
 */
export function WorkflowPhaseBar(props: {
  readonly counts: WorkflowProgressCounts;
  readonly segments: ReadonlyArray<WorkflowBarSegment>;
  readonly unreached?: WorkflowUnreachedState | undefined;
  readonly thin?: boolean;
}) {
  const { counts, segments } = props;
  const declared = counts.total !== null;
  return (
    <div
      className={cn("relative w-full", props.thin ? "h-1" : "h-2")}
      data-workflow-bar={declared ? "declared" : "unknown"}
    >
      <SettledProgress counts={counts} />
      <div aria-hidden="true" className="absolute inset-0 flex gap-0.5">
        {segments.map((segment) => {
          const summary = `${segment.label}: ${workflowCountsText(segment.counts) || "not started"}`;
          return (
            <Tooltip key={segment.key}>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      // oxlint-disable-next-line shadcn/no-arbitrary-values -- system colors preserve the bar in forced-colors mode.
                      "flex h-full min-w-1.5 overflow-hidden rounded-xs bg-border forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-[CanvasText]",
                    )}
                    // Equal shares when totals are unknown; otherwise each phase's planned agents.
                    style={{ flex: `${declared ? Math.max(segment.size, 1) : 1} 1 0%` }}
                    data-workflow-segment={segment.key}
                    data-workflow-segment-summary={summary}
                  />
                }
              >
                <WorkflowStateFills
                  counts={segment.counts}
                  size={segment.size}
                  unreached={props.unreached}
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{summary}</TooltipPopup>
            </Tooltip>
          );
        })}
        {declared ? null : (
          <span
            className={cn(
              // oxlint-disable-next-line shadcn/no-arbitrary-values -- a system color keeps the cap visible in forced-colors mode.
              "h-full w-6 shrink-0 rounded-r-full border-y border-r border-dashed border-muted-foreground forced-colors:border-[CanvasText]",
            )}
            data-workflow-bar-cap
          />
        )}
      </div>
    </div>
  );
}

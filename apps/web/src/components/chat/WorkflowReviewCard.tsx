import type { ServerProvider } from "@t3tools/contracts";
import {
  workflowReviewNodeLines,
  workflowReviewSteps,
  workflowReviewSummary,
  type WorkflowReviewNodeView,
  type WorkflowReviewPresentation,
  type WorkflowReviewStatus,
  type WorkflowReviewView,
} from "@t3tools/client-runtime/state/workflowReview";
import { WorkflowIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

const STATUS_TONE: Record<WorkflowReviewStatus, string> = {
  ready: "bg-accent/40 text-foreground",
  blocked: "bg-warning/12 text-warning",
  approving: "bg-accent/40 text-muted-foreground",
  dismissing: "bg-accent/40 text-muted-foreground",
  approved: "bg-success/12 text-success",
  dismissed: "bg-muted text-muted-foreground",
  stale: "bg-warning/12 text-warning",
  superseded: "bg-muted text-muted-foreground",
  info: "bg-muted text-muted-foreground",
  "read-only": "bg-accent/40 text-foreground",
};

const NOTE_TONE = {
  info: "text-muted-foreground",
  warning: "text-warning",
  error: "text-destructive",
} as const;

/**
 * The graph the agent reviewed, for the person to approve or dismiss: its tasks by step, what each
 * waits for, the provider and model each runs on, and the server's cost advice. It draws what the
 * shared presentation says; deciding what the buttons may do belongs to `presentWorkflowReview`.
 */
export function WorkflowReviewCard(props: {
  readonly review: WorkflowReviewView;
  readonly presentation: WorkflowReviewPresentation;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly onApprove: () => void;
  readonly onDismiss: () => void;
}) {
  const { review, presentation } = props;
  const summary = workflowReviewSummary(review);
  const title = review.name ?? "Workflow plan";
  const steps = workflowReviewSteps(review);
  const pending = presentation.status === "approving" || presentation.status === "dismissing";
  return (
    <section
      aria-label={`Workflow review: ${title}`}
      aria-busy={pending}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card/40 p-3"
      data-workflow-review
      data-workflow-review-status={presentation.status}
    >
      <header className="flex min-w-0 items-start gap-2">
        <WorkflowIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-2xs font-medium text-muted-foreground">Workflow plan</p>
          <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">{summary.shape}</p>
        </div>
        <span
          role="status"
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium",
            STATUS_TONE[presentation.status],
          )}
        >
          {presentation.statusLabel}
        </span>
      </header>
      {presentation.note ? (
        <p
          role={presentation.note.tone === "error" ? "alert" : undefined}
          className={cn("text-xs", NOTE_TONE[presentation.note.tone])}
        >
          {presentation.note.text}
        </p>
      ) : null}
      {review.blockers.length > 0 ? (
        <ul aria-label="Blockers" className="m-0 list-disc pl-5 text-xs text-warning">
          {review.blockers.map((blocker) => (
            <li key={blocker} className="break-words">
              {blocker}
            </li>
          ))}
          {summary.moreBlockers ? <li>{summary.moreBlockers}</li> : null}
        </ul>
      ) : null}
      {summary.cost || summary.fanOutReasons.length > 0 || summary.writeConflicts ? (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground" data-workflow-advice>
          {summary.cost ? <p>{summary.cost}</p> : null}
          {summary.costBasis ? <p className="text-2xs">{summary.costBasis}</p> : null}
          {summary.fanOutReasons.length > 0 ? (
            <p>One agent may do this for less: {summary.fanOutReasons.join(" ")}</p>
          ) : null}
          {summary.writeConflicts ? <p className="text-warning">{summary.writeConflicts}</p> : null}
        </div>
      ) : null}
      {steps.length > 0 ? (
        <ol
          aria-label="Tasks"
          // A long graph scrolls inside the card, so the decision buttons stay near the plan.
          tabIndex={0}
          className="m-0 flex max-h-[28rem] list-none flex-col gap-2 overflow-y-auto p-0 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {steps.map(({ step, nodes }) => (
            <li key={step} aria-label={`Step ${step}`}>
              <p className="px-2 pb-0.5 text-2xs font-medium text-muted-foreground">Step {step}</p>
              <ul className="m-0 list-none p-0">
                {nodes.map((node) => (
                  <ReviewNodeRow key={node.id} node={node} providers={props.providers} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      ) : null}
      {summary.moreTasks ? (
        <p className="text-xs text-muted-foreground" data-workflow-more-tasks>
          {summary.moreTasks}
        </p>
      ) : null}
      {presentation.approve.visible || presentation.dismiss.visible ? (
        <div role="group" aria-label="Your decision" className="flex flex-wrap items-center gap-2">
          {presentation.approve.visible ? (
            <Button
              type="button"
              size="xs"
              disabled={!presentation.approve.enabled}
              onClick={props.onApprove}
            >
              {presentation.status === "approving" ? <Spinner size="xs" aria-hidden /> : null}
              {presentation.approve.label}
            </Button>
          ) : null}
          {presentation.dismiss.visible ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!presentation.dismiss.enabled}
              onClick={props.onDismiss}
            >
              {presentation.status === "dismissing" ? <Spinner size="xs" aria-hidden /> : null}
              {presentation.dismiss.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ReviewNodeRow(props: {
  readonly node: WorkflowReviewNodeView;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
}) {
  const { node } = props;
  const lines = workflowReviewNodeLines(node, props.providers);
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1.5">
      <span className="min-w-0 break-words text-xs font-medium text-foreground">
        {node.subject}
      </span>
      <span className="min-w-0 break-words text-2xs text-muted-foreground">{lines.runs}</span>
      {lines.after === null ? null : (
        <span className="min-w-0 break-words text-2xs text-muted-foreground">{lines.after}</span>
      )}
    </li>
  );
}

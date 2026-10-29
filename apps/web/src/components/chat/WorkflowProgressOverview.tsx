import {
  workflowCountsText,
  workflowSettledText,
  type deriveWorkflowProgress,
  type WorkflowProgressCounts,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { useState } from "react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PHASE_PAGE_SIZE = 8;
const TASK_PAGE_SIZE = 20;

export function WorkflowProgressOverview(props: {
  readonly progress: ReturnType<typeof deriveWorkflowProgress>;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { progress } = props;
  const [phasePage, setPhasePage] = useState(0);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const filtering = failuresOnly && progress.failedCount > 0;
  const phases = filtering
    ? progress.phases.filter((phase) => phase.counts.failed > 0)
    : progress.phases;
  const page = Math.min(phasePage, Math.max(0, Math.ceil(phases.length / PHASE_PAGE_SIZE) - 1));
  const small = progress.agentCount <= 4;
  return (
    <div className="flex min-w-0 flex-col gap-3" data-workflow-overview>
      <ProgressCounts counts={progress.counts} label="Workflow tasks settled" />
      {progress.failedCount > 0 ? (
        <div>
          <Button
            size="xs"
            variant="outline"
            aria-pressed={filtering}
            onClick={() => {
              setFailuresOnly(!failuresOnly);
              setPhasePage(0);
            }}
          >
            {filtering ? "Show all agents" : `Show failures (${progress.failedCount})`}
          </Button>
        </div>
      ) : null}
      {phases.slice(page * PHASE_PAGE_SIZE, (page + 1) * PHASE_PAGE_SIZE).map((phase) => (
        <section
          key={phase.id}
          aria-label={`${phase.title} phase`}
          className="min-w-0 rounded-md border border-border/60 p-2"
          data-workflow-phase
        >
          <h4 className="mb-1 text-xs font-medium [overflow-wrap:anywhere]">{phase.title}</h4>
          <ProgressCounts counts={phase.counts} label={`${phase.title} tasks settled`} />
          <TaskDetails
            key={`${phase.id}:${filtering}`}
            tasks={phase.tasks}
            expanded={small || filtering}
            failuresOnly={filtering}
            onOpenThread={props.onOpenThread}
          />
        </section>
      ))}
      <PageControls
        page={page}
        pages={Math.ceil(phases.length / PHASE_PAGE_SIZE)}
        label="phases"
        onChange={setPhasePage}
      />
    </div>
  );
}

function ProgressCounts(props: {
  readonly counts: WorkflowProgressCounts;
  readonly label: string;
}) {
  const { counts } = props;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-2xs tabular-nums text-muted-foreground">
      <p>{workflowSettledText(counts)}</p>
      {counts.total !== null && counts.total > 0 ? (
        <progress
          className={cn("block h-1.5 w-full", PROGRESS_CLASS_NAME)}
          aria-label={props.label}
          aria-valuetext={`${workflowSettledText(counts)}; ${workflowCountsText(counts)}`}
          value={counts.settled}
          max={counts.total}
        />
      ) : null}
      <p className={counts.failed > 0 ? "text-destructive-foreground" : undefined}>
        {workflowCountsText(counts) || "No agents started"}
      </p>
    </div>
  );
}

function TaskDetails(props: {
  readonly tasks: ReadonlyArray<WorkflowTaskProgress>;
  readonly expanded: boolean;
  readonly failuresOnly: boolean;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(props.expanded);
  const [taskPage, setTaskPage] = useState(0);
  const tasks = props.failuresOnly
    ? props.tasks.filter((task) => task.state === "failed")
    : props.tasks;
  const page = Math.min(taskPage, Math.max(0, Math.ceil(tasks.length / TASK_PAGE_SIZE) - 1));
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
        {open ? "Hide agents" : `Show agents (${tasks.length})`}
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        {open ? (
          <>
            <ul className="m-0 list-none p-0">
              {tasks.slice(page * TASK_PAGE_SIZE, (page + 1) * TASK_PAGE_SIZE).map((task) => (
                <TaskRow key={task.id} task={task} onOpenThread={props.onOpenThread} />
              ))}
            </ul>
            <PageControls
              page={page}
              pages={Math.ceil(tasks.length / TASK_PAGE_SIZE)}
              label="agents"
              onChange={setTaskPage}
            />
          </>
        ) : null}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function TaskRow(props: {
  readonly task: WorkflowTaskProgress;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { task } = props;
  const threadId = task.member?.childThreadId;
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{task.label}</span>
        {task.detail ? (
          <span className="block truncate text-2xs text-muted-foreground">{task.detail}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "shrink-0 text-2xs capitalize",
          task.state === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {task.state}
      </span>
    </>
  );
  const className = "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left";
  return (
    <li data-workflow-task>
      <Tooltip>
        <TooltipTrigger
          render={
            threadId ? (
              <button
                type="button"
                aria-label={`Open ${task.label}`}
                aria-description={task.state}
                className={cn(
                  className,
                  "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
                onClick={() => props.onOpenThread(threadId)}
              />
            ) : (
              <div tabIndex={task.detail ? 0 : undefined} className={className} />
            )
          }
        >
          {body}
        </TooltipTrigger>
        {task.detail ? (
          <TooltipPopup>
            <div className="max-h-60 overflow-auto whitespace-pre-wrap">{task.detail}</div>
          </TooltipPopup>
        ) : null}
      </Tooltip>
    </li>
  );
}

function PageControls(props: {
  readonly page: number;
  readonly pages: number;
  readonly label: string;
  readonly onChange: (page: number) => void;
}) {
  if (props.pages <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="xs"
        variant="outline"
        disabled={props.page === 0}
        onClick={() => props.onChange(props.page - 1)}
      >
        Previous {props.label}
      </Button>
      <span className="text-2xs tabular-nums text-muted-foreground">
        Page {props.page + 1} of {props.pages}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={props.page + 1 === props.pages}
        onClick={() => props.onChange(props.page + 1)}
      >
        More {props.label}
      </Button>
    </div>
  );
}

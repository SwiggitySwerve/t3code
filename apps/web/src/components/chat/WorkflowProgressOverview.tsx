import {
  workflowCountEntries,
  workflowCountsText,
  workflowSettledText,
  type deriveWorkflowProgress,
  type WorkflowProgressCounts,
  type WorkflowPhaseProgress,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { workflowMemberIdentity } from "@t3tools/client-runtime/state/subagentRuntime";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { WorkflowAgentIdentity } from "./WorkflowAgentIdentity";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";

const PHASE_PAGE_SIZE = 24;
const TASK_PAGE_SIZE = 20;

export function WorkflowProgressOverview(props: {
  readonly progress: ReturnType<typeof deriveWorkflowProgress>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { progress } = props;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
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
      <div className="flex min-w-0 flex-col gap-1 text-2xs tabular-nums text-muted-foreground">
        <p>{workflowSettledText(progress.counts)}</p>
        <ProgressTrack counts={progress.counts} label="Workflow tasks settled" />
        <CountLabels counts={progress.counts} />
      </div>
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
      <div className="flex min-w-0 flex-col gap-1">
        {phases.slice(page * PHASE_PAGE_SIZE, (page + 1) * PHASE_PAGE_SIZE).map((phase) => (
          <PhaseDetails
            key={`${phase.id}:${filtering}`}
            phase={phase}
            providers={providers}
            expanded={small || filtering}
            failuresOnly={filtering}
            onOpenThread={props.onOpenThread}
          />
        ))}
      </div>
      <PageControls
        page={page}
        pages={Math.ceil(phases.length / PHASE_PAGE_SIZE)}
        label="phases"
        onChange={setPhasePage}
      />
    </div>
  );
}

function CountLabels({
  counts,
  compact = false,
}: {
  readonly counts: WorkflowProgressCounts;
  readonly compact?: boolean;
}) {
  const entries = workflowCountEntries(counts);
  return (
    <span className="flex flex-wrap gap-x-1 text-2xs font-normal tabular-nums text-muted-foreground">
      {entries.length === 0
        ? "No agents started"
        : entries.map(({ state, count }, index) => (
            <span key={state}>
              {index > 0 ? <span aria-hidden>· </span> : null}
              <span className={state === "failed" ? "text-destructive-foreground" : undefined}>
                {compact && counts.total !== null && count === counts.total && state === "done"
                  ? `${count}/${counts.total} done`
                  : `${count} ${state}`}
              </span>
            </span>
          ))}
      {compact && counts.total === null ? <span>· total unknown</span> : null}
    </span>
  );
}

const SEGMENT_CLASS = {
  done: "bg-primary forced-colors:bg-[Highlight]",
  failed:
    "bg-destructive-foreground text-background/70 bg-[repeating-linear-gradient(135deg,transparent_0px,transparent_3px,currentColor_3px,currentColor_4px)] forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]",
  running:
    "bg-primary/35 forced-colors:bg-[Canvas] forced-colors:border-y forced-colors:border-[Highlight]",
  stopped:
    "bg-muted-foreground/35 border-y border-dashed border-muted-foreground forced-colors:bg-[Canvas] forced-colors:border-[CanvasText]",
  skipped:
    "bg-muted-foreground/35 border-y border-dotted border-muted-foreground forced-colors:bg-[Canvas] forced-colors:border-[CanvasText]",
} as const;

function ProgressTrack(props: { readonly counts: WorkflowProgressCounts; readonly label: string }) {
  const { counts } = props;
  const total = counts.total;
  if (total === null || total === 0) return null;
  return (
    <div className="relative h-1.5 w-full">
      <progress
        className={cn("absolute inset-0 h-full w-full opacity-0", PROGRESS_CLASS_NAME)}
        aria-label={props.label}
        aria-valuetext={`${workflowSettledText(counts)}; ${workflowCountsText(counts)}`}
        value={counts.settled}
        max={total}
      />
      <div
        aria-hidden="true"
        // oxlint-disable-next-line shadcn/no-arbitrary-values -- system colors preserve the track in forced-colors mode, like the native progress primitive.
        className="absolute inset-0 flex overflow-hidden rounded-full bg-muted forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-[CanvasText]"
      >
        {workflowCountEntries(counts).map(({ state, count }) =>
          state === "queued" ? null : (
            <span
              key={state}
              className={cn(
                "h-full shrink-0 forced-colors:forced-color-adjust-none",
                SEGMENT_CLASS[state],
              )}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ),
        )}
      </div>
    </div>
  );
}

function PhaseDetails(props: {
  readonly phase: WorkflowPhaseProgress;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly expanded: boolean;
  readonly failuresOnly: boolean;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { phase } = props;
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const open = expanded ?? (props.expanded && !phase.allDone);
  const [taskPage, setTaskPage] = useState(0);
  const tasks = props.failuresOnly
    ? phase.tasks.filter((task) => task.state === "failed")
    : phase.tasks;
  const page = Math.min(taskPage, Math.max(0, Math.ceil(tasks.length / TASK_PAGE_SIZE) - 1));
  return (
    <section
      aria-label={`${phase.title} phase`}
      className="min-w-0 rounded-md border border-border/60 px-2 py-1"
      data-workflow-phase
    >
      <Collapsible open={open} onOpenChange={setExpanded}>
        <h4>
          <CollapsibleTrigger
            aria-label={`${phase.title} agents`}
            aria-description={workflowCountsText(phase.counts)}
            render={
              <button
                type="button"
                className="flex w-full min-w-0 items-start gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("mt-0.5 size-3 shrink-0", open && "rotate-90")}
            />
            <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
              <span className="text-xs font-medium [overflow-wrap:anywhere]">{phase.title}</span>
              <CountLabels counts={phase.counts} compact />
            </span>
          </CollapsibleTrigger>
        </h4>
        <div className="mt-1">
          <ProgressTrack counts={phase.counts} label={`${phase.title} tasks settled`} />
        </div>
        <CollapsiblePanel animate={false}>
          {open ? (
            <>
              <ul className="m-0 list-none p-0">
                {tasks.slice(page * TASK_PAGE_SIZE, (page + 1) * TASK_PAGE_SIZE).map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    provider={props.providers?.find(
                      (provider) => provider.instanceId === task.member?.providerInstanceId,
                    )}
                    onOpenThread={props.onOpenThread}
                  />
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
    </section>
  );
}

function TaskRow(props: {
  readonly task: WorkflowTaskProgress;
  readonly provider: ServerProvider | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { task } = props;
  const threadId = task.member?.childThreadId;
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium">
          <WorkflowAgentIdentity
            member={task.member}
            provider={props.provider}
            label={task.label}
          />
        </span>
        {task.detail ? (
          <span className="block truncate text-2xs text-muted-foreground">{task.detail}</span>
        ) : null}
      </span>
      <span
        className={cn(
          "flex shrink-0 items-baseline gap-1 text-2xs capitalize",
          task.state === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {task.state}
        {task.state === "running" && task.member !== null ? (
          <AgentElapsed agent={task.member} />
        ) : null}
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
                aria-description={[
                  task.state,
                  props.provider?.displayName,
                  workflowMemberIdentity(task.member),
                ]
                  .filter(Boolean)
                  .join(", ")}
                className={cn(
                  className,
                  "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                )}
                onClick={() => props.onOpenThread(threadId)}
              />
            ) : (
              <div tabIndex={0} className={className} />
            )
          }
        >
          {body}
        </TooltipTrigger>
        <TooltipPopup>
          <p>
            {props.provider?.displayName ?? task.member?.providerInstanceId ?? "Unknown provider"} ·{" "}
            {workflowMemberIdentity(task.member)}
          </p>
          {task.detail ? (
            <div className="max-h-60 overflow-auto whitespace-pre-wrap">{task.detail}</div>
          ) : null}
        </TooltipPopup>
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

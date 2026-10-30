import {
  workflowCountEntries,
  workflowCountsText,
  workflowSettledText,
  workflowMemberIdentity,
  type deriveWorkflowProgress,
  type WorkflowProgressCounts,
  type WorkflowPhaseProgress,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { resolveModelGlyph, normalizeModelSlug } from "@t3tools/shared/model";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { WorkflowAgentIdentity } from "./WorkflowAgentIdentity";
import { Button } from "../ui/button";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipCreateHandle, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WORKFLOW_STATE_MARKER,
  WORKFLOW_STATE_SEGMENT,
  WORKFLOW_STATE_TEXT,
} from "./workflowStatusAppearance";

const PHASE_PAGE_SIZE = 32;
const MODEL_ICON_LIMIT = 3;

export function WorkflowProgressOverview(props: {
  readonly progress: ReturnType<typeof deriveWorkflowProgress>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { progress } = props;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const [phasePage, setPhasePage] = useState(0);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [tooltip] = useState(() => TooltipCreateHandle<ReactNode>());
  const filtering = failuresOnly && progress.failedCount > 0;
  const phases = filtering
    ? progress.phases.filter((phase) => phase.counts.failed > 0)
    : progress.phases;
  const pages = Math.ceil(phases.length / PHASE_PAGE_SIZE);
  const page = Math.min(phasePage, Math.max(0, pages - 1));
  return (
    <div className="flex min-w-0 flex-col gap-3" data-workflow-overview>
      <div className="flex min-w-0 flex-col gap-1 text-2xs tabular-nums text-muted-foreground">
        <p>{workflowSettledText(progress.counts)}</p>
        <ProgressTrack counts={progress.counts} />
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
      <div
        className="grid min-w-0 items-start gap-2"
        style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 13rem), 1fr))" }}
        data-workflow-phases
      >
        {phases.slice(page * PHASE_PAGE_SIZE, (page + 1) * PHASE_PAGE_SIZE).map((phase) => (
          <PhaseDots
            key={`${phase.id}:${filtering}`}
            phase={phase}
            providers={providers}
            failuresOnly={filtering}
            tooltip={tooltip}
            onOpenThread={props.onOpenThread}
          />
        ))}
      </div>
      {pages > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPhasePage(page - 1)}
          >
            Previous phases
          </Button>
          <span className="text-2xs tabular-nums text-muted-foreground">
            Page {page + 1} of {pages}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={page + 1 === pages}
            onClick={() => setPhasePage(page + 1)}
          >
            More phases
          </Button>
        </div>
      ) : null}
      <Tooltip handle={tooltip}>
        {({ payload }) =>
          payload === undefined ? null : <TooltipPopup role="tooltip">{payload}</TooltipPopup>
        }
      </Tooltip>
    </div>
  );
}

function CountLabels({ counts }: { readonly counts: WorkflowProgressCounts }) {
  const entries = workflowCountEntries(counts);
  return (
    <span className="flex flex-wrap gap-x-1 text-2xs font-normal tabular-nums text-muted-foreground">
      {entries.length === 0
        ? "No agents started"
        : entries.map(({ state, count }, index) => (
            <span key={state}>
              {index > 0 ? <span aria-hidden>· </span> : null}
              <span className={WORKFLOW_STATE_TEXT[state]}>
                {count} {state}
              </span>
            </span>
          ))}
      {counts.total === null ? <span>· total unknown</span> : null}
    </span>
  );
}

function ProgressTrack({ counts }: { readonly counts: WorkflowProgressCounts }) {
  const total = counts.total;
  if (total === null || total === 0) return null;
  return (
    <div className="relative h-1.5 w-full">
      <progress
        className={cn("absolute inset-0 h-full w-full opacity-0", PROGRESS_CLASS_NAME)}
        aria-label="Workflow tasks settled"
        aria-valuetext={`${workflowSettledText(counts)}; ${workflowCountsText(counts)}`}
        value={counts.settled}
        max={total}
      />
      <div
        aria-hidden="true"
        // oxlint-disable-next-line shadcn/no-arbitrary-values -- system colors preserve the progress track in forced-colors mode.
        className="absolute inset-0 flex overflow-hidden rounded-full bg-muted forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-[CanvasText]"
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

function PhaseDots(props: {
  readonly phase: WorkflowPhaseProgress;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly failuresOnly: boolean;
  readonly tooltip: ReturnType<typeof TooltipCreateHandle<ReactNode>>;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { phase } = props;
  const headingId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const tasks = props.failuresOnly
    ? phase.tasks.filter((task) => task.state === "failed")
    : phase.tasks;
  const active = tasks.some((task) => task.id === activeId) ? activeId : tasks[0]?.id;
  const models = new Map<
    string,
    { task: WorkflowTaskProgress; provider: ServerProvider | undefined; label: string }
  >();
  for (const task of phase.tasks) {
    if (task.member === null) continue;
    const provider = props.providers.find(
      (entry) => entry.instanceId === task.member?.providerInstanceId,
    );
    const driver = provider?.driver ?? task.member.driver;
    const glyph = resolveModelGlyph(task.member.model, driver);
    const model = normalizeModelSlug(task.member.model, driver) ?? "unknown";
    const key = glyph?.modelId ?? `${task.member.providerInstanceId}:${model}`;
    if (!models.has(key))
      models.set(key, {
        task,
        provider,
        label: workflowMemberIdentity(task.member),
      });
  }
  const identities = [...models.entries()];
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.altKey ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)
    )
      return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-workflow-dot]"),
    ];
    const index = buttons.findIndex((button) => button === event.target);
    if (index < 0) return;
    event.preventDefault();
    const columns = getComputedStyle(event.currentTarget).gridTemplateColumns.split(" ").length;
    const step =
      event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp"
            ? -columns
            : columns;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : Math.max(0, Math.min(buttons.length - 1, index + step));
    buttons[next]?.focus();
  }
  return (
    <section
      aria-label={`${phase.title} phase`}
      aria-description={[
        phase.state,
        workflowSettledText(phase.counts),
        workflowCountsText(phase.counts),
      ]
        .filter(Boolean)
        .join(" · ")}
      className="min-w-0 rounded-md border border-border bg-card/30 p-2"
      data-workflow-phase
    >
      <header className="mb-1 flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h4
            id={headingId}
            className="min-w-0 flex-1 text-xs font-medium [overflow-wrap:anywhere]"
          >
            {phase.title}
            {phase.state === null ? "" : ` · ${phase.state}`}
          </h4>
          <span className="flex shrink-0 items-center gap-1" aria-label="Phase models">
            {identities.slice(0, MODEL_ICON_LIMIT).map(([key, { task, provider, label }]) => (
              <TooltipTrigger
                key={key}
                handle={props.tooltip}
                payload={label}
                render={<span tabIndex={-1} />}
              >
                <WorkflowAgentIdentity member={task.member} provider={provider} />
              </TooltipTrigger>
            ))}
            {identities.length > MODEL_ICON_LIMIT ? (
              <TooltipTrigger
                handle={props.tooltip}
                payload={identities
                  .slice(MODEL_ICON_LIMIT)
                  .map(([, model]) => model.label)
                  .join(", ")}
                render={<span tabIndex={-1} />}
                className="text-3xs text-muted-foreground"
                aria-label={`${identities.length - MODEL_ICON_LIMIT} more models: ${identities
                  .slice(MODEL_ICON_LIMIT)
                  .map(([, model]) => model.label)
                  .join(", ")}`}
              >
                +{identities.length - MODEL_ICON_LIMIT}
              </TooltipTrigger>
            ) : null}
          </span>
        </div>
        <CountLabels counts={phase.counts} />
      </header>
      <div
        role="toolbar"
        aria-labelledby={headingId}
        aria-description="Use arrow keys to move between agents. Home and End move to the first and last agent. Enter opens its thread."
        className="grid min-w-0"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(1.5rem, 1fr))" }}
        onKeyDown={moveFocus}
        data-workflow-dots
      >
        {tasks.map((task) => {
          const provider = props.providers.find(
            (entry) => entry.instanceId === task.member?.providerInstanceId,
          );
          return (
            <WorkflowTaskDot
              key={task.id}
              id={task.id}
              label={task.label}
              state={task.state}
              detail={task.detail}
              identity={workflowMemberIdentity(task.member)}
              providerName={
                provider?.displayName ?? task.member?.providerInstanceId ?? "Unknown provider"
              }
              threadId={task.member?.childThreadId ?? null}
              active={task.id === active}
              tooltip={props.tooltip}
              onFocus={setActiveId}
              onOpenThread={props.onOpenThread}
            />
          );
        })}
      </div>
    </section>
  );
}

function WorkflowTaskDot(props: {
  readonly id: string;
  readonly label: string;
  readonly state: WorkflowTaskProgress["state"];
  readonly detail: string | null;
  readonly identity: string;
  readonly providerName: string;
  readonly threadId: string | null;
  readonly active: boolean;
  readonly tooltip: ReturnType<typeof TooltipCreateHandle<ReactNode>>;
  readonly onFocus: (id: string) => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const {
    id,
    label,
    state,
    detail,
    identity,
    providerName,
    threadId,
    active,
    tooltip,
    onFocus,
    onOpenThread,
  } = props;
  return (
    <TooltipTrigger
      handle={tooltip}
      delay={200}
      payload={
        <>
          <p className="font-medium">
            {label} · {state}
          </p>
          <p>
            {providerName} · {identity}
          </p>
          {detail ? <p className="max-h-60 overflow-auto whitespace-pre-wrap">{detail}</p> : null}
          {threadId ? null : <p>Thread not available yet</p>}
        </>
      }
      render={
        <button
          type="button"
          data-workflow-dot={id}
          data-workflow-state={state}
          tabIndex={active ? 0 : -1}
          aria-label={`Open ${label}`}
          aria-description={[
            state,
            providerName,
            identity,
            threadId ? null : "Thread not available yet",
          ]
            .filter(Boolean)
            .join(", ")}
          aria-disabled={!threadId}
          onFocus={() => onFocus(id)}
          onClick={() => {
            if (threadId) onOpenThread(threadId);
          }}
          className="flex size-6 items-center justify-center rounded-sm hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-disabled:cursor-default"
        />
      }
    >
      <span
        aria-hidden
        className={cn(
          "size-2.5 shrink-0 forced-colors:forced-color-adjust-none",
          WORKFLOW_STATE_MARKER[state],
        )}
      />
    </TooltipTrigger>
  );
}

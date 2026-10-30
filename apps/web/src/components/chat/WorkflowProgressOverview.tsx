import {
  workflowCountEntries,
  workflowCountsText,
  workflowSettledText,
  type deriveWorkflowProgress,
  type WorkflowProgressCounts,
  type WorkflowPhaseProgress,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { memo, useId, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import {
  WorkflowAgentIdentity,
  WorkflowIdentityGlyph,
  workflowIdentityGlyphProps,
  type WorkflowIdentityGlyphProps,
  WorkflowIdentitySymbols,
  type WorkflowIdentitySprite,
} from "./WorkflowAgentIdentity";
import {
  resolveWorkflowIdentity,
  type WorkflowIdentity,
  type WorkflowIdentityIcon,
} from "./workflowIdentity";
import { Button } from "../ui/button";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { cn } from "../../lib/utils";
import {
  WORKFLOW_STATE_CUE,
  workflowIdentityStateClass,
  WORKFLOW_STATE_MARKER,
  WORKFLOW_STATE_SEGMENT,
  WORKFLOW_STATE_TEXT,
} from "./workflowStatusAppearance";

const PHASE_PAGE_SIZE = 32;
export const WORKFLOW_AGENT_PITCH = 24;

export function WorkflowProgressOverview(props: {
  readonly progress: ReturnType<typeof deriveWorkflowProgress>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { progress } = props;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const [phasePage, setPhasePage] = useState(0);
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const prefix = useId();
  const readoutId = useId();
  const filtering = failuresOnly && progress.failedCount > 0;
  const phases = filtering
    ? progress.phases.filter((phase) => phase.counts.failed > 0)
    : progress.phases;
  const pages = Math.ceil(phases.length / PHASE_PAGE_SIZE);
  const page = Math.min(phasePage, Math.max(0, pages - 1));
  const byProvider = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const cache = new Map<string, WorkflowIdentity>();
  const identities = new Map<string, WorkflowIdentity>();
  const observed = new Map<string, WorkflowIdentity>();
  const icons = new Map<string, Exclude<WorkflowIdentityIcon, { kind: "glyph" }>>();
  const generic = resolveWorkflowIdentity(null, undefined);
  if (generic.icon.kind !== "glyph") icons.set(generic.icon.key, generic.icon);
  let inspectedTask: WorkflowTaskProgress | undefined;
  for (const phase of progress.phases)
    for (const task of phase.tasks) {
      const member = task.member;
      const provider = member?.providerInstanceId
        ? byProvider.get(member.providerInstanceId)
        : undefined;
      const cacheKey = JSON.stringify([
        member?.providerInstanceId,
        member?.driver,
        member?.model,
        member === null || task.state === "queued",
      ]);
      let identity = cache.get(cacheKey);
      if (!identity) {
        identity = resolveWorkflowIdentity(member, provider, task.state);
        cache.set(cacheKey, identity);
      }
      identities.set(task.id, identity);
      if (member && task.state !== "queued" && !observed.has(identity.key))
        observed.set(identity.key, identity);
      if (identity.icon.kind !== "glyph") icons.set(identity.icon.key, identity.icon);
      if (task.id === inspectedId) inspectedTask = task;
    }
  const sprite = new Map([...icons.keys()].map((key, index) => [key, `${prefix}-icon-${index}`]));
  const legend = [...observed.values()];
  const inspectedIdentity = inspectedTask ? identities.get(inspectedTask.id) : undefined;
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      style={{ "--workflow-agent-pitch": `${WORKFLOW_AGENT_PITCH}px` } as CSSProperties}
      data-workflow-overview
      onKeyDown={(event) => {
        if (event.key === "Escape") setInspectedId(null);
      }}
    >
      <WorkflowIdentitySymbols icons={[...icons.values()]} sprite={sprite} />
      <div className="flex min-w-0 flex-col gap-1 text-2xs tabular-nums text-muted-foreground">
        <p>{workflowSettledText(progress.counts)}</p>
        <ProgressTrack counts={progress.counts} />
        <CountLabels counts={progress.counts} />
        {legend.length >= 2 ? (
          <div
            aria-label="Agent models"
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
            data-workflow-legend
          >
            {legend.slice(0, 4).map((identity) => (
              <span
                key={identity.key}
                aria-label={`${identity.providerName} · ${identity.modelName}`}
                className="inline-flex min-w-0 items-center gap-1"
              >
                <WorkflowAgentIdentity
                  member={null}
                  provider={undefined}
                  identity={identity}
                  sprite={sprite}
                />
                <span className="break-words">{identity.displayName}</span>
              </span>
            ))}
            {legend.length > 4 ? (
              <span data-workflow-legend-overflow>
                <span aria-hidden>+{legend.length - 4}</span>
                <span className="sr-only">{`${legend.length - 4} more models: ${legend
                  .slice(4)
                  .map((identity) => `${identity.providerName} · ${identity.modelName}`)
                  .join(", ")}`}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {inspectedTask && inspectedIdentity ? (
        <div
          id={readoutId}
          role="note"
          aria-label="Agent details"
          className="pointer-events-none fixed inset-x-4 bottom-4 z-50 mx-auto max-w-(--chat-content-max-width) rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          data-workflow-readout
        >
          <p className={cn("font-medium", WORKFLOW_STATE_TEXT[inspectedTask.state])}>
            {inspectedTask.label} · {inspectedTask.state}
          </p>
          <p>
            {inspectedIdentity.providerName} · {inspectedIdentity.modelName}
          </p>
          {inspectedTask.detail ? (
            <p className="line-clamp-3 whitespace-pre-wrap">{inspectedTask.detail}</p>
          ) : null}
          {inspectedTask.member?.childThreadId ? null : <p>Thread not available yet</p>}
        </div>
      ) : null}
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
          <PhaseAgents
            key={`${phase.id}:${filtering}`}
            phase={phase}
            identities={identities}
            sprite={sprite}
            generic={generic}
            failuresOnly={filtering}
            onInspect={setInspectedId}
            readoutId={readoutId}
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

function ProgressTrack({
  counts,
  decorative = false,
}: {
  readonly counts: WorkflowProgressCounts;
  readonly decorative?: boolean;
}) {
  const total = counts.total ?? counts.observed;
  if (counts.total === 0) return null;
  return (
    <div className="relative h-1 w-full" aria-hidden={decorative || undefined}>
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
          "absolute inset-0 flex overflow-hidden rounded-full bg-muted forced-colors:bg-[Canvas] forced-colors:outline forced-colors:outline-[CanvasText]",
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

function PhaseAgents(props: {
  readonly phase: WorkflowPhaseProgress;
  readonly identities: ReadonlyMap<string, WorkflowIdentity>;
  readonly sprite: WorkflowIdentitySprite;
  readonly generic: WorkflowIdentity;
  readonly failuresOnly: boolean;
  readonly readoutId: string;
  readonly onInspect: (id: string | null) => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { phase } = props;
  const headingId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const tasks = props.failuresOnly
    ? phase.tasks.filter((task) => task.state === "failed")
    : phase.tasks;
  const active = tasks.some((task) => task.id === activeId) ? activeId : tasks[0]?.id;
  const notStarted = props.failuresOnly
    ? 0
    : Math.max(0, (phase.counts.total ?? phase.counts.observed) - phase.counts.observed);
  function inspect(target: EventTarget | null, focused = false) {
    const button =
      target instanceof Element ? target.closest<HTMLButtonElement>("[data-workflow-dot]") : null;
    const id = button?.dataset.workflowDot;
    if (id) {
      props.onInspect(id);
      if (focused) setActiveId(id);
    }
  }
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
      <header className="mb-1 flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
          <h4 id={headingId} className="min-w-0 text-xs font-medium [overflow-wrap:anywhere]">
            {phase.title}
            {phase.state === null ? "" : ` · ${phase.state}`}
          </h4>
          <CountLabels counts={phase.counts} />
        </div>
        {notStarted > 0 ? (
          <p className="text-2xs text-muted-foreground">{notStarted} not started</p>
        ) : null}
        <ProgressTrack counts={phase.counts} decorative />
      </header>
      <div
        role="toolbar"
        aria-labelledby={headingId}
        aria-description="Use arrow keys to move between agents. Home and End move to the first and last agent. Enter opens its thread."
        className="grid min-w-0"
        style={{ gridTemplateColumns: "repeat(auto-fill, var(--workflow-agent-pitch))" }}
        onKeyDown={moveFocus}
        onPointerOver={(event) => inspect(event.target)}
        onFocus={(event) => inspect(event.target, true)}
        onPointerLeave={(event) => {
          if (!event.currentTarget.contains(document.activeElement)) props.onInspect(null);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) props.onInspect(null);
        }}
        data-workflow-dots
      >
        {tasks.map((task) => {
          const identity = props.identities.get(task.id)!;
          return (
            <WorkflowTaskIcon
              key={task.id}
              id={task.id}
              label={task.label}
              state={task.state}
              threadId={task.member?.childThreadId ?? null}
              providerName={identity.providerName}
              modelName={identity.modelName}
              {...workflowIdentityGlyphProps(identity, props.sprite)}
              active={task.id === active}
              readoutId={props.readoutId}
              onOpenThread={props.onOpenThread}
            />
          );
        })}
        {Array.from({ length: notStarted }, (_, index) => (
          <span
            key={index}
            aria-hidden
            className="flex size-(--workflow-agent-pitch) items-center justify-center opacity-40"
            data-workflow-placeholder
          >
            <WorkflowAgentIdentity
              member={null}
              provider={undefined}
              identity={props.generic}
              sprite={props.sprite}
              grid
            />
          </span>
        ))}
      </div>
    </section>
  );
}

// Compiler reuses the cell's contents; memo also skips unchanged children created inside the map.
const WorkflowTaskIcon = memo(function WorkflowTaskIcon(
  props: WorkflowIdentityGlyphProps & {
    readonly id: string;
    readonly label: string;
    readonly state: WorkflowTaskProgress["state"];
    readonly threadId: string | null;
    readonly providerName: string;
    readonly modelName: string;
    readonly active: boolean;
    readonly readoutId: string;
    readonly onOpenThread: (threadId: string) => void;
  },
) {
  const { threadId, state } = props;
  const badge = WORKFLOW_STATE_CUE[state].badge;
  return (
    <button
      type="button"
      data-workflow-dot={props.id}
      data-workflow-state={state}
      tabIndex={props.active ? 0 : -1}
      aria-label={`Open ${props.label}`}
      aria-description={[
        state,
        props.providerName,
        props.modelName,
        threadId ? null : "Thread not available yet",
      ]
        .filter(Boolean)
        .join(", ")}
      aria-details={props.readoutId}
      aria-disabled={!threadId}
      onClick={() => {
        if (threadId) props.onOpenThread(threadId);
      }}
      className={cn(
        "relative flex size-(--workflow-agent-pitch) items-center justify-center rounded-sm hover:bg-accent/30 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-disabled:cursor-default",
        workflowIdentityStateClass(state),
      )}
    >
      <WorkflowIdentityGlyph
        kind={props.kind}
        glyph={props.glyph}
        family={props.family}
        iconLabel={props.iconLabel}
        light={props.light}
        dark={props.dark}
        symbol={props.symbol}
        grid
      />
      {badge === "!" ? (
        <span
          aria-hidden
          className={cn(
            "absolute bottom-0 right-0 flex size-2.5 items-center justify-center rounded-full bg-destructive-foreground text-4xs font-bold leading-none text-background",
          )}
        >
          !
        </span>
      ) : badge === "square" ? (
        <span
          aria-hidden
          className={cn(
            "absolute bottom-0.5 right-0.5 size-1 ring-1 ring-card forced-colors:forced-color-adjust-none",
            WORKFLOW_STATE_MARKER.stopped,
          )}
        />
      ) : null}
    </button>
  );
});

import {
  deriveWorkflowBarSegments,
  deriveWorkflowPhaseGroups,
  EMPTY_WORKFLOW_PHASE_GROUP_MEMORY,
  workflowCountEntries,
  workflowCountsText,
  workflowPhaseStatus,
  workflowSettledText,
  type deriveWorkflowProgress,
  type WorkflowPhaseGroup,
  type WorkflowProgressCounts,
  type WorkflowPhaseProgress,
  type WorkflowTaskProgress,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { ChevronRightIcon } from "lucide-react";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { WorkflowAgentReadout } from "./WorkflowAgentReadout";
import { WorkflowIdentityStack } from "./WorkflowIdentityStack";
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
import { cn } from "../../lib/utils";
import {
  WORKFLOW_STATE_CUE,
  workflowIdentityStateClass,
  WORKFLOW_STATE_MARKER,
  WORKFLOW_STATE_TEXT,
} from "./workflowStatusAppearance";
import { WorkflowPhaseBar, type WorkflowUnreachedState } from "./WorkflowProgressTrack";

const PHASE_PAGE_SIZE = 32;
const WORKFLOW_AGENT_PITCH = 24;

type WorkflowProgress = ReturnType<typeof deriveWorkflowProgress>;

/** What a settled workflow did with the work it never reached. */
function unreachedState(progress: WorkflowProgress): WorkflowUnreachedState | undefined {
  if (!progress.terminal) return undefined;
  if (progress.status === "failed") return "skipped";
  if (progress.status === "cancelled" || progress.status === "interrupted") return "stopped";
  return undefined;
}

type MarkerState = keyof typeof WORKFLOW_STATE_MARKER;

function phaseMarker(
  phase: WorkflowPhaseProgress,
  unreached: WorkflowUnreachedState | undefined,
): MarkerState {
  const status = workflowPhaseStatus(phase);
  return status === "not started" ? (unreached ?? "queued") : status;
}

function groupMarker(
  group: WorkflowPhaseGroup,
  unreached: WorkflowUnreachedState | undefined,
): MarkerState {
  switch (group.kind) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "settled":
      return "stopped";
    case "queued":
      return unreached ?? "queued";
    case null:
      return phaseMarker(group.phases[0]!, unreached);
  }
}

function StateMarker({ state }: { readonly state: MarkerState }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-1 size-2 shrink-0 forced-colors:forced-color-adjust-none",
        WORKFLOW_STATE_MARKER[state],
      )}
      data-workflow-marker={state}
    />
  );
}

/** "182 of 256 agents" with a declared total; otherwise the agents done so far. */
function headlineText(counts: WorkflowProgressCounts): string {
  const noun = (count: number) => (count === 1 ? "agent" : "agents");
  return counts.total === null
    ? `${counts.done} ${noun(counts.done)} done`
    : `${counts.done} of ${counts.total} ${noun(counts.total)}`;
}

/**
 * The percentage (declared totals only), failures, and which phase runs. Graph waves are
 * dependency depth rather than sequential steps, so a running phase is named, never numbered.
 */
function headlineDetail(progress: WorkflowProgress): string {
  const { counts } = progress;
  const running = progress.phases.filter(
    (phase) => phase.id !== "other" && (phase.counts.running > 0 || phase.state === "running"),
  );
  return [
    counts.total !== null && counts.total > 0
      ? `${Math.floor((counts.done / counts.total) * 100)}%`
      : null,
    counts.failed > 0 ? `${counts.failed} failed` : null,
    running.length === 1
      ? `${running[0]!.title} running`
      : running.length > 1
        ? `${running.length} phases running`
        : null,
    counts.total === null ? `${counts.observed} discovered · total unknown` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function WorkflowProgressOverview(props: {
  readonly progress: WorkflowProgress;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { progress } = props;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const [phasePage, setPhasePage] = useState(0);
  // Kept per phase, so a disclosure stays open while phases join or leave its run.
  const [expandedPhases, setExpandedPhases] = useState<ReadonlySet<string>>(new Set());
  // Unset until toggled: a clean finish starts folded, a failed or stopped run starts open.
  const [receiptChoice, setReceiptExpanded] = useState<boolean | null>(null);
  const receiptExpanded = receiptChoice ?? !progress.successful;
  const [allAttention, setAllAttention] = useState(false);
  const showPhases = !progress.terminal || receiptExpanded;
  const unreached = unreachedState(progress);
  const segments = deriveWorkflowBarSegments(progress.phases);
  const [inspection, setInspection] = useState<{
    anchor: HTMLButtonElement;
    touchReady: boolean;
  } | null>(null);
  const inspectedId =
    inspection?.anchor.dataset.workflowDot ?? inspection?.anchor.dataset.workflowAttention;
  const inspecting = inspection !== null;
  function inspect(anchor: HTMLButtonElement | null) {
    setInspection((previous) =>
      anchor === null
        ? null
        : previous?.anchor === anchor
          ? previous
          : { anchor, touchReady: false },
    );
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hover inspection must receive Escape even when keyboard focus is outside this overview.
  useEffect(() => {
    if (!inspecting) return;
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setInspection(null);
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [inspecting]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a live state change can remove the inspected cell when its phase collapses.
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the committed DOM determines whether the external anchor still exists.
    if (inspection && !inspection.anchor.isConnected) setInspection(null);
  });
  const prefix = useId();
  const readoutId = useId();
  // Stored during render, so the next update starts from the slots and keys this one used.
  const [groupMemory, setGroupMemory] = useState(EMPTY_WORKFLOW_PHASE_GROUP_MEMORY);
  const { groups, memory: nextGroupMemory } = deriveWorkflowPhaseGroups(
    progress.phases,
    groupMemory,
  );
  if (nextGroupMemory !== groupMemory) setGroupMemory(nextGroupMemory);
  const pages = Math.ceil(groups.length / PHASE_PAGE_SIZE);
  const page = Math.min(phasePage, Math.max(0, pages - 1));
  // Grids are siblings keyed by phase and disclosures by their group key, so a phase moving
  // between groups keeps its DOM and focus.
  const visibleGroups = groups
    .slice(page * PHASE_PAGE_SIZE, (page + 1) * PHASE_PAGE_SIZE)
    .map((group) => ({
      group,
      expanded:
        group.kind === null ||
        group.phases.some((phase) => expandedPhases.has(`${group.kind}:${phase.id}`)),
    }));
  const byProvider = new Map(providers.map((provider) => [provider.instanceId, provider]));
  const cache = new Map<string, WorkflowIdentity>();
  const identities = new Map<string, WorkflowIdentity>();
  const observed = new Map<string, { identity: WorkflowIdentity; count: number }>();
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
        Boolean(member?.childThreadId),
        Boolean(member?.startedAt),
        task.plannedIdentity?.providerInstanceId,
        task.plannedIdentity?.driver,
        task.plannedIdentity?.model,
      ]);
      let identity = cache.get(cacheKey);
      if (!identity) {
        identity = resolveWorkflowIdentity(
          member,
          provider,
          task.state,
          task.plannedIdentity,
          task.plannedIdentity?.providerInstanceId
            ? byProvider.get(task.plannedIdentity.providerInstanceId)
            : undefined,
        );
        cache.set(cacheKey, identity);
      }
      identities.set(task.id, identity);
      if ((member && task.state !== "queued") || identity.planned) {
        const entry = observed.get(identity.key);
        if (entry) entry.count += 1;
        else observed.set(identity.key, { identity, count: 1 });
      }
      if (identity.icon.kind !== "glyph") icons.set(identity.icon.key, identity.icon);
      if (task.id === inspectedId) inspectedTask = task;
    }
  const sprite = new Map([...icons.keys()].map((key, index) => [key, `${prefix}-icon-${index}`]));
  const legend = [...observed.values()].toSorted((left, right) => right.count - left.count);
  const inspectedIdentity = inspectedTask ? identities.get(inspectedTask.id) : undefined;
  const receiptAgents = progress.counts.total ?? progress.counts.observed;
  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      style={{ "--workflow-agent-pitch": `${WORKFLOW_AGENT_PITCH}px` } as CSSProperties}
      data-workflow-overview
      onClickCapture={(event) => {
        if (
          !(event.nativeEvent instanceof PointerEvent) ||
          event.nativeEvent.pointerType !== "touch"
        )
          return;
        const anchor =
          event.target instanceof Element
            ? event.target.closest<HTMLButtonElement>("[data-workflow-dot]")
            : null;
        if (!anchor || (inspection?.anchor === anchor && inspection.touchReady)) return;
        event.preventDefault();
        event.stopPropagation();
        setInspection({ anchor, touchReady: true });
      }}
    >
      <WorkflowIdentitySymbols icons={[...icons.values()]} sprite={sprite} />
      {progress.attention.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1" data-workflow-attention-list>
          <p className="text-xs font-medium">Needs attention</p>
          {progress.attention.slice(0, allAttention ? undefined : 3).map((task) => {
            const identity = identities.get(task.id)!;
            return (
              <button
                key={task.id}
                type="button"
                data-workflow-attention={task.id}
                aria-label={`Inspect ${task.label}: ${task.attention!.reason}`}
                aria-details={readoutId}
                className="flex min-w-0 items-center gap-1 rounded-sm text-left text-xs hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-ring"
                onClick={(event) => inspect(event.currentTarget)}
                onFocus={(event) => inspect(event.currentTarget)}
                onBlur={() => inspect(null)}
              >
                <WorkflowAgentIdentity
                  member={task.member}
                  provider={undefined}
                  identity={identity}
                  sprite={sprite}
                />
                <span className="min-w-0 truncate">
                  {task.label} · {identity.modelName} · {task.attention!.reason}
                </span>
              </button>
            );
          })}
          {progress.attention.length > 3 ? (
            <div>
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={allAttention}
                onClick={() => {
                  setInspection(null);
                  setAllAttention(!allAttention);
                }}
              >
                {allAttention ? "Show fewer" : `+${progress.attention.length - 3} more`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {progress.terminal ? (
        <div
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground"
          data-workflow-receipt
        >
          <span>
            {receiptAgents} {progress.counts.total === null ? "observed " : ""}
            {receiptAgents === 1 ? "agent" : "agents"}
            {progress.failedCount > 0
              ? ` · ${progress.failedCount} ${progress.failedCount === 1 ? "agent" : "agents"} failed`
              : null}
            {progress.failedPhaseCount > 0
              ? ` · ${progress.failedPhaseCount} ${progress.failedPhaseCount === 1 ? "phase" : "phases"} failed`
              : null}
            {progress.counts.stopped > 0 ? ` · ${progress.counts.stopped} stopped` : null}
            {progress.counts.skipped > 0 ? ` · ${progress.counts.skipped} skipped` : null}
          </span>
          {progress.elapsedMs === null ? null : <span>{formatDuration(progress.elapsedMs)}</span>}
          <WorkflowIdentityStack identities={[...identities.values()]} sprite={sprite} />
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={receiptExpanded}
            onClick={() => {
              setInspection(null);
              setReceiptExpanded(!receiptExpanded);
            }}
          >
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3", receiptExpanded && "rotate-90")}
            />
            {receiptExpanded ? "Hide phases" : "Show phases"}
          </Button>
        </div>
      ) : null}
      {progress.terminal && progress.counts.total === 0 ? null : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {progress.terminal ? null : (
            <p
              className="flex min-w-0 flex-wrap items-baseline gap-x-2 tabular-nums"
              data-workflow-headline
            >
              <span className="text-base font-medium text-foreground">
                {headlineText(progress.counts)}
              </span>
              <span className="text-2xs text-muted-foreground">{headlineDetail(progress)}</span>
            </p>
          )}
          {progress.counts.total === 0 ? null : (
            <WorkflowPhaseBar
              counts={progress.counts}
              segments={segments}
              unreached={unreached}
              thin={progress.terminal && progress.successful}
            />
          )}
        </div>
      )}
      {showPhases && legend.length >= 2 ? (
        <div
          aria-label="Agent models"
          className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs tabular-nums text-muted-foreground"
          data-workflow-legend
        >
          {legend.slice(0, 4).map(({ identity, count }) => (
            <span
              key={identity.key}
              aria-label={`${identity.planned ? "Planned: " : ""}${identity.providerName} · ${identity.modelName}, ${count} agents`}
              className="inline-flex min-w-0 items-center gap-1"
            >
              <WorkflowAgentIdentity
                member={null}
                provider={undefined}
                identity={identity}
                sprite={sprite}
              />
              <span className="break-words">
                {identity.planned ? "Planned: " : ""}
                {identity.displayName} ×{count}
              </span>
            </span>
          ))}
          {legend.length > 4 ? (
            <span data-workflow-legend-overflow>
              <span aria-hidden>+{legend.length - 4}</span>
              <span className="sr-only">{`${legend.length - 4} more models: ${legend
                .slice(4)
                .map(
                  ({ identity, count }) =>
                    `${identity.planned ? "Planned: " : ""}${identity.providerName} · ${identity.modelName}, ${count} agents`,
                )
                .join(", ")}`}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {inspectedTask && inspectedIdentity && inspection ? (
        <WorkflowAgentReadout id={readoutId} anchor={inspection.anchor}>
          <p className={cn("font-medium", WORKFLOW_STATE_TEXT[inspectedTask.state])}>
            {inspectedTask.label} · {inspectedTask.state}
          </p>
          <p>
            {inspectedIdentity.planned ? "Planned: " : ""}
            {inspectedIdentity.providerName} · {inspectedIdentity.modelName}
          </p>
          {inspectedIdentity.plannedDescription ? (
            <p>Changed from planned: {inspectedIdentity.plannedDescription}</p>
          ) : null}
          {inspectedTask.detail || inspectedTask.attention?.reason ? (
            <p className="line-clamp-3 whitespace-pre-wrap">
              {inspectedTask.detail ?? inspectedTask.attention?.reason}
            </p>
          ) : null}
          {inspectedTask.member?.childThreadId ? null : <p>Thread not available yet</p>}
        </WorkflowAgentReadout>
      ) : null}

      {showPhases ? (
        // Grids are siblings keyed by phase and folded rows by their group key, so a phase moving
        // between groups keeps its DOM and focus.
        <div className="flex min-w-0 flex-col" data-workflow-phases>
          {visibleGroups.flatMap(({ group, expanded }) => {
            const grids = expanded
              ? group.phases.map((phase) => (
                  <PhaseAgents
                    key={phase.id}
                    phase={phase}
                    marker={phaseMarker(phase, unreached)}
                    nested={group.kind !== null}
                    identities={identities}
                    sprite={sprite}
                    generic={generic}
                    onInspect={inspect}
                    readoutId={readoutId}
                    onOpenThread={props.onOpenThread}
                  />
                ))
              : [];
            if (group.kind === null) return grids;
            const marker = groupMarker(group, unreached);
            return [
              <button
                key={group.key}
                type="button"
                aria-expanded={expanded}
                data-workflow-phase-disclosure
                className={cn(
                  "flex w-full min-w-0 items-start gap-2 rounded-sm border-t border-border py-1.5 text-left text-xs first:border-t-0 hover:bg-accent/30 focus-visible:outline-2 focus-visible:outline-ring",
                  marker === "queued" ? "text-muted-foreground" : "text-foreground",
                )}
                onClick={() => {
                  setInspection(null);
                  setExpandedPhases((previous) => {
                    const next = new Set(previous);
                    for (const phase of group.phases) {
                      const remembered = `${group.kind}:${phase.id}`;
                      if (expanded) next.delete(remembered);
                      else next.add(remembered);
                    }
                    return next;
                  });
                }}
              >
                <StateMarker state={marker} />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  {group.label}
                  <span className="text-muted-foreground">
                    {" · "}
                    {group.kind === "queued" && unreached !== undefined
                      ? `${group.phases.reduce(
                          (sum, phase) => sum + (phase.counts.total ?? phase.counts.observed),
                          0,
                        )} not run`
                      : group.summary}
                  </span>
                </span>
                <WorkflowIdentityStack
                  identities={group.phases.flatMap((phase) =>
                    phase.tasks.map((task) => identities.get(task.id)!),
                  )}
                  sprite={sprite}
                />
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-3 shrink-0 text-muted-foreground",
                    expanded && "rotate-90",
                  )}
                />
              </button>,
              ...grids,
            ];
          })}
        </div>
      ) : null}
      {showPhases && pages > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={page === 0}
            onClick={() => {
              setInspection(null);
              setPhasePage(page - 1);
            }}
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
            onClick={() => {
              setInspection(null);
              setPhasePage(page + 1);
            }}
          >
            More phases
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** A phase row's second line: what is not done yet, in state colours. */
function PhaseDetail(props: {
  readonly counts: WorkflowProgressCounts;
  readonly notStarted: number;
}) {
  const entries = workflowCountEntries(props.counts).filter(({ state }) => state !== "done");
  if (entries.length === 0 && props.notStarted === 0) return null;
  return (
    <p className="flex flex-wrap gap-x-1 text-2xs tabular-nums text-muted-foreground">
      {entries.map(({ state, count }, index) => (
        <span key={state}>
          {index > 0 ? <span aria-hidden>· </span> : null}
          <span className={WORKFLOW_STATE_TEXT[state]}>
            {count} {state}
          </span>
        </span>
      ))}
      {props.notStarted > 0 ? (
        <span>
          {entries.length > 0 ? <span aria-hidden>· </span> : null}
          {props.notStarted} not started
        </span>
      ) : null}
    </p>
  );
}

function phaseFraction(counts: WorkflowProgressCounts): string {
  return counts.total === null
    ? `${counts.done} done · total unknown`
    : `${counts.done} of ${counts.total}`;
}

function PhaseAgents(props: {
  readonly phase: WorkflowPhaseProgress;
  readonly marker: MarkerState;
  /** Opened from a folded row, so it sits indented under that row. */
  readonly nested: boolean;
  readonly identities: ReadonlyMap<string, WorkflowIdentity>;
  readonly sprite: WorkflowIdentitySprite;
  readonly generic: WorkflowIdentity;
  readonly readoutId: string;
  readonly onInspect: (anchor: HTMLButtonElement | null) => void;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { phase } = props;
  const headingId = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  const tasks = phase.tasks;
  const active = tasks.some((task) => task.id === activeId) ? activeId : tasks[0]?.id;
  const notStarted = Math.max(
    0,
    (phase.counts.total ?? phase.counts.observed) - phase.counts.observed,
  );
  function inspect(target: EventTarget | null, focused = false) {
    const button =
      target instanceof Element ? target.closest<HTMLButtonElement>("[data-workflow-dot]") : null;
    const id = button?.dataset.workflowDot;
    if (id) {
      props.onInspect(button);
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
      className={cn(
        "min-w-0 border-t py-1.5 first:border-t-0",
        props.nested ? "border-border/60 pl-4" : "border-border",
      )}
      data-workflow-phase
    >
      <header className="flex min-w-0 items-start gap-2">
        <StateMarker state={props.marker} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h4
            id={headingId}
            className={cn(
              "min-w-0 text-xs font-medium [overflow-wrap:anywhere]",
              props.marker === "queued" && "text-muted-foreground",
            )}
          >
            {phase.title}
            <span className="font-normal text-muted-foreground tabular-nums">
              {` · ${phaseFraction(phase.counts)}`}
            </span>
          </h4>
          <PhaseDetail counts={phase.counts} notStarted={notStarted} />
        </div>
      </header>
      <div
        role="toolbar"
        aria-labelledby={headingId}
        aria-description="Use arrow keys to move between agents. Home and End move to the first and last agent. Enter opens its thread."
        className="mt-1 grid min-w-0 pl-4"
        style={{ gridTemplateColumns: "repeat(auto-fill, var(--workflow-agent-pitch))" }}
        onKeyDown={moveFocus}
        onPointerOver={(event) => {
          if (event.pointerType !== "touch") inspect(event.target);
        }}
        onFocus={(event) => inspect(event.target, true)}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return;
          if (event.currentTarget.contains(document.activeElement)) inspect(document.activeElement);
          else props.onInspect(null);
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
        props.planned ? "Planned" : null,
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
        workflowIdentityStateClass(state, props.planned),
      )}
    >
      <WorkflowIdentityGlyph
        planned={props.planned}
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

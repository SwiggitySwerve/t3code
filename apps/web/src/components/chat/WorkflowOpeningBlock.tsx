import {
  appWorkflowHeading,
  deriveWorkflowProgress,
  workflowGraphHeadline,
  workflowProgressText,
  type WorkflowOpening,
  type WorkflowGraphView,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { workflowOpeningTitles } from "@t3tools/shared/workflowOpeningText";
import { ChevronDownIcon, ChevronRightIcon, SquareIcon, WorkflowIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PROGRESS_CLASS_NAME } from "../ui/progress";
import { WorkflowDeclaration } from "./WorkflowDeclaration";
import { WorkflowProgressOverview } from "./WorkflowProgressOverview";
import { WorkflowWaveCanvas } from "./WorkflowWaveCanvas";
import { WorkflowAgentIdentity } from "./WorkflowAgentIdentity";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { useClientSettings } from "../../hooks/useSettings";

type WorkflowOpeningProps = {
  readonly opening: WorkflowOpening;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
  readonly heading?: string;
  readonly progress?: string | null;
  /** Only coordinator threads index the declaration; live activity is never searchable. */
  readonly findable?: boolean;
  readonly stop?: {
    readonly onStop: () => void;
    readonly stopping: boolean;
    readonly disabled: boolean;
  };
};

export function WorkflowOpeningBlock(props: WorkflowOpeningProps) {
  return <WorkflowOpeningContent key={props.opening.messageId} {...props} />;
}

function useWorkflowSnapshot(
  opening: WorkflowOpening,
  progress: string | null | undefined,
  heading: string | undefined,
  providers: ReadonlyArray<ServerProvider>,
) {
  const [snapshot, setSnapshot] = useState({ opening, progress, heading, providers });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useEffectEvent(() => {
    timer.current = null;
    setSnapshot({ opening, progress, heading, providers });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- coalesces external workflow events without postponing a flush during continuous streaming.
  useEffect(() => {
    if (
      snapshot.opening === opening &&
      snapshot.progress === progress &&
      snapshot.heading === heading &&
      snapshot.providers === providers
    )
      return;
    if (timer.current === null) timer.current = setTimeout(flush, 1000);
  }, [opening, progress, heading, providers, snapshot]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the pending publication timer on unmount.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );
  return snapshot;
}

function WorkflowOpeningContent(props: WorkflowOpeningProps) {
  const verboseGraph = useClientSettings((settings) => settings.verboseWorkflowGraph);
  const currentProviders = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const {
    opening,
    progress,
    heading: suppliedHeading,
    providers,
  } = useWorkflowSnapshot(props.opening, props.progress, props.heading, currentProviders);
  const [detailOpen, setDetailOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const heading =
    suppliedHeading ??
    (opening.group === null
      ? "Workflow started"
      : appWorkflowHeading(opening.group.workflow.status));
  const find = props.findable === true ? "true" : undefined;
  const headline = workflowOpeningTitles(opening);
  const group = opening.group;
  const overview = group === null ? null : deriveWorkflowProgress(group);
  const graph = group?.graph ?? null;
  const waitingOn = graph === null ? null : workflowGraphHeadline(graph).waitingOn;
  const activityHeadline = overview?.headline ?? progress;
  const liveHeadline = [activityHeadline, waitingOn].filter(Boolean).join(" · ");
  const headlineMember = overview?.headlineMember ?? null;
  const terminalResult =
    overview?.terminal && group !== null
      ? progress === undefined
        ? workflowProgressText({
            status: group.workflow.status,
            result: group.workflow.result ?? group.workflow.error,
            workflow: group.workflow.graph,
          })
        : progress
      : null;
  const declaration =
    graph !== null
      ? graph.waves.flatMap((wave) => wave.map((node) => node.label))
      : (group?.phases.filter((phase) => phase.members.length > 0).map((phase) => phase.title) ??
        []);
  return (
    <section
      aria-label={`${heading}: ${headline.title}`}
      className="flex min-w-0 flex-col gap-3 px-1 py-0.5"
      data-workflow-opening
    >
      <header className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-1">
        <WorkflowIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            aria-live={overview?.terminal ? "polite" : undefined}
            aria-atomic={overview?.terminal ? true : undefined}
            className={cn(
              "text-2xs font-medium text-muted-foreground",
              group?.workflow.status === "failed" && "text-destructive-foreground",
            )}
          >
            {heading}
            {overview?.terminal && overview.failedPhaseCount > 0 && overview.failedCount === 0
              ? ` · ${overview.headline}`
              : null}
          </p>
          <h3 className="truncate text-sm font-medium text-foreground" data-thread-find-text={find}>
            {headline.title}
          </h3>
          {overview?.terminal ? null : (
            <div
              aria-live="polite"
              aria-atomic="true"
              className="flex min-w-0 items-start gap-1 text-xs text-muted-foreground [overflow-wrap:anywhere]"
            >
              {headlineMember === null ? null : (
                <WorkflowAgentIdentity
                  member={headlineMember}
                  provider={providers.find(
                    (provider) => provider.instanceId === headlineMember.providerInstanceId,
                  )}
                />
              )}
              {liveHeadline ? (
                <div className="min-w-0 flex-1">
                  <WorkflowProgress text={liveHeadline} />
                </div>
              ) : null}
            </div>
          )}
          {overview === null || overview.terminal ? null : (
            // Needs attention shows failures; this region announces them only when they change.
            <p
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
              data-workflow-failure-announcement
            >
              {overview.failureSummary}
            </p>
          )}
          {!overview?.terminal && headline.description ? (
            <p className="text-xs text-muted-foreground" data-thread-find-text={find}>
              {headline.description}
            </p>
          ) : null}
        </div>
        {props.stop ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label={`Stop workflow ${headline.title}`}
            disabled={props.stop.disabled}
            onClick={props.stop.onStop}
          >
            <SquareIcon aria-hidden className="size-3 fill-current" />
            {props.stop.stopping ? "Stopping…" : "Stop"}
          </Button>
        ) : null}
      </header>
      {opening.budget === undefined ||
      overview?.terminal ||
      (overview?.attention.length ?? 0) > 0 ? null : (
        <WorkflowBudgetMeter budget={opening.budget} />
      )}
      {overview === null ? null : (
        <WorkflowProgressOverview
          progress={overview}
          environmentId={props.environmentId}
          onOpenThread={props.onOpenThread}
        />
      )}
      {opening.budget !== undefined &&
      !overview?.terminal &&
      (overview?.attention.length ?? 0) > 0 ? (
        <WorkflowBudgetMeter budget={opening.budget} />
      ) : null}
      {terminalResult ? (
        <Collapsible open={resultOpen} onOpenChange={setResultOpen}>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            <ChevronRightIcon aria-hidden className={cn("size-3", resultOpen && "rotate-90")} />
            Workflow result
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            {resultOpen ? <WorkflowProgress text={terminalResult} /> : null}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {props.findable && declaration.length > 0 ? (
        <WorkflowDeclaration segments={declaration} />
      ) : null}
      {group !== null && (graph === null || verboseGraph) ? (
        <Collapsible open={detailOpen} onOpenChange={setDetailOpen}>
          <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
            <ChevronRightIcon aria-hidden className={cn("size-3", detailOpen && "rotate-90")} />
            {graph === null ? "Script details" : "Graph details"}
          </CollapsibleTrigger>
          <CollapsiblePanel animate={false}>
            {detailOpen ? (
              graph !== null ? (
                <WorkflowGraphDetails
                  graph={graph}
                  environmentId={props.environmentId}
                  onOpenThread={props.onOpenThread}
                />
              ) : (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {opening.script}
                </pre>
              )
            ) : null}
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </section>
  );
}
function WorkflowGraphDetails(props: {
  readonly graph: WorkflowGraphView<RuntimeSubagent>;
  readonly environmentId: EnvironmentId;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const [selectedPage, setPage] = useState(0);
  const nodes = props.graph.waves.flat();
  const pages = Math.ceil(nodes.length / 40);
  const page = Math.min(selectedPage, Math.max(0, pages - 1));
  const keys = new Set(nodes.slice(page * 40, (page + 1) * 40).map((node) => node.key));
  return (
    <>
      {pages > 1 ? (
        <div className="flex flex-wrap items-center gap-2 py-2">
          <Button
            size="xs"
            variant="outline"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous graph nodes
          </Button>
          <span className="text-2xs text-muted-foreground">
            Page {page + 1} of {pages} · connections shown for this page
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={page + 1 === pages}
            onClick={() => setPage(page + 1)}
          >
            More graph nodes
          </Button>
        </div>
      ) : null}
      <WorkflowWaveCanvas
        key={page}
        graph={props.graph}
        visibleNodeKeys={keys}
        environmentId={props.environmentId}
        onOpenThread={props.onOpenThread}
      />
    </>
  );
}

function WorkflowBudgetMeter({
  budget,
}: {
  readonly budget: NonNullable<WorkflowOpening["budget"]>;
}) {
  const spent =
    budget.spent === null
      ? "Unknown usage"
      : `${budget.complete ? "" : "At least "}${formatTokens(budget.spent)} tokens recorded`;
  return (
    <div className="px-2 text-2xs text-muted-foreground" data-workflow-budget>
      <p>
        {spent} / {budget.limit === null ? "no" : formatTokens(budget.limit)} token budget
      </p>
      {budget.limit !== null && budget.limit > 0 && budget.spent !== null ? (
        <progress
          className={cn("block h-1 w-full", PROGRESS_CLASS_NAME)}
          aria-label="Recorded workflow token usage"
          value={Math.min(budget.spent, budget.limit)}
          max={budget.limit}
        />
      ) : null}
      <p className={cn("text-xs", budget.exhausted && "text-warning")}>
        {budget.overshot ? "Budget exceeded. " : budget.exhausted ? "Budget exhausted. " : ""}
        The budget stops new starts. Already-running agents may exceed it.
        {budget.complete ? "" : " Usage is incomplete."}
      </p>
    </div>
  );
}

function WorkflowProgress(props: { readonly text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const contentId = useId();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the clamped text and re-measures when its box resizes: layout read from the DOM, not state derivable in render.
  useEffect(() => {
    const element = textRef.current;
    if (element === null || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight);
    measure();
    return observeResize(element, measure);
  });
  return (
    <div>
      <p
        ref={textRef}
        id={contentId}
        className={cn(
          "break-words whitespace-pre-wrap text-xs text-muted-foreground",
          !expanded && "line-clamp-3",
        )}
      >
        {props.text}
      </p>
      {overflows || expanded ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={contentId}
          data-scroll-anchor-ignore
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show full result"}
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3 transition-transform", expanded && "rotate-180")}
          />
        </Button>
      ) : null}
    </div>
  );
}

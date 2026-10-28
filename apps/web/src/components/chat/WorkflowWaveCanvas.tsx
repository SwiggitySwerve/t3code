import { useAtomValue } from "@effect/atom-react";
import { useNowSecond } from "../../hooks/useNowSecond";
import {
  WORKFLOW_GRAPH_STATE_LABEL,
  workflowGraphNodeDetail,
  workflowMemberIdentity,
  workflowNodeAccounting,
  type RuntimeSubagent,
  type WorkflowGraphNodeState,
  type WorkflowGraphNodeView,
  type WorkflowGraphView,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type {
  EnvironmentId,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { ChevronRightIcon, HistoryIcon } from "lucide-react";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { observeResize } from "../../lib/observeResize";
import { cn } from "../../lib/utils";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { Tooltip, TooltipCreateHandle, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import {
  Popover,
  PopoverCreateHandle,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import { scrollFadeStyle } from "./scrollFade";
import { EnvironmentSubagentAvatar } from "./V2LifecycleRow";
import {
  WAVE_CARD_BORDER,
  type WaveBox,
  type WaveViewport,
  visibleWaveCards,
  waveCardWidth,
  workflowWaveLayout,
} from "./workflowWaveLayout";

/** The avatar dot for each node state; nodes that never ran share the stopped dot. */
const AVATAR_STATUS: Readonly<Record<WorkflowGraphNodeState, OrchestrationV2TurnItem["status"]>> = {
  passed: "completed",
  failed: "failed",
  skipped: "cancelled",
  running: "running",
  queued: "pending",
  waiting: "pending",
  not_run: "cancelled",
  interrupted: "interrupted",
};

type AttemptsPayload = {
  readonly label: string;
  readonly totals: string;
  readonly accounting: ReturnType<typeof workflowNodeAccounting>;
};

/**
 * One tooltip and one attempts popover serve every card. A 150-node graph would otherwise mount
 * about 450 tooltip roots and 150 popover roots on each render.
 */
type CanvasOverlays = {
  readonly tooltip: ReturnType<typeof TooltipCreateHandle<ReactNode>>;
  readonly attempts: ReturnType<typeof PopoverCreateHandle<AttemptsPayload>>;
};

const MUTED_STATES: ReadonlySet<WorkflowGraphNodeState> = new Set([
  "waiting",
  "skipped",
  "not_run",
]);

/**
 * A graph workflow as columns of node cards, one column per wave. It scrolls sideways inside its
 * chat row, and its size comes from the layout, so the row's height stays put as nodes change.
 */
export function WorkflowWaveCanvas(props: {
  readonly graph: WorkflowGraphView<RuntimeSubagent>;
  readonly environmentId: EnvironmentId;
  /** Whether find-in-thread reads the node labels; see `WorkflowOpeningBlock`. */
  readonly findable?: boolean;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { graph } = props;
  const find = props.findable === true ? "true" : undefined;
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(props.environmentId));
  const nodes = graph.waves.flat();
  const labels = new Map(nodes.map((node) => [node.key, node.label] as const));
  // Only cards in view (plus a margin) draw in full; a 150-node graph stays fast to render.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<WaveViewport | null>(null);
  // The scroll area's width decides the card width, so a narrow chat shows two whole columns.
  const layout = workflowWaveLayout(
    graph.waves.map((wave) =>
      wave.map((node) => ({
        ...node,
        started: workflowMemberIdentity(node.member) !== "Not started",
        failure: node.state === "failed" ? node.reason : null,
        note: workflowGraphNodeDetail(node, labels).detail,
      })),
    ),
    waveCardWidth(viewport?.width),
  );
  // Hovering or focusing a node highlights it, what it depends on and what depends on it.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- subscribes to the scroll container's scroll and resize events, which only the DOM reports.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      setViewport({
        left: element.scrollLeft,
        top: element.scrollTop,
        width: element.clientWidth,
        height: element.clientHeight,
      });
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    read();
    element.addEventListener("scroll", schedule, { passive: true });
    const stopObserving = observeResize(element, read);
    return () => {
      element.removeEventListener("scroll", schedule);
      stopObserving();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
  // The highlighted card and the card whose attempts are open stay drawn, so scrolling away
  // never unmounts the element that holds focus, hover state or the popover's anchor.
  const [attemptsOpenFor, setAttemptsOpenFor] = useState<string | null>(null);
  const visible = viewport === null ? null : visibleWaveCards(layout, viewport);
  const drawn =
    visible === null
      ? null
      : new Set([
          ...visible,
          ...(highlighted === null ? [] : [highlighted]),
          ...(attemptsOpenFor === null ? [] : [attemptsOpenFor]),
        ]);
  // Tabbing onto a placeholder draws that card in full; focus then moves to its main control.
  const focusRequest = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- moves DOM focus after the highlighted card has rendered in full; focus cannot be set during render.
  useLayoutEffect(() => {
    const key = focusRequest.current;
    if (key === null || key !== highlighted) return;
    focusRequest.current = null;
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-workflow-node="${CSS.escape(key)}"] [data-node-state]`)
      ?.focus();
  }, [highlighted]);
  const [overlays] = useState<CanvasOverlays>(() => ({
    tooltip: TooltipCreateHandle<ReactNode>(),
    attempts: PopoverCreateHandle<AttemptsPayload>(),
  }));
  const focus = nodes.find((node) => node.key === highlighted);
  const related =
    focus === undefined ? null : new Set([focus.key, ...focus.dependsOn, ...focus.dependents]);
  return (
    <div
      ref={scrollRef}
      className="max-h-120 overflow-auto px-1 pb-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      style={scrollFadeStyle({
        right: viewport !== null && viewport.left + viewport.width < layout.width - 1,
        bottom: viewport !== null && viewport.top + viewport.height < layout.height - 1,
      })}
      data-workflow-waves
      role="region"
      aria-label="Workflow graph"
      tabIndex={0}
    >
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map((edge) => {
            const active =
              focus !== undefined && (edge.from === focus.key || edge.to === focus.key);
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                d={edge.path}
                fill="none"
                stroke="currentColor"
                strokeWidth={active ? 1.5 : 1}
                className={active ? "text-foreground/70" : "text-border"}
                data-edge-active={active ? "" : undefined}
              />
            );
          })}
        </svg>
        {graph.waves.map((nodes, column) => {
          const x = layout.columns[column]?.x ?? 0;
          const settled = nodes.filter(
            (node) =>
              node.state === "passed" || node.state === "failed" || node.state === "skipped",
          ).length;
          return (
            <section
              key={nodes[0]?.wave ?? column}
              aria-label={`Wave ${column + 1}`}
              className="contents"
            >
              <h4
                className="absolute flex items-baseline gap-2 px-1 text-2xs font-medium text-muted-foreground"
                style={{ left: x, top: 0, width: layout.cards.get(nodes[0]?.key ?? "")?.width }}
              >
                <span>Wave {column + 1}</span>
                <span className="tabular-nums">
                  {settled} of {nodes.length} finished
                </span>
              </h4>
              {nodes.map((node) => {
                const box = layout.cards.get(node.key);
                if (box === undefined) return null;
                const emphasis = related === null ? null : related.has(node.key);
                if (drawn === null || !drawn.has(node.key)) {
                  return (
                    <WorkflowNodePlaceholder
                      key={node.key}
                      node={node}
                      box={box}
                      find={find}
                      emphasis={emphasis}
                      onFocus={() => {
                        focusRequest.current = node.key;
                        setHighlighted(node.key);
                      }}
                    />
                  );
                }
                return (
                  <WorkflowNodeCard
                    key={node.key}
                    node={node}
                    box={box}
                    labels={labels}
                    find={find}
                    environmentId={props.environmentId}
                    providers={providers}
                    providerInstanceId={node.member?.providerInstanceId ?? null}
                    // A node without an agent has no provider yet; the workflow's own provider
                    // is the coordinator's, not the node's, so its avatar stays neutral.
                    driver={node.member?.driver}
                    onOpenThread={props.onOpenThread}
                    overlays={overlays}
                    onAttemptsOpen={() => setAttemptsOpenFor(node.key)}
                    emphasis={emphasis}
                    onHighlight={(on) =>
                      setHighlighted((current) =>
                        on ? node.key : current === node.key ? null : current,
                      )
                    }
                  />
                );
              })}
            </section>
          );
        })}
      </div>
      <Tooltip handle={overlays.tooltip}>
        {({ payload }) =>
          payload === undefined ? null : (
            <TooltipPopup className="max-w-80">
              <div className="max-h-64 overflow-y-auto">{payload}</div>
            </TooltipPopup>
          )
        }
      </Tooltip>
      <Popover
        handle={overlays.attempts}
        onOpenChange={(open) => {
          if (!open) setAttemptsOpenFor(null);
        }}
      >
        {({ payload }) =>
          payload === undefined ? null : (
            <PopoverPopup width="md">
              <PopoverTitle>{payload.label} attempts</PopoverTitle>
              <p className="my-2 text-xs text-muted-foreground">
                {payload.totals}.
                {payload.accounting.live ? " Running time is as of the latest update." : ""}
              </p>
              <div className="max-h-64 overflow-y-auto">
                <WorkflowAttemptList
                  accounting={payload.accounting}
                  onOpenThread={props.onOpenThread}
                />
              </div>
            </PopoverPopup>
          )
        }
      </Popover>
    </div>
  );
}

/**
 * A card outside the view: its label and state only, so find-in-thread and screen readers still
 * reach every node while the full card waits until it scrolls into view.
 */
function WorkflowNodePlaceholder(props: {
  readonly node: WorkflowGraphNodeView<RuntimeSubagent>;
  readonly box: WaveBox;
  readonly find: "true" | undefined;
  readonly emphasis: boolean | null;
  readonly onFocus: () => void;
}) {
  const { node, box } = props;
  return (
    <div
      role="group"
      aria-label={workflowNodeName(node)}
      tabIndex={0}
      onFocus={props.onFocus}
      className={cn(
        "absolute overflow-hidden rounded-md border border-border/70 bg-card px-2 py-2",
        node.state === "failed" && "border-destructive/50",
        props.emphasis === false && "opacity-35",
      )}
      style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
      data-workflow-node={node.key}
      data-workflow-node-placeholder
    >
      <span
        className={cn(
          "block truncate text-xs font-medium",
          MUTED_STATES.has(node.state) ? "text-muted-foreground" : "text-foreground",
        )}
        data-thread-find-text={props.find}
      >
        {node.label}
      </span>
      <span className="block truncate text-2xs text-muted-foreground">
        {WORKFLOW_GRAPH_STATE_LABEL[node.state]}
      </span>
    </div>
  );
}

/**
 * What assistive technology reads for a node: its full label and its state in words. A card
 * truncates both visually, and colour alone never says whether a node passed, failed or waits.
 */
function workflowNodeName(node: WorkflowGraphNodeView<RuntimeSubagent>): string {
  return `${node.label}, ${WORKFLOW_GRAPH_STATE_LABEL[node.state]}`;
}

interface WorkflowNodeCardProps {
  readonly node: WorkflowGraphNodeView<RuntimeSubagent>;
  readonly box: WaveBox;
  readonly labels: ReadonlyMap<string, string>;
  readonly find: "true" | undefined;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
  readonly overlays: CanvasOverlays;
  readonly onAttemptsOpen: () => void;
  /** Null when nothing is highlighted; otherwise whether this node relates to the highlighted one. */
  readonly emphasis: boolean | null;
  readonly onHighlight: (on: boolean) => void;
}

/** The status word's colour: green passed, blue running, red failed, grey for everything else. */
const STATE_TEXT: Readonly<Partial<Record<WorkflowGraphNodeState, string>>> = {
  passed: "text-success-foreground",
  running: "text-info-foreground",
  failed: "text-destructive-foreground",
};

const sentenceCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The agent line of a card: the model's short name from the provider catalog, else its slug
 * tidied. The provider instance and raw model id stay in the tooltip and the accessible
 * description.
 */
function workflowNodeAgent(
  member: RuntimeSubagent | null,
  providers: ReadonlyArray<ServerProvider> | undefined,
): string {
  const identity = workflowMemberIdentity(member);
  if (member === null || identity === "Not started") return identity;
  if (member.model === null) return "Unknown model";
  const model = providers
    ?.find((provider) => provider.instanceId === member.providerInstanceId)
    ?.models.find((entry) => entry.slug === member.model);
  return model?.shortName ?? model?.name ?? formatModelSlugName(member.model);
}

function WorkflowNodeCard(props: WorkflowNodeCardProps) {
  const snapshot = workflowNodeAccounting(props.node);
  const now = useNowSecond(snapshot.live);
  const accounting = snapshot.live ? workflowNodeAccounting(props.node, now) : snapshot;
  const { node, box } = props;
  const { detail, retries } = workflowGraphNodeDetail(node, props.labels);
  const threadId = node.member?.childThreadId ?? null;
  const state = WORKFLOW_GRAPH_STATE_LABEL[node.state];
  const identity = workflowMemberIdentity(node.member);
  const totals = `${countText(accounting.tokens, formatTokens)} tokens · ${countText(accounting.elapsed, formatDuration)}`;
  const facts = [identity, retries, detail, totals].filter(Boolean).join(", ");
  const description = `${state}, ${facts}`;
  // The first line: how the node stands. A failed node's reason has its own band under the text;
  // the tooltip has the nodes a waiting node runs after, and the provider behind the model.
  const status = [retries === null ? null : sentenceCase(retries), sentenceCase(state)]
    .filter(Boolean)
    .join(" · ");
  const reasonBand =
    box.reasonLines === 0 ? 0 : box.reasonLines * 14 + 6;
  const className = cn(
    "group/node flex min-w-0 flex-1 items-center gap-2 px-2.5 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
    props.emphasis === false && "opacity-35",
  );
  const highlight = {
    onMouseEnter: () => props.onHighlight(true),
    onMouseLeave: () => props.onHighlight(false),
    onFocus: () => props.onHighlight(true),
    onBlur: () => props.onHighlight(false),
  };
  const style = { left: box.x, top: box.y, width: box.width, height: box.height };
  const bodyStyle = {
    height: box.height - WAVE_CARD_BORDER - box.checkerBand - reasonBand,
  };
  const content = (
    <>
      {props.providerInstanceId === null ? null : (
        <EnvironmentSubagentAvatar
          environmentId={props.environmentId}
          providerInstanceId={props.providerInstanceId}
          driver={props.driver}
          status={AVATAR_STATUS[node.state]}
        />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "flex items-center gap-1 text-2xs leading-3.5 font-semibold",
            STATE_TEXT[node.state] ?? "text-muted-foreground",
          )}
        >
          <span className="min-w-0 truncate">{status}</span>
          {threadId !== null ? (
            <ChevronRightIcon
              aria-hidden
              className="ml-auto size-3 shrink-0 text-muted-foreground group-hover/node:text-foreground"
            />
          ) : null}
        </span>
        <span
          className={cn(
            "text-xs leading-4 font-medium [overflow-wrap:anywhere]",
            MUTED_STATES.has(node.state) ? "text-muted-foreground" : "text-foreground",
            box.nameLines === 1 ? "line-clamp-1" : "line-clamp-2",
            box.historyButton && "pr-6",
          )}
          data-thread-find-text={props.find}
        >
          {node.label}
        </span>
        {box.started ? (
          <>
            <span className="truncate text-2xs leading-3.5 text-muted-foreground">
              {workflowNodeAgent(node.member, props.providers)}
            </span>
            <span className="truncate text-2xs leading-3.5 text-muted-foreground tabular-nums">
              {totals}
            </span>
          </>
        ) : (
          // A node that never ran has no agent or usage; what holds it back is what matters.
          <span
            className={cn(
              "text-2xs leading-3.5 text-muted-foreground [overflow-wrap:anywhere]",
              box.noteLines === 1 ? "line-clamp-1" : "line-clamp-2",
            )}
          >
            {detail ?? "Not started"}
          </span>
        )}
      </span>
    </>
  );
  // The card truncates its text; the tooltip shows all of it.
  return (
    <div
      className={cn(
        "absolute overflow-hidden rounded-md border border-border/70 bg-card",
        // Nodes that never ran are drawn dashed, so skipped and waiting read apart without colour.
        (node.state === "skipped" || node.state === "not_run") && "border-dashed",
        node.state === "failed" && "border-destructive/50",
        props.emphasis === true && "border-foreground/40",
      )}
      style={style}
      data-workflow-node={node.key}
    >
      <div className="relative flex items-center" style={bodyStyle}>
        <TooltipTrigger
          handle={props.overlays.tooltip}
          payload={
            <>
              <p>
                <span className="font-medium">{node.label}</span>
                {": "}
                {description}
              </p>
              <WorkflowAttemptList accounting={accounting} />
            </>
          }
          delay={200}
          render={
            threadId === null ? (
              <div
                role="group"
                aria-label={workflowNodeName(node)}
                aria-description={facts}
                className={className}
                style={bodyStyle}
                data-node-state={node.state}
                data-node-related={props.emphasis === null ? undefined : String(props.emphasis)}
                tabIndex={0}
                {...highlight}
              />
            ) : (
              <button
                type="button"
                aria-label={`Open ${workflowNodeName(node)}`}
                aria-description={facts}
                onClick={() => props.onOpenThread(threadId)}
                className={cn(
                  className,
                  "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                )}
                style={bodyStyle}
                data-node-state={node.state}
                data-node-related={props.emphasis === null ? undefined : String(props.emphasis)}
                {...highlight}
              />
            )
          }
        >
          {content}
        </TooltipTrigger>
        {box.historyButton && accounting.attempts.length > 0 ? (
          <PopoverTrigger
            handle={props.overlays.attempts}
            onClick={props.onAttemptsOpen}
            payload={{ label: node.label, totals, accounting }}
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-4 size-6"
                aria-label={`Attempts for ${node.label}`}
              />
            }
          >
            <HistoryIcon aria-hidden />
          </PopoverTrigger>
        ) : null}
      </div>
      {box.reasonLines > 0 ? (
        <div className="px-2.5 pb-1.5" data-workflow-failure>
          <p
            className={cn(
              "text-2xs leading-3.5 text-destructive-foreground [overflow-wrap:anywhere]",
              box.reasonLines === 1 ? "line-clamp-1" : "line-clamp-2",
            )}
          >
            {node.reason}
          </p>
        </div>
      ) : null}
      {box.checkerBand > 0 ? (
        <div className="overflow-y-auto" style={{ height: box.checkerBand }} data-workflow-checkers>
          {node.checkers.map((checker) => (
            <WorkflowChecker
              key={checker.id}
              checker={checker}
              tooltip={props.overlays.tooltip}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowChecker(props: {
  readonly checker: RuntimeSubagent;
  readonly tooltip: CanvasOverlays["tooltip"];
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { checker } = props;
  const threadId = checker.childThreadId;
  const label = `Check attempt ${(checker.judgmentFor?.attempt ?? 0) + 1}: ${checker.status}${checker.judgmentOutcome === undefined ? "" : `, judgment ${checker.judgmentOutcome}`}`;
  const identity = workflowMemberIdentity(checker);
  const result = checker.error ?? checker.result;
  const description = [label, identity, result].filter(Boolean).join(" · ");
  const className =
    "block h-7 w-full truncate border-t border-border/50 px-2 text-left text-2xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";
  return (
    <TooltipTrigger
      handle={props.tooltip}
      payload={
        <>
          <p>
            {checker.title}: {label} · {identity}
          </p>
          {result ? <p className="whitespace-pre-wrap break-words">{result}</p> : null}
        </>
      }
      render={
        threadId === null ? (
          <div
            role="group"
            aria-label={checker.title}
            aria-description={description}
            className={className}
            tabIndex={0}
          />
        ) : (
          <button
            type="button"
            className={cn(className, "cursor-pointer hover:bg-accent/20")}
            aria-label={`Open ${checker.title}, ${label}`}
            aria-description={description}
            onClick={() => props.onOpenThread(threadId)}
          />
        )
      }
    >
      {label} · {identity}
    </TooltipTrigger>
  );
}

function countText(
  count: { readonly value: number | null; readonly complete: boolean },
  format: (value: number) => string,
): string {
  return count.value === null ? "Unknown" : `${count.complete ? "" : "≥"}${format(count.value)}`;
}

function WorkflowAttemptList(props: {
  readonly accounting: ReturnType<typeof workflowNodeAccounting>;
  readonly onOpenThread?: (threadId: string) => void;
}) {
  return (
    <>
      <ul className="space-y-2 text-xs">
        {props.accounting.attempts.map((attempt) => (
          <li key={attempt.key}>
            <p>
              Attempt {attempt.number}: {attempt.status}
            </p>
            <p className="break-words">
              {attempt.providerInstanceId ?? "Unknown provider"} /{" "}
              {attempt.model ?? "Unknown model"}
            </p>
            <p>
              {countText(attempt.tokens, formatTokens)} tokens ·{" "}
              {countText(attempt.elapsed, formatDuration)}
            </p>
            {props.onOpenThread !== undefined && attempt.childThreadId !== null ? (
              <Button
                variant="link"
                size="sm"
                onClick={() => props.onOpenThread?.(attempt.childThreadId!)}
              >
                Open attempt {attempt.number}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {props.accounting.missing ? (
        <p className="mt-2 text-xs">Earlier attempt details are unavailable.</p>
      ) : null}
    </>
  );
}

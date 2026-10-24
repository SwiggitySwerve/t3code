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
} from "@t3tools/contracts";
import { ChevronRightIcon, HistoryIcon } from "lucide-react";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { useState } from "react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { EnvironmentSubagentAvatar } from "./V2LifecycleRow";
import { WAVE_CARD_HEIGHT, type WaveBox, workflowWaveLayout } from "./workflowWaveLayout";

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
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { graph } = props;
  const layout = workflowWaveLayout(graph.waves);
  const nodes = graph.waves.flat();
  const labels = new Map(nodes.map((node) => [node.key, node.label] as const));
  // Hovering or focusing a node highlights it, what it depends on and what depends on it.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const focus = nodes.find((node) => node.key === highlighted);
  const related =
    focus === undefined ? null : new Set([focus.key, ...focus.dependsOn, ...focus.dependents]);
  return (
    <div className="overflow-x-auto overflow-y-hidden px-1 pb-1" data-workflow-waves>
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
                <span className="font-normal tabular-nums">
                  {settled}/{nodes.length}
                </span>
              </h4>
              {nodes.map((node) => {
                const box = layout.cards.get(node.key);
                return box === undefined ? null : (
                  <WorkflowNodeCard
                    key={node.key}
                    node={node}
                    box={box}
                    labels={labels}
                    environmentId={props.environmentId}
                    providerInstanceId={node.member?.providerInstanceId ?? null}
                    // A node without an agent has no provider yet; the workflow's own provider
                    // is the coordinator's, not the node's, so its avatar stays neutral.
                    driver={node.member?.driver}
                    onOpenThread={props.onOpenThread}
                    emphasis={related === null ? null : related.has(node.key)}
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
    </div>
  );
}

interface WorkflowNodeCardProps {
  readonly node: WorkflowGraphNodeView<RuntimeSubagent>;
  readonly box: WaveBox;
  readonly labels: ReadonlyMap<string, string>;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
  /** Null when nothing is highlighted; otherwise whether this node relates to the highlighted one. */
  readonly emphasis: boolean | null;
  readonly onHighlight: (on: boolean) => void;
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
  const description = [state, identity, retries, detail, totals].filter(Boolean).join(", ");
  const className = cn(
    "group/node flex min-w-0 flex-1 items-center gap-2 px-2 text-left rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
    props.emphasis === false ? "opacity-35" : MUTED_STATES.has(node.state) && "opacity-60",
  );
  const highlight = {
    onMouseEnter: () => props.onHighlight(true),
    onMouseLeave: () => props.onHighlight(false),
    onFocus: () => props.onHighlight(true),
    onBlur: () => props.onHighlight(false),
  };
  const style = { left: box.x, top: box.y, width: box.width, height: box.height };
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
        <span className="truncate text-xs font-medium text-foreground" data-thread-find-text="true">
          {node.label}
        </span>
        <span className="truncate text-2xs text-muted-foreground">{identity}</span>
        <span
          className={cn(
            "truncate text-2xs",
            node.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {retries ? <span className="font-medium">{retries} · </span> : null}
          {detail ?? state}
        </span>
        <span className="truncate text-2xs text-muted-foreground tabular-nums">{totals}</span>
      </span>
      {threadId !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground/60 group-hover/node:text-foreground"
        />
      ) : null}
    </>
  );
  // The card truncates its text; the tooltip shows all of it.
  return (
    <div
      className={cn(
        "absolute overflow-hidden rounded-md border border-border/70 bg-card",
        node.state === "failed" && "border-destructive/50",
        props.emphasis === true && "border-foreground/40",
      )}
      style={style}
    >
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger
            delay={200}
            render={
              threadId === null ? (
                <div
                  role="group"
                  aria-label={node.label}
                  aria-description={description}
                  className={className}
                  style={{ height: WAVE_CARD_HEIGHT }}
                  data-node-state={node.state}
                  data-node-related={props.emphasis === null ? undefined : String(props.emphasis)}
                  tabIndex={0}
                  {...highlight}
                />
              ) : (
                <button
                  type="button"
                  aria-label={`Open ${node.label}`}
                  aria-description={description}
                  onClick={() => props.onOpenThread(threadId)}
                  className={cn(
                    className,
                    "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  )}
                  style={{ height: WAVE_CARD_HEIGHT }}
                  data-node-state={node.state}
                  data-node-related={props.emphasis === null ? undefined : String(props.emphasis)}
                  {...highlight}
                />
              )
            }
          >
            {content}
          </TooltipTrigger>
          <TooltipPopup className="max-w-80">
            <div className="max-h-64 overflow-y-auto">
              <p>
                <span className="font-medium">{node.label}</span>
                {": "}
                {description}
              </p>
              <WorkflowAttemptList accounting={accounting} />
            </div>
          </TooltipPopup>
        </Tooltip>
        {accounting.attempts.length > 0 ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={`Attempts for ${node.label}`} />
              }
            >
              <HistoryIcon aria-hidden />
            </PopoverTrigger>
            <PopoverPopup width="md">
              <PopoverTitle>{node.label} attempts</PopoverTitle>
              <p className="my-2 text-xs text-muted-foreground">
                {totals}. Running time is as of the latest update.
              </p>
              <div className="max-h-64 overflow-y-auto">
                <WorkflowAttemptList accounting={accounting} onOpenThread={props.onOpenThread} />
              </div>
            </PopoverPopup>
          </Popover>
        ) : null}
      </div>
      {node.checkers.map((checker) => (
        <WorkflowChecker key={checker.id} checker={checker} onOpenThread={props.onOpenThread} />
      ))}
    </div>
  );
}

function WorkflowChecker(props: {
  readonly checker: RuntimeSubagent;
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
    <Tooltip>
      <TooltipTrigger
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
      <TooltipPopup className="max-w-80">
        <div className="max-h-64 overflow-y-auto">
          <p>
            {checker.title}: {label} · {identity}
          </p>
          {result ? <p className="whitespace-pre-wrap break-words">{result}</p> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
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

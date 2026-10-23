import {
  WORKFLOW_GRAPH_STATE_LABEL,
  workflowGraphNodeDetail,
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
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentElapsed } from "./AgentElapsed";
import { EnvironmentSubagentAvatar } from "./V2LifecycleRow";
import { type WaveBox, workflowWaveLayout } from "./workflowWaveLayout";

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
  /** The workflow's provider, for nodes whose agent has not started. */
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { graph } = props;
  const layout = workflowWaveLayout(graph.waves);
  const labels = new Map(graph.waves.flat().map((node) => [node.key, node.label] as const));
  return (
    <div className="overflow-x-auto overflow-y-hidden px-1 pb-1" data-workflow-waves>
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
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
                    providerInstanceId={node.member?.providerInstanceId ?? props.providerInstanceId}
                    driver={node.member?.driver ?? props.driver}
                    onOpenThread={props.onOpenThread}
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

function WorkflowNodeCard(props: {
  readonly node: WorkflowGraphNodeView<RuntimeSubagent>;
  readonly box: WaveBox;
  readonly labels: ReadonlyMap<string, string>;
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly driver: ProviderDriverKind | undefined;
  readonly onOpenThread: (threadId: string) => void;
}) {
  const { node, box } = props;
  const { detail, retries } = workflowGraphNodeDetail(node, props.labels);
  const threadId = node.member?.childThreadId ?? null;
  const state = WORKFLOW_GRAPH_STATE_LABEL[node.state];
  const description = [state, retries, detail].filter(Boolean).join(", ");
  const className = cn(
    "group/node absolute flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-card px-2 text-left",
    node.state === "failed" && "border-destructive/50",
    MUTED_STATES.has(node.state) && "opacity-60",
  );
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
        <span
          className={cn(
            "truncate text-2xs",
            node.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {retries ? <span className="font-medium">{retries} · </span> : null}
          {detail ?? state}
        </span>
      </span>
      {node.member?.startedAt ? (
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          <AgentElapsed agent={node.member} compact />
        </span>
      ) : null}
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
              style={style}
              data-node-state={node.state}
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
              style={style}
              data-node-state={node.state}
            />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup className="max-w-80">
        <span className="font-medium">{node.label}</span>
        {": "}
        {description}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The workflow surfaces as the app composes them, in the chat column, right panel and sidebar
 * widths they live in. Each surface takes a fixture variant and renders production components;
 * only the surrounding chrome (the column, the panel card, the sidebar row) is drawn here.
 * Tests mount these inside `captureSurface`.
 */
import { cn } from "../../src/lib/utils";
import { ThreadDetailsControl } from "../../src/components/chat/ThreadDetailsControl";
import {
  ThreadLineageWorkflowRow,
  WorkflowLineageStatus,
  workflowLineageLabel,
} from "../../src/components/chat/ThreadLineageWorkflowRow";
import { ThreadLineageRowList } from "../../src/components/chat/ThreadRelationshipsControl";
import { ThreadRelationshipIcon } from "../../src/components/chat/ThreadRelationshipIcon";
import { WorkflowOpeningBlock } from "../../src/components/chat/WorkflowOpeningBlock";
import { WorkflowReviewCard } from "../../src/components/chat/WorkflowReviewCard";
import { WorkflowWaveCanvas } from "../../src/components/chat/WorkflowWaveCanvas";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
} from "../../src/components/Sidebar.logic";
import {
  SidebarTopStatusBadge,
  sidebarThreadTopStatus,
} from "../../src/components/sidebar/SidebarThreadStatus";
import type { SidebarThreadSummary } from "../../src/types";
import {
  presentWorkflowReview,
  workflowReviewOf,
  type WorkflowReviewDecision,
} from "@t3tools/client-runtime/state/workflowReview";
import { RunId } from "@t3tools/contracts";
import type { WORKFLOW_QA_REVIEW_STATES } from "@t3tools/shared/testing/workflowQa";
import {
  workflowReviewFixtureLargeRecord,
  workflowReviewFixtureRecord,
} from "@t3tools/shared/testing/workflowReviewFixture";
import type { ReactNode } from "react";
import { vi } from "vite-plus/test";

import { QA_DRIVER, QA_ENVIRONMENT, QA_PROVIDERS, QA_PROVIDER_INSTANCE } from "./providers";
import {
  WORKFLOW_QA_NOW,
  workflowFixture,
  workflowScaleFixture,
  workflowModelGlyphFixture,
  workflowScriptProgressFixture,
  workflowCallbackLifecycleFixture,
  type WorkflowCallbackState,
  type WorkflowQaKind,
  type WorkflowQaSidebarState,
  type WorkflowQaVariant,
} from "./workflowFixtures";

const ENVIRONMENT = QA_ENVIRONMENT;
const noop = () => {};

/** The chat timeline's column: centered, capped at the chat content width. */
function ChatColumn({ children }: { readonly children: ReactNode }) {
  return (
    <div
      className="mx-auto w-full max-w-(--chat-content-max-width) bg-background px-4 py-3 text-foreground"
      data-qa-column
    >
      {children}
    </div>
  );
}

/** The workflow block the timeline draws for a workflow T3 runs. */
export function WorkflowBlockSurface(props: {
  readonly kind: WorkflowQaKind;
  readonly variant?: WorkflowQaVariant;
  readonly agentCount?: 4 | 40 | 256;
}) {
  const fixture =
    props.agentCount === undefined
      ? workflowFixture(props.kind, props.variant ?? "running")
      : workflowScaleFixture(props.kind, props.agentCount);
  return (
    <ChatColumn>
      <WorkflowOpeningBlock
        opening={fixture.opening}
        environmentId={ENVIRONMENT}
        onOpenThread={noop}
        heading={fixture.heading}
        progress={fixture.progress}
        {...(fixture.running ? { stop: { onStop: noop, stopping: false, disabled: false } } : {})}
      />
    </ChatColumn>
  );
}

/** A graph workflow's wave canvas alone, in the chat column. */
export function WorkflowCanvasSurface(props: { readonly variant: WorkflowQaVariant }) {
  const graph = workflowFixture("graph", props.variant).group.graph;
  if (graph === null) throw new Error("A graph fixture always has a graph.");
  return (
    <ChatColumn>
      <WorkflowWaveCanvas graph={graph} environmentId={ENVIRONMENT} onOpenThread={noop} />
    </ChatColumn>
  );
}

export function WorkflowModelGlyphSurface() {
  const fixture = workflowModelGlyphFixture();
  return (
    <ChatColumn>
      <WorkflowOpeningBlock
        opening={fixture.opening}
        environmentId={ENVIRONMENT}
        onOpenThread={noop}
      />
    </ChatColumn>
  );
}

export function WorkflowScriptProgressSurface(
  props: { readonly entered: boolean } | { readonly state: WorkflowCallbackState },
) {
  const fixture =
    "state" in props
      ? workflowCallbackLifecycleFixture(props.state)
      : workflowScriptProgressFixture(props.entered);
  return (
    <ChatColumn>
      <WorkflowOpeningBlock
        opening={fixture.opening}
        environmentId={ENVIRONMENT}
        onOpenThread={noop}
      />
    </ChatColumn>
  );
}

/** A workflow's row in the Lineage list of the thread details panel. */
export function LineageRowSurface(props: {
  readonly kind: WorkflowQaKind;
  readonly variant: WorkflowQaVariant;
  /** A narrow right panel, as at the smallest width the details panel is dragged to. */
  readonly narrow?: boolean;
}) {
  const { group, running } = workflowFixture(props.kind, props.variant);
  const { workflow } = group;
  // Mirrors the header ThreadRelationshipsControl passes to the row.
  const header = (
    <ThreadDetailsControl size="sm" variant="ghost" part="primary">
      <ThreadRelationshipIcon status={workflow.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
          {workflowLineageLabel(workflow)}
        </span>
      </span>
      <WorkflowLineageStatus
        workflow={workflow}
        // Stop takes the status's place while the row is hovered, focused or on a touch screen.
        className={
          running
            ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
            : undefined
        }
      />
    </ThreadDetailsControl>
  );
  return (
    <div
      className={cn(
        "w-full rounded-xl border border-border bg-popover p-1.5 text-popover-foreground",
        props.narrow === true ? "max-w-60" : "max-w-80",
      )}
      data-qa-panel
    >
      <p className="px-2.5 pb-1 text-2xs font-medium text-muted-foreground">Lineage</p>
      <ThreadLineageRowList hiddenCount={0} onShowMore={noop}>
        <ThreadLineageWorkflowRow
          group={group}
          header={header}
          providerInstanceId={QA_PROVIDER_INSTANCE}
          provider={QA_PROVIDERS.find((entry) => entry.instanceId === QA_PROVIDER_INSTANCE)}
          providers={QA_PROVIDERS}
          driver={QA_DRIVER}
          onOpenThread={noop}
          isThreadAvailable={() => true}
          onStop={running ? noop : undefined}
          stopping={false}
          stopDisabled={false}
        />
      </ThreadLineageRowList>
    </div>
  );
}

type StatusThread = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "pendingSubagentRequest"
  | "blockedOnThreadWait"
  | "runtime"
  | "latestRun"
  | "goal"
  | "lastVisitedAt"
  | "pendingBackgroundTasks"
>;
type Runtime = NonNullable<StatusThread["runtime"]>;
type LatestRun = NonNullable<StatusThread["latestRun"]>;

const VISITED = new Date(WORKFLOW_QA_NOW - 3_600_000).toISOString();
const RUN = RunId.make("qa-run");
const runtime = (status: Runtime["status"], extra: Partial<Runtime> = {}): Runtime => ({
  status,
  activeRunId: status === "idle" ? null : RUN,
  providerInstanceId: QA_PROVIDER_INSTANCE,
  providerName: "CLI Proxy",
  lastError: null,
  updatedAt: new Date(WORKFLOW_QA_NOW).toISOString(),
  ...extra,
});
const latestRun = (status: LatestRun["status"]): LatestRun => ({
  runId: RUN,
  status,
  requestedAt: new Date(WORKFLOW_QA_NOW - 600_000).toISOString(),
  startedAt: new Date(WORKFLOW_QA_NOW - 590_000).toISOString(),
  completedAt:
    status === "running" || status === "queued"
      ? null
      : new Date(WORKFLOW_QA_NOW - 60_000).toISOString(),
  assistantMessageId: null,
});

/**
 * The thread facts the default sidebar row resolves its status from, for each state. A thread that
 * started a workflow has no facts about it: `turn-ended-workflow-running` is the parent whose own
 * turn ended while the workflow keeps running, and the row cannot tell it from `waiting-idle`.
 */
function sidebarThread(state: WorkflowQaSidebarState): StatusThread {
  const base: StatusThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    pendingSubagentRequest: null,
    blockedOnThreadWait: false,
    goal: null,
    lastVisitedAt: VISITED,
    pendingBackgroundTasks: [],
    runtime: runtime("idle"),
    latestRun: latestRun("completed"),
  };
  switch (state) {
    case "queued":
      return { ...base, runtime: runtime("queued"), latestRun: latestRun("queued") };
    case "running":
    case "long-title":
      return { ...base, runtime: runtime("running"), latestRun: latestRun("running") };
    case "waiting-on-thread":
      return {
        ...base,
        runtime: runtime("running"),
        latestRun: latestRun("running"),
        blockedOnThreadWait: true,
      };
    case "turn-ended-workflow-running":
      return {
        ...base,
        pendingBackgroundTasks: [
          { taskId: "qa-workflow", kind: "background_task", description: "Project file counts" },
        ],
      };
    case "failed":
      return { ...base, runtime: runtime("failed"), latestRun: latestRun("failed") };
    case "limited":
      return {
        ...base,
        runtime: runtime("failed", { lastErrorClass: "usage_limit" }),
        latestRun: latestRun("failed"),
      };
    case "approval":
      return { ...base, hasPendingApprovals: true };
    case "input":
      return { ...base, hasPendingUserInput: true };
    case "done-unread":
      // No live runtime, and the run finished after the person last looked.
      return {
        ...base,
        runtime: null,
        lastVisitedAt: new Date(WORKFLOW_QA_NOW - 3_600_000).toISOString(),
        latestRun: latestRun("completed"),
      };
    case "waiting-idle":
      return base;
  }
}

/**
 * One default sidebar row's status: the thread facts go through `resolveSidebarThreadStatus` and
 * the same top-status derivation and badge the row uses (`SidebarThreadRow`). Only the row chrome
 * around the badge, the title and the status slot, is drawn here.
 */
export function SidebarStatusSurface(props: { readonly state: WorkflowQaSidebarState }) {
  const thread = sidebarThread(props.state);
  const status = resolveSidebarThreadStatus(thread);
  const topStatus = sidebarThreadTopStatus({
    status,
    isUnread: hasUnseenCompletion({ ...thread }),
    isWoke: false,
    goalActive: thread.goal?.status === "active",
  });
  // A state that shows no status is a finding, not something to paint over.
  if (topStatus === null) throw new Error(`The sidebar shows no status for "${props.state}".`);
  const title =
    props.state === "long-title"
      ? "Dependency drift audit across every package in the monorepo and its generated workspaces"
      : "Project file counts";
  return (
    <div
      className="w-72 max-w-full rounded-lg border border-sidebar-border bg-sidebar p-1.5 text-sidebar-foreground"
      data-qa-sidebar
    >
      <div className="flex h-8 items-center gap-2 rounded-md px-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <span className="ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs">
          <span className="flex items-center self-center justify-self-end tabular-nums text-secondary-label">
            <SidebarTopStatusBadge
              topStatus={topStatus}
              durationStartedAt={
                status === "working"
                  ? resolveWorkingStartedAt(thread)
                  : status === "waiting"
                    ? (thread.latestRun?.completedAt ?? null)
                    : undefined
              }
            />
          </span>
        </span>
      </div>
    </div>
  );
}

/** Scrolls a workflow's wave canvas until one node sits at its top-left, and waits for its card. */
export async function scrollWavesToNode(container: HTMLElement, nodeKey: string): Promise<void> {
  const scroller = container.querySelector<HTMLElement>("[data-workflow-waves]");
  const node = scroller?.querySelector<HTMLElement>(
    `[data-workflow-node="${CSS.escape(nodeKey)}"]`,
  );
  if (!scroller || !node) throw new Error(`No node "${nodeKey}" in the wave canvas.`);
  const from = scroller.getBoundingClientRect();
  const to = node.getBoundingClientRect();
  scroller.scrollLeft += to.left - from.left - 8;
  scroller.scrollTop += to.top - from.top - 8;
  // Cards outside the window are placeholders; the real card replaces one once it is in view.
  await vi.waitFor(() => {
    if (
      !scroller.querySelector(`[data-workflow-node="${CSS.escape(nodeKey)}"] [data-node-state]`)
    ) {
      throw new Error(`Node "${nodeKey}" is still a placeholder.`);
    }
  });
}

const REVIEW_DECISIONS: Record<(typeof WORKFLOW_QA_REVIEW_STATES)[number], WorkflowReviewDecision> =
  {
    pending: { _tag: "idle" },
    large: { _tag: "idle" },
    approving: { _tag: "pending", action: "approve" },
    approved: { _tag: "settled", action: "approve" },
    dismissed: { _tag: "settled", action: "dismiss" },
    stale: {
      _tag: "failed",
      action: "approve",
      kind: "stale",
      message: "This review is out of date. Ask the agent to review the graph again.",
    },
  };

/** The card the coordinator's reviewed graph becomes, in the chat column. */
export function WorkflowReviewSurface(props: {
  readonly state: (typeof WORKFLOW_QA_REVIEW_STATES)[number];
}) {
  const record =
    props.state === "large" ? workflowReviewFixtureLargeRecord(400) : workflowReviewFixtureRecord();
  const review = workflowReviewOf(record);
  return (
    <ChatColumn>
      <WorkflowReviewCard
        review={review}
        presentation={presentWorkflowReview({
          review,
          decision: REVIEW_DECISIONS[props.state],
          canDecide: true,
          superseded: false,
          local: true,
        })}
        providers={QA_PROVIDERS}
        onApprove={noop}
        onDismiss={noop}
      />
    </ChatColumn>
  );
}

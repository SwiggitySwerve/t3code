import { groupBy } from "effect/Array";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2AppThread,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2TurnItem,
  OrchestrationV2WorkflowNodeOutcome,
  OrchestrationV2WorkflowPlan,
} from "@t3tools/contracts";
import {
  isOrchestrationV2ActiveWorkflowMember,
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
} from "@t3tools/contracts";
import { storedWorkflowScriptSource } from "@t3tools/shared/storedWorkflowScript";

import { deriveWorkflowGraph, type WorkflowGraphView } from "./workflowGraphView.ts";
import { deriveWorkflowProgress, workflowCountsText } from "./workflowProgress.ts";
import { workflowBudget } from "@t3tools/shared/workflowBudget";
import {
  isWorkflowScriptMessage,
  workflowOpeningParentThreadId,
  workflowOpeningTitles,
  workflowPhaseTitles,
} from "@t3tools/shared/workflowOpeningText";

export {
  WORKFLOW_GRAPH_STATE_LABEL,
  workflowGraphHeadline,
  workflowGraphNodeDetail,
  type WorkflowGraphNodeState,
  type WorkflowGraphNodeView,
  type WorkflowGraphView,
} from "./workflowGraphView.ts";
export { workflowNodeAccounting } from "./workflowAttempts.ts";
export {
  appWorkflowHeading,
  deriveWorkflowProgress,
  workflowCountsText,
  workflowSettledText,
  type WorkflowPhaseProgress,
  type WorkflowProgressCounts,
  type WorkflowTaskProgress,
} from "./workflowProgress.ts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly transcriptDir?: string | undefined;
  readonly sessionUrl?: string | undefined;
}

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly speed?: string | undefined;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly intent?: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly childThreadId: string | null;
  /** A workflow member's own provider, when it can differ from its workflow's. */
  readonly providerInstanceId?: OrchestrationV2Subagent["providerInstanceId"] | undefined;
  readonly driver?: OrchestrationV2Subagent["driver"] | undefined;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** A graph workflow's plan and the outcomes recorded so far; only on the workflow itself. */
  readonly graph?:
    | {
        readonly plan: OrchestrationV2WorkflowPlan;
        readonly nodeOutcomes: Readonly<Record<string, OrchestrationV2WorkflowNodeOutcome>>;
      }
    | undefined;
  /** The graph node a workflow member runs. */
  readonly graphNodeKey?: string | undefined;
  readonly judgmentFor?: OrchestrationV2SubagentWorkflow["agents"][number]["judgmentFor"];
  readonly judgmentOutcome?: OrchestrationV2SubagentWorkflow["agents"][number]["judgmentOutcome"];
  readonly attemptHistory?: OrchestrationV2SubagentWorkflow["agents"][number]["attemptHistory"];
  readonly attemptTaskIds?: ReadonlyArray<string> | undefined;
  readonly taskId?: string | undefined;
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return isOrchestrationV2WorkActive(status);
}

export function isLiveSubagentTurnItem(item: OrchestrationV2TurnItem): boolean {
  return item.type === "subagent" && isOrchestrationV2WorkActive(item.status);
}

/**
 * A subagent item that may be a workflow T3 runs: app-owned with no thread of its own.
 * Only the parent's subagent row can confirm it (see isAppWorkflow).
 */
export function isAppWorkflowCandidateTurnItem(item: OrchestrationV2TurnItem): boolean {
  return item.type === "subagent" && item.origin === "app_owned" && item.childThreadId === null;
}

/** Matches the app-owned workflow entry point, never a completed child thread. */
export function isAppWorkflowTurnItem(
  item: OrchestrationV2TurnItem,
  workflowIds?: ReadonlySet<string>,
): boolean {
  return (
    item.type === "subagent" &&
    item.origin === "app_owned" &&
    workflowIds?.has(item.subagentId) === true
  );
}

/** Identity recorded on the member after dispatch, never the plan or coordinator's target. */
export function workflowMemberIdentity(member: RuntimeSubagent | null): string {
  if (member === null) return "Not started";
  if (member.childThreadId === null && member.startedAt === null && member.model === null)
    return "Not started";
  return `${member.providerInstanceId ?? "Unknown provider"} / ${member.model ?? "Unknown model"}`;
}

/** Old graph errors embedded the full outcome record; arbitrary script text stays intact. */
export function workflowProgressText(row: {
  readonly status: OrchestrationV2Subagent["status"];
  readonly progress?: string | undefined;
  readonly result: string | null;
  readonly workflow?: OrchestrationV2SubagentWorkflow | undefined;
}): string | null {
  if (row.status === "running") return row.progress ?? null;
  const plan = row.workflow?.plan;
  if (plan === undefined || row.result === null) return row.result;
  const prefix = "The workflow failed: Graph failed: ";
  if (row.result.startsWith(prefix)) {
    const recorded = plan.nodes.flatMap((node) => {
      const outcome = row.workflow?.nodeOutcomes?.[node.key];
      return outcome === undefined ? [] : [{ ...outcome, label: node.label }];
    });
    // The header counts and the failed node already say this; the text would say it a third time.
    if (recorded.some((node) => node.status === "failed")) return null;
  }
  const raw = row.result.startsWith(prefix) ? row.result.slice(prefix.length) : row.result;
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    // QuickJS appends the source location to thrown errors, outside their JSON record.
    const location = raw.lastIndexOf(" (at ");
    if (!row.result.startsWith(prefix) || location < 0) return row.result;
    try {
      record = JSON.parse(raw.slice(0, location));
    } catch {
      return row.result;
    }
  }
  if (typeof record !== "object" || record === null || !("ok" in record) || !("nodes" in record))
    return row.result;
  const outcomes = record.nodes;
  if (
    typeof record.ok !== "boolean" ||
    typeof outcomes !== "object" ||
    outcomes === null ||
    Array.isArray(outcomes)
  )
    return row.result;
  const nodes: Array<{ label: string; status: string; reason?: string }> = [];
  for (const node of plan.nodes) {
    const outcome: unknown = Object.getOwnPropertyDescriptor(outcomes, node.key)?.value;
    if (
      typeof outcome !== "object" ||
      outcome === null ||
      !("status" in outcome) ||
      !["passed", "failed", "skipped"].includes(String(outcome.status))
    )
      return row.result;
    const recorded = row.workflow?.nodeOutcomes?.[node.key];
    nodes.push({
      label: node.label,
      status: recorded?.status ?? String(outcome.status),
      ...(recorded?.reason !== undefined
        ? { reason: recorded.reason }
        : "reason" in outcome && typeof outcome.reason === "string"
          ? { reason: outcome.reason }
          : {}),
    });
  }
  if (record.ok && nodes.every((node) => node.status === "passed")) return null;
  return record.ok === false && nodes.some((node) => node.status === "failed") ? null : row.result;
}

export interface SubagentWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    readonly state: "pending" | "running" | "done";
    readonly settledCount: number;
  }>;
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
  /** Node by node, for a workflow started from a reviewed graph; null for scripts. */
  readonly graph: WorkflowGraphView<RuntimeSubagent> | null;
}

function workflowUsage(source: {
  readonly totalTokens?: number | undefined;
  readonly toolCalls?: number | undefined;
  readonly durationMs?: number | undefined;
}): SubagentUsage | null {
  if (source.totalTokens === undefined) return null;
  return {
    totalTokens: source.totalTokens,
    ...(source.toolCalls === undefined ? {} : { toolUses: source.toolCalls }),
    ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
  };
}

function isoFromEpochMillis(value: number | undefined): string | null {
  return value === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(value));
}

function workflowMembersToRuntime(
  coordinator: RuntimeSubagent,
  workflow: OrchestrationV2SubagentWorkflow,
): ReadonlyArray<RuntimeSubagent> {
  return workflow.agents.map((agent) => {
    const status =
      (agent.state === "queued" || agent.state === "running") &&
      isTerminalSubagentStatus(coordinator.status)
        ? coordinator.status === "completed"
          ? "interrupted"
          : coordinator.status
        : agent.state === "queued"
          ? "pending"
          : agent.state;
    const failed = status === "failed";
    const startedAt = isoFromEpochMillis(agent.startedAt);
    const completedAt = isTerminalSubagentStatus(status)
      ? (isoFromEpochMillis(agent.completedAt) ??
        (agent.startedAt !== undefined && agent.durationMs !== undefined
          ? isoFromEpochMillis(agent.startedAt + agent.durationMs)
          : coordinator.completedAt))
      : null;
    return {
      ...coordinator,
      id: `${coordinator.id}:agent:${agent.index}`,
      kind: "workflow_agent" as const,
      title: agent.label,
      model: agent.model ?? null,
      effort: agent.effort ?? null,
      ...(agent.speed === undefined ? {} : { speed: agent.speed }),
      status,
      activationCount: agent.attempt ?? 1,
      usage: workflowUsage(agent),
      intent: agent.prompt ?? null,
      progress: null,
      result: failed ? null : (agent.result ?? null),
      error: failed ? (agent.result ?? null) : null,
      parentAgentId: coordinator.id,
      agentIndex: agent.index,
      phaseIndex: agent.phaseIndex ?? null,
      phaseTitle: agent.phaseTitle ?? null,
      attempt: agent.attempt ?? null,
      phases: [],
      childThreadId: agent.childThreadId ?? null,
      providerInstanceId: agent.providerInstanceId,
      driver: agent.driver,
      recentActivity: [],
      graph: undefined,
      graphNodeKey: agent.graphNodeKey,
      judgmentFor: agent.judgmentFor,
      judgmentOutcome: agent.judgmentOutcome,
      attemptHistory: agent.attemptHistory,
      attemptTaskIds: agent.attemptTaskIds,
      taskId: agent.agentId,
      firstSeenAt: isoFromEpochMillis(agent.queuedAt) ?? startedAt ?? coordinator.firstSeenAt,
      startedAt,
      completedAt,
      updatedAt: completedAt ?? startedAt ?? coordinator.firstSeenAt,
    } satisfies RuntimeSubagent;
  });
}

export function projectedSubagentsToRuntime(
  subagents: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null;
    readonly prompt: string;
    readonly model: string | null;
    readonly status: OrchestrationV2Subagent["status"];
    readonly progress?: string | undefined;
    readonly childThreadId?: string | null | undefined;
    readonly workflow?: OrchestrationV2SubagentWorkflow | undefined;
    readonly result: string | null;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  }>,
): ReadonlyArray<RuntimeSubagent> {
  return subagents.flatMap((subagent) => {
    const updatedAt = DateTime.formatIso(subagent.updatedAt);
    const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
    const firstSeenAt = startedAt ?? updatedAt;
    const { workflow } = subagent;
    const runHandles = workflow?.runHandles ?? null;
    const coordinator = {
      id: subagent.id,
      kind: workflow === undefined ? "subagent" : "workflow",
      title:
        subagent.title ??
        (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}...` : subagent.prompt),
      role: null,
      model: subagent.model,
      effort: null,
      status: subagent.status,
      activationCount: 1,
      usage: workflow === undefined ? null : workflowUsage(workflow),
      progress: subagent.progress ?? null,
      lastToolName: null,
      result: subagent.result,
      error: subagent.status === "failed" ? (subagent.result ?? null) : null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: workflow?.name ?? null,
      phases: workflow?.phases ?? [],
      runHandles,
      childThreadId: subagent.childThreadId ?? null,
      recentActivity: [],
      graph:
        workflow?.plan === undefined
          ? undefined
          : { plan: workflow.plan, nodeOutcomes: workflow.nodeOutcomes ?? {} },
      firstSeenAt,
      startedAt,
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
      updatedAt,
    } satisfies RuntimeSubagent;
    return workflow === undefined
      ? [coordinator]
      : [coordinator, ...workflowMembersToRuntime(coordinator, workflow)];
  });
}

export function deriveWorkflowGroups(
  agents: ReadonlyArray<RuntimeSubagent>,
): ReadonlyArray<SubagentWorkflowGroup> {
  const workflows = agents
    .filter((agent) => agent.kind === "workflow")
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const members = groupBy(
    agents.filter((agent) => agent.kind === "workflow_agent" && agent.parentAgentId !== null),
    (agent) => agent.parentAgentId!,
  );

  return workflows.map((workflow) => {
    const workflowMembers = [
      ...new Map(
        (Object.hasOwn(members, workflow.id) ? members[workflow.id]! : []).map((member) => [
          member.agentIndex ?? member.id,
          member,
        ]),
      ).values(),
    ];
    const knownPhases = workflowPhaseTitles({
      declared: workflow.phases,
      members: workflowMembers,
    });

    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const hasActiveMember = phaseMembers.some(
        // Idle members count as active for phase-liveness: a resumable Codex
        // member has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      );
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0 ? "pending" : hasActiveMember ? "running" : "done";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        settledCount,
      };
    });

    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null)
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    const graph =
      workflow.graph === undefined
        ? null
        : deriveWorkflowGraph({
            plan: workflow.graph.plan,
            nodeOutcomes: workflow.graph.nodeOutcomes,
            members: [...workflowMembers].sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0)),
            active: !isTerminalSubagentStatus(workflow.status),
          });

    return { workflow, phases, unphasedMembers, graph };
  });
}

// The rules for what a workflow opening is, and the text it draws, live in one shared module so the
// server counts find matches from the same strings.
export { workflowOpeningParentThreadId };

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number] &
  Pick<OrchestrationV2Subagent, "driver" | "providerInstanceId">;

export interface WorkflowOpening {
  readonly budget?: ReturnType<typeof workflowBudget>;
  readonly messageId: string;
  readonly script: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly driver: OrchestrationV2Subagent["driver"] | null;
  readonly providerInstanceId: OrchestrationV2Subagent["providerInstanceId"] | null;
  /** Null until the parent thread's coordinator row is loaded. */
  readonly group: SubagentWorkflowGroup | null;
}

/**
 * The opening of a workflow coordinator's thread: its first user message is the workflow script,
 * shown as the workflow's plan. The coordinator row lives on the parent thread, so
 * `parentSubagents` is the parent projection's subagents, or null when it is not loaded.
 */
export function resolveWorkflowOpening(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "lineage" | "creationSource">;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly workflowScript?: boolean | undefined;
  }>;
  readonly parentSubagents: ReadonlyArray<ProjectedSubagent> | null;
}): WorkflowOpening | null {
  if (!isProviderNativeSubagentThread(input.thread)) return null;
  const first = input.messages.find((message) => message.role === "user");
  if (first === undefined) return null;
  const coordinator = input.parentSubagents?.find(
    (subagent) => subagent.childThreadId === input.thread.id,
  );
  if (first.workflowScript === false) return null;
  if (coordinator?.workflow === undefined && !isWorkflowScriptMessage(first)) return null;
  return {
    messageId: first.id,
    script: first.text,
    name: coordinator?.workflow?.name ?? null,
    description: coordinator?.title ?? null,
    driver: coordinator?.driver ?? null,
    providerInstanceId: coordinator?.providerInstanceId ?? null,
    group:
      coordinator?.workflow === undefined
        ? null
        : (deriveWorkflowGroups(projectedSubagentsToRuntime([coordinator]))[0] ?? null),
  };
}

/** The opening block's heading: the workflow, what it does, and how its agents stand. */
export function workflowOpeningHeadline(opening: WorkflowOpening): {
  readonly title: string;
  readonly description: string | null;
  readonly agents: string | null;
} {
  const { title, description } = workflowOpeningTitles({
    name: opening.name,
    description: opening.description,
  });
  const counts = opening.group === null ? null : deriveWorkflowProgress(opening.group).counts;
  const agents =
    counts === null || counts.observed === 0
      ? null
      : `${counts.observed} ${counts.observed === 1 ? "agent" : "agents"} · ${workflowCountsText(counts)}`;
  return { title, description, agents };
}

type AppWorkflowCandidate = ProjectedSubagent &
  Pick<OrchestrationV2Subagent, "origin" | "parentNodeId">;

/**
 * A workflow T3 itself runs (workflow_start): an app-owned row on the calling thread with no
 * thread of its own. Its agents are app-owned tasks whose parent node is the row.
 */
export function isAppWorkflow(subagent: {
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly childThreadId?: string | null | undefined;
  readonly workflow?: OrchestrationV2SubagentWorkflow | undefined;
}): boolean {
  return (
    subagent.origin === "app_owned" &&
    subagent.workflow !== undefined &&
    subagent.childThreadId == null
  );
}

/** Each T3-run workflow's member threads, in the order the workflow started them. */
export function appWorkflowMemberThreads(
  subagents: ReadonlyArray<AppWorkflowCandidate>,
): ReadonlyMap<string, ReadonlyArray<string>> {
  const members = new Map<string, Array<string>>();
  for (const workflow of subagents) {
    if (!isAppWorkflow(workflow)) continue;
    const threads = (workflow.workflow?.agents ?? []).flatMap((agent) =>
      agent.childThreadId === undefined ? [] : [agent.childThreadId as string],
    );
    for (const task of subagents) {
      if (
        task.parentNodeId === workflow.id &&
        task.childThreadId != null &&
        !threads.includes(task.childThreadId)
      ) {
        threads.push(task.childThreadId);
      }
    }
    members.set(workflow.id, threads);
  }
  return members;
}

/**
 * Whether Stop applies to a workflow: it is running, and it is one T3 runs or a Claude workflow T3
 * can ask the provider to stop. The row must already be known to be a workflow; the server stays
 * the authority and refuses the rest.
 */
export function canStopWorkflow(workflow: {
  readonly status: OrchestrationV2Subagent["status"];
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: OrchestrationV2Subagent["driver"] | null;
}): boolean {
  return (
    workflow.status === "running" &&
    (workflow.origin === "app_owned" ||
      (workflow.origin === "provider_native" && workflow.driver === "claudeAgent"))
  );
}

/**
 * Whether Stop is on offer for a workflow row: it is running, or a T3-run workflow still has an
 * active member. A stop cancels the row before its members, so a failed member stop leaves the row
 * cancelled with members running, and Stop stays so the whole stop can be repeated.
 */
export function canStopWorkflowWork(
  workflow: Pick<OrchestrationV2Subagent, "id" | "status" | "origin"> & {
    readonly driver: OrchestrationV2Subagent["driver"] | null;
  },
  subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "parentNodeId" | "childThreadId" | "status">
  >,
): boolean {
  return (
    canStopWorkflow(workflow) ||
    (workflow.origin === "app_owned" &&
      subagents.some((member) => isOrchestrationV2ActiveWorkflowMember(member, workflow.id)))
  );
}

/**
 * A T3-run workflow described as a workflow opening: its plan and agents.
 * The opening also carries the workflow script as data; this view does not
 * decide whether or where a client displays it.
 */
export function resolveAppWorkflowView(subagent: AppWorkflowCandidate): WorkflowOpening | null {
  if (!isAppWorkflow(subagent)) return null;
  return {
    ...(subagent.workflow?.budget === undefined
      ? {}
      : { budget: workflowBudget(subagent.workflow) }),
    messageId: subagent.id,
    script: storedWorkflowScriptSource(subagent.prompt),
    name: subagent.workflow?.name ?? null,
    description: subagent.title,
    driver: subagent.driver,
    providerInstanceId: subagent.providerInstanceId,
    group: deriveWorkflowGroups(projectedSubagentsToRuntime([subagent]))[0] ?? null,
  };
}

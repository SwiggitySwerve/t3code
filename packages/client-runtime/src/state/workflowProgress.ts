import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
  SubagentWorkflowGroup,
} from "./subagentRuntime.ts";
import type { WorkflowGraphNodeState } from "./workflowGraphView.ts";

export type WorkflowTaskState = "done" | "running" | "failed" | "queued" | "stopped" | "skipped";

export interface WorkflowTaskProgress {
  readonly id: string;
  readonly label: string;
  readonly state: WorkflowTaskState;
  readonly detail: string | null;
  readonly member: RuntimeSubagent | null;
}

export interface WorkflowProgressCounts {
  readonly done: number;
  readonly running: number;
  readonly failed: number;
  readonly queued: number;
  readonly stopped: number;
  readonly skipped: number;
  readonly settled: number;
  readonly observed: number;
  /** Null for scripts: discovered agents do not declare the size of a phase. */
  readonly total: number | null;
}

export interface WorkflowPhaseProgress {
  readonly id: string;
  readonly title: string;
  readonly tasks: ReadonlyArray<WorkflowTaskProgress>;
  readonly counts: WorkflowProgressCounts;
  readonly allDone: boolean;
}

export function appWorkflowHeading(status: RuntimeSubagentStatus): string {
  switch (status) {
    case "running":
      return "Workflow running";
    case "completed":
      return "Workflow finished";
    case "failed":
      return "Workflow failed";
    case "cancelled":
    case "interrupted":
      return "Workflow stopped";
    default:
      return "Workflow";
  }
}

const MEMBER_STATE: Record<RuntimeSubagentStatus, WorkflowTaskState> = {
  completed: "done",
  running: "running",
  waiting: "running",
  idle: "running",
  pending: "queued",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

const NODE_STATE: Record<WorkflowGraphNodeState, WorkflowTaskState> = {
  passed: "done",
  running: "running",
  queued: "queued",
  waiting: "queued",
  failed: "failed",
  skipped: "skipped",
  not_run: "stopped",
  interrupted: "stopped",
};

function countTasks(
  tasks: ReadonlyArray<WorkflowTaskProgress>,
  total: number | null,
): WorkflowProgressCounts {
  const counts = { done: 0, running: 0, failed: 0, queued: 0, stopped: 0, skipped: 0 };
  for (const task of tasks) counts[task.state] += 1;
  return {
    ...counts,
    settled: counts.done + counts.failed + counts.stopped + counts.skipped,
    observed: tasks.length,
    total,
  };
}

function memberTask(member: RuntimeSubagent): WorkflowTaskProgress {
  return {
    id: member.id,
    label: member.title,
    state: MEMBER_STATE[member.status],
    member,
    detail:
      member.status === "failed"
        ? (member.error ?? member.result)
        : (member.result ?? member.progress),
  };
}

function phaseProgress(
  id: string,
  title: string,
  tasks: ReadonlyArray<WorkflowTaskProgress>,
  total: number | null,
): WorkflowPhaseProgress {
  const counts = countTasks(tasks, total);
  return { id, title, tasks, counts, allDone: tasks.length > 0 && counts.done === tasks.length };
}

function latestStartedOrFinishedMember(
  tasks: ReadonlyArray<WorkflowTaskProgress>,
): RuntimeSubagent | null {
  let latest: { task: WorkflowTaskProgress; at: number } | null = null;
  for (const task of tasks) {
    const member = task.member;
    if (member === null) continue;
    for (const timestamp of [member.startedAt, member.completedAt]) {
      const at = timestamp === null ? NaN : Date.parse(timestamp);
      if (!Number.isFinite(at)) continue;
      if (latest === null || at > latest.at || (at === latest.at && task.id < latest.task.id))
        latest = { task, at };
    }
  }
  return latest?.task.member ?? null;
}

/** Graph nodes own retry identity; script agents keep their index across attempts. */
export function deriveWorkflowProgress(group: SubagentWorkflowGroup) {
  const phases: WorkflowPhaseProgress[] =
    group.graph === null
      ? group.phases.map((phase) =>
          phaseProgress(`phase:${phase.index}`, phase.title, phase.members.map(memberTask), null),
        )
      : group.graph.waves.map((wave) => {
          const tasks = wave.map((node): WorkflowTaskProgress => ({
            id: node.key,
            label: node.label,
            state: NODE_STATE[node.state],
            member: node.member,
            detail:
              node.reason ??
              (node.state === "failed"
                ? node.member?.error
                : (node.member?.result ?? node.member?.progress)) ??
              null,
          }));
          const index = wave[0]!.wave;
          return phaseProgress(`wave:${index}`, `Phase ${index + 1}`, tasks, tasks.length);
        });
  const plannedTasks = phases.flatMap((phase) => phase.tasks);
  const other = group.graph?.otherMembers ?? group.unphasedMembers;
  if (other.length > 0)
    phases.push(phaseProgress("other", "Other agents", other.map(memberTask), null));
  const tasks = phases.flatMap((phase) => phase.tasks);
  const counts = countTasks(
    group.graph === null ? tasks : plannedTasks,
    group.graph === null ? null : plannedTasks.length,
  );
  const failure = tasks.find((task) => task.state === "failed");
  const failedCount = tasks.filter((task) => task.state === "failed").length;
  const current =
    phases.find((phase) => phase.counts.running > 0) ??
    phases.find((phase) => phase.counts.queued > 0) ??
    phases.at(-1);
  const terminal =
    group.workflow.status === "failed" ||
    group.workflow.status === "completed" ||
    group.workflow.status === "cancelled" ||
    group.workflow.status === "interrupted";
  const activity = group.workflow.progress?.trim();
  const headlineMember =
    failure === undefined && !terminal && !activity ? latestStartedOrFinishedMember(tasks) : null;
  const headline =
    failure !== undefined
      ? `${failedCount} ${failedCount === 1 ? "agent" : "agents"} failed · ${failure.label}${failure.detail ? `: ${failure.detail}` : ""}`
      : group.workflow.status === "failed"
        ? (group.workflow.error ?? "Workflow failed")
        : terminal
          ? `${appWorkflowHeading(group.workflow.status)} · ${workflowSettledText(counts)}`
          : activity ||
            `${current?.title ?? "Workflow"} · ${current?.counts.running ?? counts.running} running`;
  const successful =
    group.workflow.status === "completed" &&
    tasks.length > 0 &&
    phases.every((phase) => phase.tasks.length === 0 || phase.allDone);
  return {
    phases,
    counts,
    headline,
    headlineMember,
    successful,
    failedCount,
    agentCount: tasks.length,
  };
}

export function workflowSettledText(counts: WorkflowProgressCounts): string {
  return counts.total === null
    ? `${counts.settled} settled · ${counts.observed} discovered · total unknown`
    : `${counts.settled}/${counts.total} settled`;
}

export function workflowCountsText(counts: WorkflowProgressCounts): string {
  return workflowCountEntries(counts)
    .map(({ state, count }) => `${count} ${state}`)
    .join(" · ");
}

export function workflowCountEntries(counts: WorkflowProgressCounts) {
  return (["done", "failed", "running", "queued", "stopped", "skipped"] as const)
    .filter((state) => counts[state] > 0)
    .map((state) => ({ state, count: counts[state] }));
}

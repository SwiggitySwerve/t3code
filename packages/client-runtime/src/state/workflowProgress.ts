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

function scriptPhase(
  id: string,
  title: string,
  members: ReadonlyArray<RuntimeSubagent>,
): WorkflowPhaseProgress {
  const tasks = members.map(memberTask);
  return { id, title, tasks, counts: countTasks(tasks, null) };
}

/** Graph nodes own retry identity; script agents keep their index across attempts. */
export function deriveWorkflowProgress(group: SubagentWorkflowGroup) {
  const phases: WorkflowPhaseProgress[] =
    group.graph === null
      ? group.phases.map((phase) => scriptPhase(`phase:${phase.index}`, phase.title, phase.members))
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
          return {
            id: `wave:${index}`,
            title: `Phase ${index + 1}`,
            tasks,
            counts: countTasks(tasks, tasks.length),
          };
        });
  const plannedTasks = phases.flatMap((phase) => phase.tasks);
  const other = group.graph?.otherMembers ?? group.unphasedMembers;
  if (other.length > 0) phases.push(scriptPhase("other", "Other agents", other));
  const tasks = phases.flatMap((phase) => phase.tasks);
  const counts = countTasks(
    group.graph === null ? tasks : plannedTasks,
    group.graph === null ? null : plannedTasks.length,
  );
  const failure = tasks.find((task) => task.state === "failed");
  const current =
    phases.find((phase) => phase.counts.running > 0) ??
    phases.find((phase) => phase.counts.queued > 0) ??
    phases.at(-1);
  const headline =
    failure !== undefined
      ? `${failure.label} failed${failure.detail ? `: ${failure.detail}` : ""}`
      : group.workflow.status === "failed"
        ? (group.workflow.error ?? "Workflow failed")
        : group.workflow.status === "completed" ||
            group.workflow.status === "cancelled" ||
            group.workflow.status === "interrupted"
          ? `${appWorkflowHeading(group.workflow.status)} · ${workflowSettledText(counts)}`
          : group.workflow.progress?.trim() ||
            `${current?.title ?? "Workflow"} · ${current?.counts.running ?? counts.running} running · ${workflowSettledText(current?.counts ?? counts)}`;
  const successful =
    group.workflow.status === "completed" &&
    tasks.length > 0 &&
    tasks.every((task) => task.state === "done");
  const failedCount = tasks.filter((task) => task.state === "failed").length;
  return { phases, counts, headline, successful, failedCount, agentCount: tasks.length };
}

export function workflowSettledText(counts: WorkflowProgressCounts): string {
  return counts.total === null
    ? `${counts.settled} settled · ${counts.observed} discovered · total unknown`
    : `${counts.settled}/${counts.total} settled`;
}

export function workflowCountsText(counts: WorkflowProgressCounts): string {
  return (["done", "running", "failed", "queued", "stopped", "skipped"] as const)
    .filter((state) => counts[state] > 0)
    .map((state) => `${counts[state]} ${state}`)
    .join(" · ");
}

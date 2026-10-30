import type {
  RuntimeSubagent,
  RuntimeSubagentStatus,
  SubagentWorkflowGroup,
} from "./subagentRuntime.ts";
import { workflowGraphBlockedReasons, type WorkflowGraphNodeState } from "./workflowGraphView.ts";

export type WorkflowTaskState = "done" | "running" | "failed" | "queued" | "stopped" | "skipped";

export interface WorkflowTaskProgress {
  readonly id: string;
  readonly label: string;
  readonly state: WorkflowTaskState;
  readonly detail: string | null;
  readonly member: RuntimeSubagent | null;
  readonly plannedIdentity?: RuntimeSubagent["plannedIdentity"];
  readonly attention?:
    | {
        readonly kind: "failed" | "blocked" | "retrying" | "waiting";
        readonly reason: string;
      }
    | undefined;
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
  /** Null unless the workflow declares a planned number of logical agents. */
  readonly total: number | null;
}

export interface WorkflowPhaseProgress {
  readonly id: string;
  readonly title: string;
  readonly tasks: ReadonlyArray<WorkflowTaskProgress>;
  readonly counts: WorkflowProgressCounts;
  readonly state: "planned" | "running" | "completed" | "failed" | "stopped" | null;
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

export const WORKFLOW_MEMBER_STATE: Readonly<Record<RuntimeSubagentStatus, WorkflowTaskState>> = {
  completed: "done",
  running: "running",
  waiting: "running",
  idle: "running",
  pending: "queued",
  failed: "failed",
  cancelled: "stopped",
  interrupted: "stopped",
};

export const WORKFLOW_NODE_STATE: Readonly<Record<WorkflowGraphNodeState, WorkflowTaskState>> = {
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
    state: WORKFLOW_MEMBER_STATE[member.status],
    member,
    plannedIdentity: member.plannedIdentity,
    attention: memberAttention(member, WORKFLOW_MEMBER_STATE[member.status]),
    detail:
      member.status === "failed"
        ? (member.error ?? member.result)
        : (member.result ?? member.progress),
  };
}

function memberAttention(
  member: RuntimeSubagent | null,
  state: WorkflowTaskState,
): WorkflowTaskProgress["attention"] {
  if (state === "failed")
    return { kind: "failed", reason: member?.error ?? member?.result ?? "Agent failed" };
  if (state !== "running" || member === null) return undefined;
  if ((member.attempt ?? 0) > 0) return { kind: "retrying", reason: `Retry ${member.attempt}` };
  if (member.status === "waiting") return { kind: "waiting", reason: member.progress ?? "Waiting" };
  return undefined;
}

function phaseProgress(
  id: string,
  title: string,
  tasks: ReadonlyArray<WorkflowTaskProgress>,
  total: number | null,
  declaredState: WorkflowPhaseProgress["state"] = null,
  workflowStatus?: RuntimeSubagentStatus,
): WorkflowPhaseProgress {
  const state =
    declaredState === "running" &&
    workflowStatus !== undefined &&
    ["completed", "failed", "cancelled", "interrupted"].includes(workflowStatus)
      ? workflowStatus === "failed"
        ? "failed"
        : "stopped"
      : declaredState;
  const counts = countTasks(tasks, total);
  const allDone =
    (state === null ? tasks.length > 0 : state === "completed") && counts.done === tasks.length;
  return { id, title, tasks, counts, state, allDone };
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
  const blocked =
    group.graph === null ? new Map<string, string>() : workflowGraphBlockedReasons(group.graph);
  const phases: WorkflowPhaseProgress[] =
    group.graph === null
      ? group.phases.map((phase) =>
          phaseProgress(
            `phase:${phase.index}`,
            phase.title,
            phase.members.filter((member) => member.judgmentFor === undefined).map(memberTask),
            phase.progress?.total ?? null,
            phase.progress?.state ?? null,
            group.workflow.status,
          ),
        )
      : group.graph.waves.map((wave) => {
          const tasks = wave.map((node): WorkflowTaskProgress => ({
            id: node.key,
            label: node.label,
            state: WORKFLOW_NODE_STATE[node.state],
            member: node.member,
            plannedIdentity: node.plannedIdentity ?? node.member?.plannedIdentity,
            attention:
              node.state === "failed"
                ? {
                    kind: "failed",
                    reason:
                      node.reason ?? node.member?.error ?? node.member?.result ?? "Agent failed",
                  }
                : blocked.has(node.key)
                  ? { kind: "blocked", reason: blocked.get(node.key)! }
                  : memberAttention(node.member, WORKFLOW_NODE_STATE[node.state]),
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
  const other = group.graph?.otherMembers ?? [
    ...group.unphasedMembers,
    ...group.phases.flatMap((phase) =>
      phase.members.filter((member) => member.judgmentFor !== undefined),
    ),
  ];
  const scriptTotal =
    phases.length > 0 &&
    phases.every((phase) => phase.counts.total !== null) &&
    group.unphasedMembers.every((member) => member.judgmentFor !== undefined)
      ? phases.reduce((sum, phase) => sum + phase.counts.total!, 0)
      : null;
  if (other.length > 0)
    phases.push(phaseProgress("other", "Other agents", other.map(memberTask), null));
  const tasks = phases.flatMap((phase) => phase.tasks);
  const counts = countTasks(
    group.graph === null
      ? tasks.filter((task) => task.member?.judgmentFor === undefined)
      : plannedTasks,
    group.graph === null ? scriptTotal : plannedTasks.length,
  );
  const failure = tasks.find((task) => task.state === "failed");
  const failedPhase = phases.find((phase) => phase.state === "failed");
  const failedCount = tasks.filter((task) => task.state === "failed").length;
  const current =
    phases.find((phase) => phase.state === "running") ??
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
    failure === undefined && failedPhase === undefined && !terminal && !activity
      ? latestStartedOrFinishedMember(tasks)
      : null;
  // Agent failures are listed in `attention`; the headline says what else is happening.
  const failureSummary =
    failure === undefined
      ? null
      : `${failedCount} ${failedCount === 1 ? "agent" : "agents"} failed · ${failure.label}${failure.detail ? `: ${failure.detail}` : ""}`;
  const headline =
    failedPhase !== undefined
      ? `${failedPhase.title} failed`
      : group.workflow.status === "failed"
        ? (group.workflow.error ?? "Workflow failed")
        : terminal
          ? `${appWorkflowHeading(group.workflow.status)} · ${workflowSettledText(counts)}`
          : activity ||
            `${current?.title ?? "Workflow"} · ${current?.counts.running ?? counts.running} running`;
  const successful =
    group.workflow.status === "completed" &&
    phases.some((phase) => phase.allDone) &&
    phases.every((phase) => phase.allDone || (phase.state === null && phase.tasks.length === 0));
  return {
    phases,
    phaseGroups: deriveWorkflowPhaseGroups(phases),
    attention: tasks
      .filter((task) => task.attention !== undefined)
      .sort(
        (left, right) =>
          Number(right.attention?.kind === "failed") - Number(left.attention?.kind === "failed"),
      ),
    terminal,
    elapsedMs: workflowElapsedMs(group.workflow, terminal),
    counts,
    headline,
    headlineMember,
    failureSummary,
    successful,
    failedCount,
    failedPhaseCount: phases.filter((phase) => phase.state === "failed").length,
    agentCount: tasks.length,
  };
}

function workflowElapsedMs(workflow: RuntimeSubagent, terminal: boolean): number | null {
  if (!terminal || workflow.startedAt === null || workflow.completedAt === null) return null;
  const elapsed = Date.parse(workflow.completedAt) - Date.parse(workflow.startedAt);
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

type CollapseKind = "done" | "queued" | "settled" | "running";

/** Running phases shown expanded; later running phases fold. Phases with a failure never fold. */
const WORKFLOW_EXPANDED_RUNNING_PHASES = 2;

export interface WorkflowPhaseGroup {
  readonly id: string;
  readonly phases: ReadonlyArray<WorkflowPhaseProgress>;
  readonly kind: CollapseKind | null;
  readonly label: string;
  readonly summary: string;
}

function phaseCollapseKind(phase: WorkflowPhaseProgress): CollapseKind | null {
  const { counts, state } = phase;
  if (phase.id === "other" || counts.failed > 0 || state === "failed") return null;
  if (counts.running > 0 || state === "running") return "running";
  if (state === "stopped") return "settled";
  if (
    state === "completed" ||
    (counts.done > 0 &&
      counts.done === counts.observed &&
      (counts.total === null || counts.done === counts.total))
  )
    return "done";
  if (counts.settled > 0 && counts.settled === counts.observed) return "settled";
  if (state === "planned" || (counts.queued > 0 && counts.queued === counts.observed))
    return "queued";
  return null;
}

/**
 * Contiguous done, queued, settled and folded running phases, in phase order. The first
 * `WORKFLOW_EXPANDED_RUNNING_PHASES` running phases stay expanded and later ones fold, so the
 * choice depends only on phase order. A phase with a failure is always expanded and uses no slot.
 */
export function deriveWorkflowPhaseGroups(
  phases: ReadonlyArray<WorkflowPhaseProgress>,
): WorkflowPhaseGroup[] {
  const runs: Array<{ kind: CollapseKind | null; phases: WorkflowPhaseProgress[] }> = [];
  let running = 0;
  for (const phase of phases) {
    let kind = phaseCollapseKind(phase);
    if (kind === "running") {
      running += 1;
      if (running <= WORKFLOW_EXPANDED_RUNNING_PHASES) kind = null;
    }
    const last = runs.at(-1);
    if (kind !== null && last?.kind === kind) last.phases.push(phase);
    else runs.push({ kind, phases: [phase] });
  }
  return runs.map(({ kind, phases: run }) => {
    const first = run[0]!;
    const last = run.at(-1)!;
    const total = run.every((phase) => phase.counts.total !== null)
      ? run.reduce((sum, phase) => sum + phase.counts.total!, 0)
      : null;
    const counts = countTasks(
      run.flatMap((phase) => phase.tasks),
      total,
    );
    const missing = Math.max(0, (total ?? counts.observed) - counts.observed);
    const numeric = /^Phase (\d+)$/.exec(first.title);
    const lastNumeric = /^Phase (\d+)$/.exec(last.title);
    const label =
      run.length === 1
        ? first.title
        : numeric && lastNumeric
          ? `Phases ${numeric[1]}–${lastNumeric[1]}`
          : `${first.title}–${last.title}`;
    const summary =
      kind === "queued"
        ? `${total ?? counts.queued} queued${total === null ? " · total unknown" : ""}`
        : [
            workflowCountsText(counts) || "No agents observed",
            missing > 0 ? `${missing} not observed` : null,
            kind === "settled" && run.some((phase) => phase.state === "stopped")
              ? "phase stopped"
              : null,
            total === null ? "total unknown" : null,
          ]
            .filter(Boolean)
            .join(" · ");
    return { id: run.map((phase) => phase.id).join("/"), phases: run, kind, label, summary };
  });
}

export function workflowSettledText(counts: WorkflowProgressCounts): string {
  return counts.total === null
    ? `${counts.settled} settled · ${counts.observed} discovered · total unknown`
    : `${workflowSettledFraction(counts)} settled`;
}

export function workflowSettledFraction(counts: WorkflowProgressCounts): string {
  return `${counts.settled}/${counts.total ?? "?"}`;
}

export function workflowPhaseStatus(phase: WorkflowPhaseProgress) {
  if (phase.counts.failed > 0 || phase.state === "failed") return "failed";
  if (phase.counts.running > 0 || phase.state === "running") return "running";
  if (phase.counts.stopped > 0 || phase.counts.skipped > 0 || phase.state === "stopped")
    return "stopped";
  if (phase.state === "completed") return "done";
  if (phase.counts.queued > 0 || phase.state === "planned" || phase.counts.observed === 0)
    return "not started";
  return "done";
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

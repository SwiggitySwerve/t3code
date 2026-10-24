/**
 * How a workflow started from a reviewed graph stands, node by node. The server records the
 * plan and each node's outcome; this module owns the rules for every node still without one,
 * so the app can show nodes that never started an agent.
 */
import type {
  OrchestrationV2WorkflowNodeOutcome,
  OrchestrationV2WorkflowPlan,
} from "@t3tools/contracts";

export type WorkflowGraphNodeState =
  | "passed"
  | "failed"
  | "skipped"
  | "running"
  | "queued"
  | "waiting"
  | "not_run"
  | "interrupted";

export interface WorkflowGraphNodeView<Member> {
  readonly key: string;
  readonly label: string;
  readonly wave: number;
  readonly dependsOn: ReadonlyArray<string>;
  /** Nodes that list this one in their dependsOn. */
  readonly dependents: ReadonlyArray<string>;
  readonly state: WorkflowGraphNodeState;
  readonly reason: string | null;
  readonly attempts: number | null;
  /** The agent that runs this node, once one started. */
  readonly member: Member | null;
  readonly checkers: ReadonlyArray<Member>;
}

export interface WorkflowGraphView<Member> {
  /** Nodes by wave (dependency depth), in plan order within each wave. */
  readonly waves: ReadonlyArray<ReadonlyArray<WorkflowGraphNodeView<Member>>>;
  readonly counts: Readonly<Partial<Record<WorkflowGraphNodeState, number>>>;
  /** The started node the most waiting nodes depend on, while the run is active. */
  readonly waitingOn: {
    readonly key: string;
    readonly label: string;
    readonly blocked: number;
  } | null;
  /** Agents not tied to a node, such as the checkers that judge a node's work. */
  readonly otherMembers: ReadonlyArray<Member>;
}

interface GraphMember {
  readonly graphNodeKey?: string | undefined;
  readonly status: string;
  readonly judgmentFor?: { readonly graphNodeKey?: string | undefined } | undefined;
}

function stateWithoutOutcome(member: GraphMember | null, active: boolean): WorkflowGraphNodeState {
  if (member === null) return active ? "waiting" : "not_run";
  if (!active) return "interrupted";
  return member.status === "pending" ? "queued" : "running";
}

export function deriveWorkflowGraph<Member extends GraphMember>(input: {
  readonly plan: OrchestrationV2WorkflowPlan;
  readonly nodeOutcomes: Readonly<Record<string, OrchestrationV2WorkflowNodeOutcome>>;
  /** In start order; a later agent for the same node wins. */
  readonly members: ReadonlyArray<Member>;
  /** Whether the workflow is still running. */
  readonly active: boolean;
}): WorkflowGraphView<Member> {
  const keys = new Set(input.plan.nodes.map((node) => node.key));
  const memberByKey = new Map<string, Member>();
  const otherMembers: Array<Member> = [];
  const checkersByKey = new Map<string, Array<Member>>();
  for (const member of input.members) {
    if (member.judgmentFor !== undefined) {
      const key = member.judgmentFor.graphNodeKey;
      if (key !== undefined && keys.has(key)) {
        const checkers = checkersByKey.get(key) ?? [];
        checkers.push(member);
        checkersByKey.set(key, checkers);
      } else otherMembers.push(member);
    } else if (member.graphNodeKey !== undefined && keys.has(member.graphNodeKey)) {
      memberByKey.set(member.graphNodeKey, member);
    } else {
      otherMembers.push(member);
    }
  }
  const dependents = new Map<string, Array<string>>();
  for (const node of input.plan.nodes) {
    for (const dep of node.dependsOn)
      dependents.set(dep, [...(dependents.get(dep) ?? []), node.key]);
  }

  const nodes = input.plan.nodes.map((node): WorkflowGraphNodeView<Member> => {
    const outcome = Object.hasOwn(input.nodeOutcomes, node.key)
      ? input.nodeOutcomes[node.key]
      : undefined;
    const member = memberByKey.get(node.key) ?? null;
    return {
      key: node.key,
      label: node.label,
      wave: node.wave,
      dependsOn: node.dependsOn,
      dependents: dependents.get(node.key) ?? [],
      state: outcome?.status ?? stateWithoutOutcome(member, input.active),
      reason: outcome?.reason ?? null,
      attempts: outcome?.attempts ?? null,
      member,
      checkers: checkersByKey.get(node.key) ?? [],
    };
  });

  const counts: Partial<Record<WorkflowGraphNodeState, number>> = {};
  for (const node of nodes) counts[node.state] = (counts[node.state] ?? 0) + 1;

  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const waitingBehind = (key: string, seen: Set<string>): number => {
    let count = 0;
    for (const next of byKey.get(key)?.dependents ?? []) {
      if (seen.has(next) || byKey.get(next)?.state !== "waiting") continue;
      seen.add(next);
      count += 1 + waitingBehind(next, seen);
    }
    return count;
  };
  let waitingOn: WorkflowGraphView<Member>["waitingOn"] = null;
  if (input.active) {
    // Plan order already runs by wave, so the first of equal blockers is the earliest.
    for (const node of nodes) {
      if (node.state !== "running" && node.state !== "queued") continue;
      const blocked = waitingBehind(node.key, new Set());
      if (blocked > (waitingOn?.blocked ?? 0)) {
        waitingOn = { key: node.key, label: node.label, blocked };
      }
    }
  }

  const waves = [...new Set(nodes.map((node) => node.wave))]
    .sort((a, b) => a - b)
    .map((wave) => nodes.filter((node) => node.wave === wave));
  return { waves, counts, waitingOn, otherMembers };
}

/** Words for each node state, shared by the summary line and each node's description. */
export const WORKFLOW_GRAPH_STATE_LABEL: Readonly<Record<WorkflowGraphNodeState, string>> = {
  passed: "passed",
  failed: "failed",
  skipped: "skipped",
  running: "running",
  queued: "queued",
  waiting: "waiting",
  not_run: "not run",
  interrupted: "interrupted",
};

const SUMMARY_ORDER: ReadonlyArray<WorkflowGraphNodeState> = [
  "failed",
  "skipped",
  "running",
  "queued",
  "waiting",
  "interrupted",
  "not_run",
];

/** The status line: "3/6 passed · 1 running · 2 waiting", and what the run waits on. */
export function workflowGraphHeadline(graph: WorkflowGraphView<unknown>): {
  readonly summary: string;
  readonly waitingOn: string | null;
} {
  const total = graph.waves.reduce((sum, wave) => sum + wave.length, 0);
  const parts = [`${graph.counts.passed ?? 0}/${total} passed`];
  for (const state of SUMMARY_ORDER) {
    const count = graph.counts[state];
    if (count !== undefined) parts.push(`${count} ${WORKFLOW_GRAPH_STATE_LABEL[state]}`);
  }
  const blocker = graph.waitingOn;
  return {
    summary: parts.join(" · "),
    waitingOn:
      blocker === null
        ? null
        : `Waiting on ${blocker.label}: ${blocker.blocked} ${blocker.blocked === 1 ? "node depends" : "nodes depend"} on it`,
  };
}

/**
 * A node's second line and retry note. The recorded reason comes first; otherwise the nodes it
 * runs after. Retries show while an agent retries and after a node took more than one attempt.
 */
export function workflowGraphNodeDetail(
  node: WorkflowGraphNodeView<{ readonly attempt: number | null }>,
  labels: ReadonlyMap<string, string>,
): { readonly detail: string | null; readonly retries: string | null } {
  const after =
    node.dependsOn.length === 0
      ? null
      : `after ${node.dependsOn.map((key) => labels.get(key) ?? key).join(", ")}`;
  const attempts = node.attempts ?? (node.member?.attempt ?? 0) + 1;
  const retries =
    attempts <= 1
      ? null
      : node.attempts === null
        ? `retry ${attempts - 1}`
        : `${attempts} attempts`;
  return { detail: node.reason ?? after, retries };
}

import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowPatch,
  OrchestrationV2WorkflowUpdate,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

// Leave space for command, persisted event, and stream envelopes, including IDs and timestamps.
const WORKFLOW_PATCH_BYTES = 32 * 1024;
export const WORKFLOW_UPDATE_BYTES = 64 * 1024;
export const workflowJsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

function assertSamePlan(
  previous: OrchestrationV2SubagentWorkflow["plan"],
  next: OrchestrationV2SubagentWorkflow["plan"],
) {
  if (
    previous !== undefined &&
    next !== undefined &&
    JSON.stringify(previous) !== JSON.stringify(next)
  ) {
    throw new Error("A workflow's reviewed plan is immutable.");
  }
}

/** Compact lifecycle-only full rows from existing producers without dropping an unrecognized change. */
export function workflowLifecycleUpdate(
  previous: OrchestrationV2Subagent,
  next: OrchestrationV2Subagent,
): OrchestrationV2WorkflowUpdate | undefined {
  const {
    status,
    progress,
    result,
    completedAt,
    completionDelivery,
    completionWake,
    updatedAt,
    ...rest
  } = next;
  const {
    status: _s,
    progress: _p,
    result: _r,
    completedAt: _c,
    completionDelivery: _d,
    completionWake: _w,
    updatedAt: _u,
    ...oldRest
  } = previous;
  if (
    previous.workflow?.revision === undefined ||
    JSON.stringify(rest) !== JSON.stringify(oldRest) ||
    (previous.progress !== undefined && progress === undefined) ||
    (previous.completionDelivery !== undefined && completionDelivery === undefined) ||
    (previous.completionWake !== undefined && completionWake === undefined)
  )
    return undefined;
  return {
    id: next.id,
    previousRevision: previous.workflow.revision,
    revision: previous.workflow.revision + 1,
    status,
    result,
    completedAt,
    updatedAt,
    ...(progress === undefined ? {} : { progress }),
    ...(completionDelivery === undefined ? {} : { completionDelivery }),
    ...(completionWake === undefined ? {} : { completionWake }),
  };
}

/** The sole patch merger, used by the runner, durable projection, and all clients. */
export function mergeWorkflowPatch(
  previous: OrchestrationV2SubagentWorkflow,
  patch: OrchestrationV2WorkflowPatch,
): OrchestrationV2SubagentWorkflow {
  const { kind: _kind, agents, nodeOutcomes, phaseUpdates, ...fields } = patch;
  assertSamePlan(previous.plan, patch.plan);
  const updates = new Map(agents?.map((agent) => [agent.index, agent]));
  if (updates.size !== (agents?.length ?? 0)) throw new Error("Duplicate workflow agent index.");
  const merged = previous.agents.map((agent) => {
    const next = updates.get(agent.index);
    updates.delete(agent.index);
    return next ?? agent;
  });
  merged.push(...updates.values());
  merged.sort((a, b) => a.index - b.index);
  const phases = new Map((fields.phases ?? previous.phases).map((phase) => [phase.index, phase]));
  const phaseIndices = new Set(phaseUpdates?.map((phase) => phase.index));
  if (phaseIndices.size !== (phaseUpdates?.length ?? 0))
    throw new Error("Duplicate workflow phase index.");
  for (const phase of phaseUpdates ?? []) phases.set(phase.index, phase);
  return {
    ...previous,
    ...fields,
    phases: [...phases.values()].sort((a, b) => a.index - b.index),
    agents: merged,
    ...(nodeOutcomes === undefined
      ? {}
      : { nodeOutcomes: { ...previous.nodeOutcomes, ...nodeOutcomes } }),
  };
}

/** A missing base or revision gap requires a fresh snapshot; never silently apply a partial history. */
export function applyWorkflowUpdate(
  previous: OrchestrationV2Subagent | undefined,
  update: OrchestrationV2WorkflowUpdate,
): OrchestrationV2Subagent {
  if (previous?.workflow === undefined || previous.id !== update.id) {
    throw new Error(`Workflow ${update.id} needs its initial snapshot.`);
  }
  const revision = previous.workflow.revision ?? 0;
  if (update.revision <= revision) return previous;
  if (update.previousRevision !== revision || update.revision !== revision + 1) {
    throw new Error(
      `Workflow ${update.id} revision gap: have ${revision}, received ${update.previousRevision}->${update.revision}.`,
    );
  }
  const { id: _id, previousRevision: _previous, revision: next, patch, ...fields } = update;
  return {
    ...previous,
    ...fields,
    status: fields.status ?? previous.status,
    result: fields.result === undefined ? previous.result : fields.result,
    completedAt: fields.completedAt === undefined ? previous.completedAt : fields.completedAt,
    workflow: {
      ...(patch === undefined ? previous.workflow : mergeWorkflowPatch(previous.workflow, patch)),
      revision: next,
    },
  };
}

/**
 * The workflow row after a patch. Its timeline turn item changes through its own
 * `turn-item.updated` event, which every client understands.
 */
export function applyWorkflowProjectionUpdate<
  P extends Pick<OrchestrationV2ThreadProjection, "subagents">,
>(projection: P, update: OrchestrationV2WorkflowUpdate): P {
  const previous = projection.subagents.find((task) => task.id === update.id);
  const next = applyWorkflowUpdate(previous, update);
  if (next === previous) return projection;
  return {
    ...projection,
    subagents: projection.subagents.map((task) => (task.id === update.id ? next : task)),
  };
}

/** Split concurrent changes before dispatch; each member carries its complete C6 attempt history. */
export function workflowPatches(
  previous: OrchestrationV2SubagentWorkflow,
  next: OrchestrationV2SubagentWorkflow,
): Array<OrchestrationV2WorkflowPatch> {
  assertSamePlan(previous.plan, next.plan);
  const patches: Array<OrchestrationV2WorkflowPatch> = [];
  const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  const nextPhaseIndices = new Set(next.phases.map((phase) => phase.index));
  // A plan is immutable and sent once. An unusually large initial plan is the one-time exception.
  if (next.plan !== undefined && previous.plan === undefined)
    patches.push({ kind: "patch", plan: next.plan });
  const metadata: OrchestrationV2WorkflowPatch = {
    kind: "patch",
    ...(next.name === undefined || next.name === previous.name ? {} : { name: next.name }),
    ...(previous.phases.some((phase) => !nextPhaseIndices.has(phase.index))
      ? { phases: next.phases }
      : {}),
    ...(next.budget === undefined || !changed(previous.budget, next.budget)
      ? {}
      : { budget: next.budget }),
  };
  let current = metadata;
  const append = (addition: OrchestrationV2WorkflowPatch) => {
    const combined = {
      ...current,
      ...(addition.phaseUpdates === undefined
        ? {}
        : { phaseUpdates: [...(current.phaseUpdates ?? []), ...addition.phaseUpdates] }),
      ...(addition.agents === undefined
        ? {}
        : { agents: [...(current.agents ?? []), ...addition.agents] }),
      ...(addition.nodeOutcomes === undefined
        ? {}
        : { nodeOutcomes: { ...current.nodeOutcomes, ...addition.nodeOutcomes } }),
    };
    if (workflowJsonBytes(combined) <= WORKFLOW_PATCH_BYTES) {
      current = combined;
      return;
    }
    if (workflowJsonBytes(addition) > WORKFLOW_PATCH_BYTES)
      throw new Error("One workflow change exceeds the 32 KiB update budget.");
    if (Object.keys(current).length > 1) patches.push(current);
    current = addition;
  };
  if (metadata.phases === undefined) {
    const oldPhases = new Map(previous.phases.map((phase) => [phase.index, phase]));
    for (const phase of next.phases)
      if (changed(oldPhases.get(phase.index), phase))
        append({ kind: "patch", phaseUpdates: [phase] });
  }
  const oldAgents = new Map(previous.agents.map((agent) => [agent.index, agent]));
  for (const agent of next.agents)
    if (changed(oldAgents.get(agent.index), agent)) append({ kind: "patch", agents: [agent] });
  for (const [key, outcome] of Object.entries(next.nodeOutcomes ?? {})) {
    if (changed(previous.nodeOutcomes?.[key], outcome))
      append({ kind: "patch", nodeOutcomes: { [key]: outcome } });
  }
  if (workflowJsonBytes(current) > WORKFLOW_PATCH_BYTES)
    throw new Error("Workflow metadata exceeds the 32 KiB update budget.");
  if (Object.keys(current).length > 1) patches.push(current);
  return patches;
}

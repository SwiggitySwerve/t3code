import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";

/** Recorded child-task usage, including checkers, counted once across retries and reattachment. */
export function workflowRecordedUsage(agents: OrchestrationV2SubagentWorkflow["agents"]) {
  const tasks = new Map<string, { value: number | undefined; complete: boolean }>();
  for (const agent of agents) {
    if (agent.attemptHistory?.length) {
      for (const attempt of agent.attemptHistory) {
        const recorded = tasks.get(attempt.taskId);
        tasks.set(attempt.taskId, {
          value: attempt.totalTokens ?? recorded?.value,
          complete:
            attempt.state !== "running" &&
            attempt.usageStatus === "complete" &&
            attempt.totalTokens !== undefined,
        });
      }
    }
  }
  for (const agent of agents) {
    if (
      !agent.attemptHistory?.length &&
      (agent.agentId !== undefined || agent.totalTokens !== undefined)
    ) {
      // Legacy totals cover the entire member, never each attempt ID separately.
      const ids = [
        ...new Set(agent.attemptTaskIds ?? [agent.agentId ?? `legacy:${agent.index}`]),
      ].sort();
      const covered = ids.filter((id) => tasks.has(id));
      if (covered.length === ids.length) continue;
      const known = covered.reduce((sum, id) => sum + (tasks.get(id)?.value ?? 0), 0);
      const key = ids.join("\n");
      if (!tasks.has(key))
        tasks.set(key, {
          value:
            agent.totalTokens === undefined ? undefined : Math.max(0, agent.totalTokens - known),
          complete: false,
        });
    }
  }
  const values = [...tasks.values()];
  const known = values.flatMap((usage) => (usage.value === undefined ? [] : [usage.value]));
  return {
    spent:
      values.length === 0
        ? 0
        : known.length === 0
          ? null
          : known.reduce((sum, value) => sum + value, 0),
    complete: values.every((usage) => usage.complete),
  };
}

export function workflowBudget(workflow: OrchestrationV2SubagentWorkflow) {
  const usage = workflowRecordedUsage(workflow.agents);
  const limit = workflow.budget?.limit;
  return {
    ...usage,
    limit: limit ?? null,
    exhausted:
      workflow.budget?.exhausted === true ||
      (limit !== undefined && usage.spent !== null && usage.spent >= limit),
    overshot: limit !== undefined && usage.spent !== null && usage.spent > limit,
  };
}

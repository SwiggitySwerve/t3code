/** Claude Code's documented per-run ceiling on the agents one workflow starts. */
export const MAX_AGENTS_PER_WORKFLOW = 1000;
/**
 * Work attempts of an agent that declares no `retries`: a failed check or a passed attempt
 * deadline starts it once more on its target with what went wrong, then it fails.
 */
const DEFAULT_WORK_ATTEMPTS = 2;
/** The most work attempts: the target, then each declared retry target in turn. */
const MAX_WORK_ATTEMPTS = 3;
export const MAX_RETRY_TARGETS = MAX_WORK_ATTEMPTS - 1;
/**
 * Extra same-target attempts after infrastructure faults (the task failed, a server restart
 * cancelled it, or the stall sweep stopped it); they do not use a work attempt.
 */
export const MAX_INFRA_RETRIES = 2;
/**
 * Extra runs of a check that could not run (its process did not start, its judge gave no
 * verdict). They judge the same work again and use no work attempt.
 */
export const MAX_CHECK_RERUNS = 2;
/** The most attempts one agent call can make, which bounds its attempt keys. */
export const MAX_AGENT_ATTEMPTS = MAX_WORK_ATTEMPTS + MAX_INFRA_RETRIES;

/** An agent's work attempts: its target, then one per declared retry target, else the default. */
export function workAttempts(retries: ReadonlyArray<unknown> | undefined): number {
  return retries === undefined ? DEFAULT_WORK_ATTEMPTS : 1 + retries.length;
}

/**
 * The most agents one `agent()` call can add to a workflow: the worker itself, plus for a
 * judgment check one judge for each work attempt, since only a finished attempt is judged.
 * Process and structured checks run without an agent, and an agent's own retries reuse its row.
 */
export function maxAgentsPerCall(
  checkType: "process" | "structured" | "judgment" | undefined,
  retries?: ReadonlyArray<unknown>,
) {
  return checkType === "judgment" ? 1 + workAttempts(retries) : 1;
}

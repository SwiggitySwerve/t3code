/** Claude Code's documented per-run ceiling on the agents one workflow starts. */
export const MAX_AGENTS_PER_WORKFLOW = 1000;
/**
 * Attempts an agent gets for its work: a failed check or a passed attempt deadline starts it once
 * more with what went wrong, then it fails.
 */
export const MAX_WORK_ATTEMPTS = 2;
/**
 * Extra same-target attempts after infrastructure faults (the task failed, a server restart
 * cancelled it, or the stall sweep stopped it); they do not use a work attempt.
 */
export const MAX_INFRA_RETRIES = 2;
/** The most attempts one agent call can make, which bounds its attempt keys. */
export const MAX_AGENT_ATTEMPTS = MAX_WORK_ATTEMPTS + MAX_INFRA_RETRIES;

/**
 * The most agents one `agent()` call can add to a workflow: the worker itself, plus for a
 * judgment check one judge for each work attempt, since only a finished attempt is judged.
 * Process and structured checks run without an agent, and an agent's own retries reuse its row.
 */
export function maxAgentsPerCall(checkType: "process" | "structured" | "judgment" | undefined) {
  return checkType === "judgment" ? 1 + MAX_WORK_ATTEMPTS : 1;
}

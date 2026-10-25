/** Claude Code's documented per-run ceiling on the agents one workflow starts. */
export const MAX_AGENTS_PER_WORKFLOW = 1000;
/** A failed agent, or one a server restart cancelled, runs again up to this many times in all. */
export const MAX_AGENT_ATTEMPTS = 3;

/**
 * The most agents one `agent()` call can add to a workflow: the worker itself, plus for a
 * judgment check one judge for each attempt the worker can be given. Process and structured
 * checks run without an agent, and an agent's own retries reuse its row.
 */
export function maxAgentsPerCall(checkType: "process" | "structured" | "judgment" | undefined) {
  return checkType === "judgment" ? 1 + MAX_AGENT_ATTEMPTS : 1;
}

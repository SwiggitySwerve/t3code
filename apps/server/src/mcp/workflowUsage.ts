import type { OrchestratorMcpWorkflowUsage, TurnTokenUsage } from "@t3tools/contracts";

/** Each record is one provider turn, or an absent turn for a child with no usage yet.
 * Turn totals include every response in that turn; context occupancy is never cost.
 * Known counts are lower bounds when any record is missing or partial. No known
 * count is represented by null, including for providers that report no usage.
 */
export function aggregateWorkflowUsage(
  records: ReadonlyArray<TurnTokenUsage | undefined>,
): OrchestratorMcpWorkflowUsage {
  const sum = (counts: ReadonlyArray<number | undefined>): number | null => {
    const known = counts.filter((count) => count !== undefined);
    return known.length === 0 ? null : known.reduce((total, count) => total + count, 0);
  };
  const inputTokens = sum(records.map((record) => record?.inputTokens));
  const outputTokens = sum(records.map((record) => record?.outputTokens));
  const known =
    inputTokens !== null ||
    outputTokens !== null ||
    records.some(
      (record) =>
        record?.cachedInputTokens !== undefined || record?.cacheCreationTokens !== undefined,
    );
  return {
    status: !known
      ? "unavailable"
      : records.length > 0 && records.every((record) => record?.usageStatus === "complete")
        ? "complete"
        : "partial",
    inputTokens,
    cachedInputTokens: sum(records.map((record) => record?.cachedInputTokens)),
    cacheCreationTokens: sum(records.map((record) => record?.cacheCreationTokens)),
    uncachedInputTokens: sum(
      records.map((record) =>
        record?.inputTokens === undefined || record.cachedInputTokens === undefined
          ? undefined
          : record.inputTokens - record.cachedInputTokens - (record.cacheCreationTokens ?? 0),
      ),
    ),
    outputTokens,
    totalTokens:
      inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + (outputTokens ?? 0),
  };
}

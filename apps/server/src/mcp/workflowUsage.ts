import type {
  OrchestrationV2ProviderTurn,
  OrchestratorMcpWorkflowUsage,
  TurnTokenUsage,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

/** An open turn's reported counts are lower bounds, even after its run has ended. */
export function workflowTurnUsage(
  turn: Pick<OrchestrationV2ProviderTurn, "status" | "turnTokenUsage">,
): TurnTokenUsage | undefined {
  const usage = turn.turnTokenUsage;
  return usage !== undefined && (turn.status === "running" || turn.status === "pending")
    ? { ...usage, usageStatus: "partial" }
    : usage;
}

/** Sum execution intervals, excluding time between runs and before admission. */
export function workflowExecutionTiming(
  runs: ReadonlyArray<{ readonly startedAt: number | null; readonly completedAt: number | null }>,
  nowMs?: number,
): {
  readonly durationMs?: number;
  readonly startedAt?: number;
  readonly activeStartedAt?: number;
  readonly completedDurationMs?: number;
  readonly timingComplete: boolean;
} {
  const intervals = runs.map((run) => {
    const elapsed = deriveSubagentElapsedMs(
      {
        status: run.completedAt === null && nowMs !== undefined ? "running" : "completed",
        startedAt:
          run.startedAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(run.startedAt)),
        completedAt:
          run.completedAt === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(run.completedAt)),
      },
      nowMs ?? 0,
    );
    return { run, elapsed };
  });
  const durations = intervals.flatMap(({ elapsed }) => (elapsed === null ? [] : [elapsed]));
  const active = runs.filter((run) => run.startedAt !== null && run.completedAt === null);
  const completedDurationMs = intervals.reduce(
    (sum, { run, elapsed }) => sum + (run.completedAt === null ? 0 : (elapsed ?? 0)),
    0,
  );
  const starts = runs.flatMap((run) => (run.startedAt === null ? [] : [run.startedAt]));
  return {
    ...(nowMs !== undefined && active.length === 1
      ? { activeStartedAt: active[0]!.startedAt!, completedDurationMs }
      : {}),
    ...(starts.length === 0 ? {} : { startedAt: Math.min(...starts) }),
    ...(durations.length === 0
      ? {}
      : { durationMs: durations.reduce((sum, duration) => sum + duration, 0) }),
    timingComplete:
      runs.length > 0 && runs.every((run) => run.startedAt !== null && run.completedAt !== null),
  };
}

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

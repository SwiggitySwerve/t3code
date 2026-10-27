import * as DateTime from "effect/DateTime";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import type { RuntimeSubagent, WorkflowGraphNodeView } from "./subagentRuntime.ts";

interface Count {
  readonly value: number | null;
  readonly complete: boolean;
}

interface Attempt {
  readonly key: string;
  readonly number: number;
  readonly childThreadId: string | null;
  readonly model: string | null;
  readonly providerInstanceId: string | null;
  readonly status: string;
  readonly tokens: Count;
  readonly elapsed: Count;
}

function total(values: ReadonlyArray<Count>, missing: boolean): Count {
  const known = values.flatMap((count) => (count.value === null ? [] : [count.value]));
  return {
    value: known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0),
    complete: !missing && values.length > 0 && values.every((count) => count.complete),
  };
}

/** Child task identity owns accounting. Legacy member tokens are cumulative, never per-attempt. */
export function workflowNodeAccounting(
  node: WorkflowGraphNodeView<RuntimeSubagent>,
  nowMs?: number,
) {
  const activeTasks = new Set<string>();
  const members = new Map(
    (node.members ?? (node.member === null ? [] : [node.member]))
      .filter((member) => member.judgmentFor === undefined)
      .map((member) => [member.id, member]),
  );
  const attempts = new Map<string, Attempt>();
  const legacyTokens = new Map<string, Count>();
  const legacyTaskIds = new Set<string>();
  let missing = false;
  for (const member of members.values()) {
    const history = member.attemptHistory;
    const expected = Math.max((member.attempt ?? 0) + 1, member.attemptTaskIds?.length ?? 0);
    if (history !== undefined && history.length > 0) {
      missing ||= new Set(history.map((attempt) => attempt.taskId)).size < expected;
      for (const attempt of history) {
        const interrupted =
          attempt.state === "running" &&
          ["completed", "failed", "cancelled", "interrupted"].includes(member.status);
        const active =
          !interrupted &&
          attempt.state === "running" &&
          attempt.activeStartedAt !== undefined &&
          attempt.completedDurationMs !== undefined;
        if (active) activeTasks.add(attempt.taskId);
        else activeTasks.delete(attempt.taskId);
        const activeElapsed =
          active && nowMs !== undefined
            ? deriveSubagentElapsedMs(
                {
                  status: "running",
                  startedAt: DateTime.formatIso(DateTime.makeUnsafe(attempt.activeStartedAt!)),
                  completedAt: null,
                },
                nowMs,
              )
            : null;
        attempts.set(attempt.taskId, {
          key: attempt.taskId,
          number: attempt.attempt + 1,
          childThreadId: attempt.childThreadId,
          model: attempt.model ?? null,
          providerInstanceId: attempt.providerInstanceId,
          status: interrupted
            ? member.status === "cancelled"
              ? "cancelled"
              : "interrupted"
            : attempt.state,
          tokens: {
            value: attempt.totalTokens ?? null,
            complete:
              attempt.state !== "running" &&
              attempt.totalTokens !== undefined &&
              attempt.usageStatus === "complete",
          },
          elapsed: {
            value:
              activeElapsed === null
                ? (attempt.durationMs ?? null)
                : attempt.completedDurationMs! + activeElapsed,
            complete:
              attempt.state !== "running" &&
              attempt.durationMs !== undefined &&
              attempt.timingComplete,
          },
        });
      }
      continue;
    }
    if (
      member.attemptTaskIds === undefined &&
      member.taskId === undefined &&
      member.childThreadId === null &&
      member.startedAt === null
    )
      continue;
    const ids = [...new Set(member.attemptTaskIds ?? [member.taskId ?? member.id])];
    missing ||= ids.length < expected;
    // This aggregate belongs to the whole legacy member, even when only its latest child survives.
    legacyTokens.set([...ids].sort().join("\n"), {
      value: member.usage?.totalTokens ?? null,
      complete: false,
    });
    for (const id of ids) legacyTaskIds.add(id);
    for (const [index, id] of ids.entries()) {
      const latest = index === ids.length - 1;
      const elapsed =
        latest && expected === 1
          ? (member.usage?.durationMs ??
            deriveSubagentElapsedMs(member, Date.parse(member.updatedAt)))
          : null;
      if (attempts.has(id)) continue;
      attempts.set(id, {
        key: id,
        number: latest ? expected : index + 1,
        childThreadId: latest ? member.childThreadId : null,
        model: latest ? member.model : null,
        providerInstanceId: latest ? (member.providerInstanceId ?? null) : null,
        status: latest ? member.status : "unknown",
        tokens: { value: null, complete: false },
        elapsed: {
          value: elapsed,
          complete: elapsed !== null && !["running", "pending"].includes(member.status),
        },
      });
    }
  }
  const list = [...attempts.values()].sort((a, b) => a.number - b.number);
  missing ||= (node.attempts ?? 0) > list.length;
  return {
    attempts: list,
    live: activeTasks.size > 0,
    missing,
    tokens: total(
      [
        ...list
          .filter((attempt) => !legacyTaskIds.has(attempt.key))
          .map((attempt) => attempt.tokens),
        ...legacyTokens.values(),
      ],
      missing,
    ),
    elapsed: total(
      list.map((attempt) => attempt.elapsed),
      missing,
    ),
  };
}

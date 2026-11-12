import type { MessageId, OrchestrationV2TurnItem, RunId } from "@t3tools/contracts";
import {
  workflowRequestOf,
  type WorkflowRequestInput,
} from "@t3tools/provider-core/server/workflowTrigger";

/** Reconstruct the same request turn start observes, without interpreting server decision text. */
export function workflowRequestFromHistory(
  history: {
    readonly runs: ReadonlyArray<{
      readonly id: RunId;
      readonly ordinal: number;
      readonly restartContinuationOfRunId?: RunId | undefined;
    }>;
    readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  },
  policy: Pick<
    WorkflowRequestInput,
    "workflows" | "workflowStart" | "workflowTriggers" | "delegatedThread"
  >,
): MessageId | null {
  const runs = new Map(history.runs.map((run) => [run.id, run]));
  const runOf = (id: RunId | null) => (id === null ? undefined : runs.get(id));
  const messages = history.turnItems
    .flatMap((item) => (item.type === "user_message" ? [item] : []))
    .toSorted(
      (a, b) =>
        (runOf(b.runId)?.ordinal ?? 0) - (runOf(a.runId)?.ordinal ?? 0) || b.ordinal - a.ordinal,
    );
  for (const item of messages) {
    const request = workflowRequestOf({
      ...policy,
      typedText: item.text,
      createdBy: item.createdBy,
      creationSource: item.creationSource,
      scheduledTaskId: item.scheduledTaskId,
      senderThreadId: item.senderThreadId,
      resumesEarlierTurn: runOf(item.runId)?.restartContinuationOfRunId !== undefined,
    });
    const steered = item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer";
    if (request === "ignored" || (steered && request === "plain")) continue;
    return request === "requested" ? item.messageId : null;
  }
  return null;
}

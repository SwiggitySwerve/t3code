import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";

import {
  buildBoundedThreadProjection,
  type BoundedProjectionResult,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;

/** A queue may drain many bounded patches at once; do not turn them into one large RPC frame. */
export const boundWorkflowUpdateBatches = <A extends OrchestrationV2ThreadStreamItem, E, R>(
  source: Stream.Stream<A, E, R>,
): Stream.Stream<A, E, R> =>
  source.pipe(
    Stream.chunks,
    Stream.flatMap((items) => {
      const batches: Array<Array<A>> = [];
      let pending: Array<A> = [];
      for (const item of items) {
        if (item.kind === "event" && item.event.type === "workflow.updated") {
          if (pending.length > 0) batches.push(pending);
          batches.push([item]);
          pending = [];
        } else pending.push(item);
      }
      if (pending.length > 0) batches.push(pending);
      return Stream.fromArrays(...batches);
    }),
  );

/**
 * For a client that does not apply workflow patches: replaces a `workflow.updated` item with a
 * `subagent.updated` item carrying the workflow's current full row. Such a client would otherwise
 * skip the event as unknown and keep a stale row. The row may already include later updates;
 * whole-row replacement keeps such a client correct.
 */
export function asFullWorkflowRow(
  item: OrchestrationV2ThreadStreamItem,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): OrchestrationV2ThreadStreamItem {
  if (item.kind !== "event" || item.event.type !== "workflow.updated") return item;
  const event = fullWorkflowRowEvent(item.event, subagents);
  return event === undefined ? item : { ...item, event };
}

type WorkflowUpdatedEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "workflow.updated" }
>;
type SubagentUpdatedEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "subagent.updated" }
>;

/** The `subagent.updated` event a patch amounts to: same identity, the workflow's current row. */
export function fullWorkflowRowEvent(
  event: WorkflowUpdatedEvent,
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): SubagentUpdatedEvent | undefined {
  const { type: _type, payload, ...base } = event;
  const row = subagents.find((task) => task.id === payload.id);
  return row === undefined ? undefined : { ...base, type: "subagent.updated", payload: row };
}

export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/** Decoded objects and temporary strings exceed stored JSON size, even before wire slimming. */
export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1_048_576;

export function isThreadReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES;
}

export function threadReplayEncodedBytes(items: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? "", "utf8");
  }
  return total;
}

type ThreadSnapshotStreamItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { readonly kind: "snapshot" }
>;

export function boundedSnapshotResponseFields(input: {
  readonly bounded: BoundedProjectionResult;
  readonly compactTurnItems: boolean;
  readonly dedupeBodies: boolean;
  readonly compactIds: boolean;
}) {
  const { bounded } = input;
  // Dedupe keeps shared items one object, which the compaction's identity check needs.
  const projection = input.dedupeBodies
    ? dedupeSnapshotBodies(bounded.projection)
    : bounded.projection;
  const compactProjection = input.compactTurnItems ? omitLocalVisibleTurnItems(projection) : null;
  return {
    projection: compactProjection ?? projection,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    ...(compactProjection === null ? {} : { turnItemsOmitLocalVisible: true as const }),
    ...(input.compactIds ? { idTable: true as const } : {}),
  };
}

export function buildBoundedThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly compactTurnItems?: boolean;
  readonly dedupeBodies?: boolean;
  readonly compactIds?: boolean;
}): ThreadSnapshotStreamItem {
  const bounded = buildBoundedThreadProjection({
    snapshotSequence: input.snapshotSequence,
    projection: projectThreadProjectionForWire(input.projection),
  });
  return {
    kind: "snapshot",
    snapshotSequence: input.snapshotSequence,
    ...boundedSnapshotResponseFields({
      bounded,
      compactTurnItems: input.compactTurnItems === true,
      dedupeBodies: input.dedupeBodies === true,
      compactIds: input.compactIds === true,
    }),
  };
}

export type ThreadResumePlan =
  | {
      readonly mode: "replay";
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: "snapshot" };

/** Bound event count and encoded bytes; replace excessive replay with one current snapshot. */
export function decideThreadResume(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: "snapshot" };
  }
  return {
    mode: "replay",
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}

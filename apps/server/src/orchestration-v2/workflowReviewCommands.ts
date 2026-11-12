/** Durable review decisions. All callers run these under the thread's command lock. */
import {
  CommandId,
  NodeId,
  OrchestrationV2WorkflowApprovalError,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Ref from "effect/Ref";
import type * as ProjectionStore from "./ProjectionStore.ts";
import type * as ServerSettings from "../serverSettings.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import { workflowRequestFromHistory } from "./workflowRequestHistory.ts";

type Review = Extract<OrchestrationV2TurnItem, { readonly type: "workflow_review" }>;
type Decide = Extract<OrchestrationV2InternalCommand, { readonly type: "workflow.review.decide" }>;
type Settle = Extract<OrchestrationV2InternalCommand, { readonly type: "workflow.review.settle" }>;
type Events = Ref.Ref<Array<OrchestrationV2DomainEvent>>;
type Start = Extract<OrchestrationV2InternalCommand, { readonly type: "workflow.start" }>;

export function makeWorkflowReviewCommands<E>(dependencies: {
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
  readonly settings: ServerSettings.ServerSettingsService["Service"];
  readonly emit: (
    command: OrchestrationV2ServerCommand,
    events: Events,
    item: Review,
  ) => Effect.Effect<void, E>;
  readonly start: (command: Start, events: Events) => Effect.Effect<void, E>;
}) {
  const { projections, settings, emit, start } = dependencies;
  const load = (threadId: Review["threadId"]) =>
    projections.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemTypes: ["workflow_review", "user_message", "run_interrupt_request"],
    });
  const currentRequest = Effect.fn("workflowReview.currentRequest")(function* (
    records: Effect.Success<ReturnType<typeof load>>,
  ) {
    const policy = yield* settings.getSettings;
    return workflowRequestFromHistory(records, {
      workflows: true,
      workflowStart: resolveProjectSettings(policy, records.thread.projectId).settings
        .workflowStart,
      workflowTriggers: policy.workflowTriggers,
      delegatedThread: records.thread.lineage.relationshipToParent === "subagent",
    });
  });
  const update = Effect.fn("workflowReview.update")(function* (
    command: OrchestrationV2ServerCommand,
    events: Events,
    review: Review,
    patch: Pick<Review, "decision"> &
      Partial<Pick<Review, "approvalRunId" | "notStartedReason" | "workflowId">>,
  ) {
    const {
      approvalRunId: _run,
      notStartedReason: _reason,
      workflowId: _workflow,
      ...rest
    } = review;
    yield* emit(command, events, {
      ...rest,
      ...patch,
      decisionRevision: (review.decisionRevision ?? 0) + 1,
      updatedAt: yield* DateTime.now,
    });
  });
  const launch = Effect.fn("workflowReview.launch")(function* (
    command: OrchestrationV2ServerCommand,
    events: Events,
    review: Review,
  ) {
    if (
      review.launch === undefined ||
      review.approvalRequest === undefined ||
      review.runId === null
    )
      return;
    const workflowId = NodeId.make(
      `workflow:approval:${review.threadId}:${review.approvalRequest.messageId}:${review.digest}`,
    );
    yield* start(
      {
        type: "workflow.start",
        commandId: CommandId.make(`command:${workflowId}`),
        threadId: review.threadId,
        runId: review.runId,
        workflowId,
        createdBy: "user",
        creationSource: "server",
        title: review.launch.title,
        script: review.launch.script,
      },
      events,
    );
    yield* update(command, events, review, { decision: "started", workflowId });
  });

  return {
    stop: Effect.fn("workflowReview.stop")(function* (
      command: OrchestrationV2ServerCommand & { readonly threadId: Review["threadId"] },
      events: Events,
    ) {
      const records = yield* projections.getThreadRecords(command.threadId, ["turnItems"], {
        turnItemTypes: ["workflow_review"],
      });
      for (const item of records.turnItems) {
        if (item.type === "workflow_review" && item.decision === "approved") {
          yield* update(command, events, item, {
            decision: "awaiting",
            notStartedReason: "stopped",
          });
        }
      }
    }),
    /** A blocked revision does not replace the latest runnable plan. */
    supersede: Effect.fn("workflowReview.supersede")(function* (
      command: OrchestrationV2ServerCommand,
      events: Events,
      review: Review,
      previous: ReadonlyArray<OrchestrationV2TurnItem>,
    ) {
      if (!review.ready || review.approvalRequest === undefined) return;
      for (const item of previous) {
        if (
          item.type === "workflow_review" &&
          item.ready &&
          item.approvalRequest?.messageId === review.approvalRequest.messageId &&
          item.decision !== "started" &&
          item.decision !== "dismissed" &&
          item.decision !== "superseded"
        ) {
          yield* update(command, events, item, { decision: "superseded" });
        }
      }
    }),
    decide: Effect.fn("workflowReview.decide")(function* (command: Decide, events: Events) {
      const records = yield* load(command.threadId);
      const review = records.turnItems.find(
        (item): item is Review =>
          item.type === "workflow_review" && item.reviewId === command.reviewId,
      );
      const refuse = (reason: OrchestrationV2WorkflowApprovalError["reason"]) =>
        new OrchestrationV2WorkflowApprovalError({
          threadId: command.threadId,
          reviewId: command.reviewId,
          reason,
        });
      if (review === undefined || review.digest !== command.digest)
        return yield* refuse("review-not-found");
      if (review.approvalRequest === undefined) return yield* refuse("no-pending-request");
      if (review.approvalRequest.environmentId !== command.environmentId)
        return yield* refuse("environment-mismatch");
      if (review.decision === "superseded") return yield* refuse("review-superseded");
      if (review.decision === "started") {
        if (command.action === "approve") return;
        return yield* refuse("no-pending-request");
      }
      if (review.decision === "dismissed") {
        if (command.action === "dismiss") return;
        return yield* refuse("no-pending-request");
      }
      if (
        records.turnItems.some(
          (item) =>
            item.type === "workflow_review" &&
            item.approvalRequest?.messageId === review.approvalRequest?.messageId &&
            (item.decision === "started" || item.decision === "dismissed"),
        )
      ) {
        return yield* refuse("no-pending-request");
      }
      if (review.approvalRequest.messageId !== (yield* currentRequest(records)))
        return yield* refuse("no-pending-request");
      // A delayed click from before Stop or a newer decision cannot grant fresh authority.
      if ((review.decisionRevision ?? 0) !== command.decisionRevision) return;
      if (command.action === "dismiss") {
        for (const item of records.turnItems) {
          if (
            item.type === "workflow_review" &&
            item.approvalRequest?.messageId === review.approvalRequest.messageId &&
            item.decision !== "superseded"
          ) {
            yield* update(command, events, item, { decision: "dismissed" });
          }
        }
        return;
      }
      if (!review.ready || review.digest === null) return yield* refuse("review-blocked");
      if (review.launch === undefined) return yield* refuse("review-not-found");
      if (review.decision === "approved") return;
      const active = records.runs.filter(isActiveRun).toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (active !== undefined) {
        yield* update(command, events, review, { decision: "approved", approvalRunId: active.id });
      } else {
        yield* launch(command, events, review);
      }
    }),
    settle: Effect.fn("workflowReview.settle")(function* (command: Settle, events: Events) {
      const records = yield* load(command.threadId);
      const run = records.runs.find((candidate) => candidate.id === command.runId);
      if (run === undefined || isActiveRun(run)) return;
      const request = yield* currentRequest(records);
      const stopped = records.turnItems.some(
        (item) => item.type === "run_interrupt_request" && item.runId === run.id,
      );
      for (const item of records.turnItems) {
        if (
          item.type !== "workflow_review" ||
          item.decision !== "approved" ||
          item.approvalRunId !== run.id
        )
          continue;
        if (item.approvalRequest?.messageId !== request) {
          yield* update(command, events, item, { decision: "superseded" });
        } else if (run.status === "completed" && !stopped) {
          yield* launch(command, events, item);
        } else {
          const reason = stopped ? "stopped" : run.status;
          if (
            reason === "failed" ||
            reason === "cancelled" ||
            reason === "interrupted" ||
            reason === "rolled_back" ||
            reason === "stopped"
          ) {
            yield* update(command, events, item, {
              decision: "awaiting",
              notStartedReason: reason,
            });
          }
        }
      }
    }),
  };
}

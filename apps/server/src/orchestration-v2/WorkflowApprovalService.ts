/** Client decisions enter the same durable command path as planning and Stop. */
import {
  CommandId,
  OrchestrationV2WorkflowApprovalError,
  type OrchestrationV2ApproveWorkflowReviewInput,
  type OrchestrationV2DismissWorkflowReviewInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "./ThreadManagementService.ts";
import { sendWithNextId, sendWithFreshId } from "./WorkflowCommandRetry.ts";
import { reviewDecisionRefusal } from "./workflowReviewCommands.ts";

export class WorkflowApprovalService extends Context.Service<
  WorkflowApprovalService,
  {
    readonly approve: (
      input: OrchestrationV2ApproveWorkflowReviewInput,
    ) => Effect.Effect<void, OrchestrationV2WorkflowApprovalError>;
    readonly dismiss: (
      input: OrchestrationV2DismissWorkflowReviewInput,
    ) => Effect.Effect<void, OrchestrationV2WorkflowApprovalError>;
  }
>()("t3/orchestration-v2/WorkflowApprovalService") {}

const isApprovalError = Schema.is(OrchestrationV2WorkflowApprovalError);
const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const decide = Effect.fn("WorkflowApprovalService.decide")(function* (
    input: OrchestrationV2ApproveWorkflowReviewInput | OrchestrationV2DismissWorkflowReviewInput,
    action: "approve" | "dismiss",
  ) {
    return yield* Effect.gen(function* () {
      const records = yield* threads.getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["workflow_review"],
      });
      const review = records.turnItems.find(
        (item) => item.type === "workflow_review" && item.reviewId === input.reviewId,
      );
      // A successful receipt must not hide that a later decision invalidated the card.
      if (review?.type === "workflow_review") {
        const reason = reviewDecisionRefusal(review, { ...input, action });
        if (reason !== undefined)
          return yield* new OrchestrationV2WorkflowApprovalError({
            threadId: input.threadId,
            reviewId: input.reviewId,
            reason,
          });
      }
      if (
        review?.type === "workflow_review" &&
        review.launch !== undefined &&
        input.decisionRevision === undefined
      ) {
        return yield* new OrchestrationV2WorkflowApprovalError({
          threadId: input.threadId,
          reviewId: input.reviewId,
          reason: "revision-required",
        });
      }
      const decisionRevision = input.decisionRevision ?? 0;
      yield* sendWithNextId(
        CommandId.make(
          `server:workflow-${action}:${input.threadId}:${input.reviewId}:${decisionRevision}`,
        ),
        (commandId) =>
          threads.dispatch({
            type: "workflow.review.decide",
            commandId,
            threadId: input.threadId,
            environmentId: input.environmentId,
            reviewId: input.reviewId,
            digest: input.digest,
            action,
            decisionRevision,
          }),
      );
      if (action !== "approve") return;
      const latest = yield* threads.getThreadRecords(input.threadId, ["turnItems", "runs"], {
        turnItemTypes: ["workflow_review"],
      });
      const approved = latest.turnItems.find(
        (item) => item.type === "workflow_review" && item.reviewId === input.reviewId,
      );
      if (
        approved?.type !== "workflow_review" ||
        approved.decision !== "approved" ||
        (approved.decisionRevision !== decisionRevision &&
          approved.decisionRevision !== decisionRevision + 1)
      )
        return;
      if (approved.approvalRunId !== undefined) {
        const run = latest.runs.find((run) => run.id === approved.approvalRunId);
        if (run === undefined || ThreadManagementService.isActiveRun(run)) return;
        yield* sendWithFreshId(
          CommandId.make(
            `server:workflow-settle:${input.reviewId}:${approved.decisionRevision}:${run.status}`,
          ),
          (commandId) =>
            threads.dispatch({
              type: "workflow.review.settle",
              commandId,
              threadId: input.threadId,
              runId: run.id,
            }),
        );
        return;
      }
      yield* sendWithNextId(
        CommandId.make(
          `server:workflow-launch:${input.threadId}:${input.reviewId}:${approved.decisionRevision}`,
        ),
        (commandId) =>
          threads.dispatch({
            type: "workflow.review.launch",
            commandId,
            threadId: input.threadId,
            reviewId: input.reviewId,
            decisionRevision: approved.decisionRevision!,
          }),
      );
    }).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => {
        if (isApprovalError(cause)) return cause;
        const detail = "cause" in cause ? cause.cause : undefined;
        if (isApprovalError(detail)) return detail;
        return new OrchestrationV2WorkflowApprovalError({
          threadId: input.threadId,
          reviewId: input.reviewId,
          reason:
            cause._tag === "OrchestratorProjectionError" ? "no-pending-request" : "unavailable",
          cause,
        });
      }),
    );
  });

  return WorkflowApprovalService.of({
    approve: Effect.fn("WorkflowApprovalService.approve")(function* (input) {
      yield* decide(input, "approve");
    }),
    dismiss: Effect.fn("WorkflowApprovalService.dismiss")(function* (input) {
      yield* decide(input, "dismiss");
    }),
  });
});

export const layer = Layer.effect(WorkflowApprovalService, make);

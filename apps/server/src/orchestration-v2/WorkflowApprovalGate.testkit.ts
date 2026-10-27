/**
 * A gate no request ever arms, for tests of callers that do not exercise approval. Reviews
 * record nothing, starts always run with the caller's own key, and no review can be decided.
 */
import { OrchestrationV2WorkflowApprovalError, type ThreadId } from "@t3tools/contracts";
import { workflowRequestOf } from "@t3tools/provider-core/server/workflowTrigger";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { WorkflowApprovalGate } from "./WorkflowApprovalGate.ts";

const noPendingRequest = (input: { readonly threadId: ThreadId; readonly reviewId: string }) =>
  Effect.fail(
    new OrchestrationV2WorkflowApprovalError({
      threadId: input.threadId,
      reviewId: input.reviewId,
      reason: "no-pending-request",
    }),
  );

export const layerOpen = Layer.succeed(
  WorkflowApprovalGate,
  WorkflowApprovalGate.of({
    observeTurn: (input) => Effect.succeed(workflowRequestOf(input)),
    observeSteer: () => Effect.undefined,
    beginReview: (threadId) => Effect.succeed({ threadId, armed: null }),
    completeReview: () => Effect.succeed({ approvalRequired: false }),
    requireNoRequest: () => Effect.void,
    guardGraphStart: (_input, start) => start(undefined),
    approve: noPendingRequest,
    dismiss: noPendingRequest,
  }),
);

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  latestWorkflowReviewItemId,
  presentWorkflowReview,
  readWorkflowReviewOutput,
  runWorkflowReviewDecision,
  workflowReviewDecisionAtom,
  workflowReviewDecisionKey,
} from "@t3tools/client-runtime/state/workflowReview";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { useContext, type ReactNode } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useTurnItemDetail } from "../../state/queries";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkflowReviewCard } from "./WorkflowReviewCard";

/**
 * The coordinator's `graph_review` call, drawn as the card the person approves from. The decision
 * goes to the thread that made the review, named by the review id and digest in its result; a review
 * this thread did not make (a fork's inherited history), or one whose result cannot be read, keeps
 * the generic tool row passed as `fallback`.
 */
export function WorkflowReviewTimelineBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly fallback: ReactNode;
}) {
  const { environmentId, projectedItem } = props;
  const item = projectedItem.item;
  const registry = useContext(RegistryContext);
  const approve = useAtomCommand(orchestrationEnvironment.approveWorkflowReview, {
    reportFailure: false,
  });
  const dismiss = useAtomCommand(orchestrationEnvironment.dismissWorkflowReview, {
    reportFailure: false,
  });
  const canDecide = useAtomValue(
    orchestrationEnvironment.approveWorkflowReview.permissionAtom(environmentId),
  );
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const own = projectedItem.visibility === "local" && item.type === "dynamic_tool";
  const threadRef = scopeThreadRef(environmentId, item.threadId);
  const latestReviewId = useAtomValue(environmentThreadDetails.threadAtom(threadRef), (thread) =>
    thread === null ? null : latestWorkflowReviewItemId(thread.projection.turnItems),
  );
  const detail = useTurnItemDetail(
    own && turnItemNeedsDetailFetch(item)
      ? {
          environmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(item),
        }
      : null,
  );
  const stored = detail.data?.item;
  const output = stored?.type === "dynamic_tool" ? stored.output : undefined;
  const review = own ? readWorkflowReviewOutput(output ?? item.output) : null;
  const decisionKey =
    review === null ? "" : workflowReviewDecisionKey(environmentId, item.threadId, review.reviewId);
  const decision = useAtomValue(workflowReviewDecisionAtom(decisionKey));
  if (review === null) return props.fallback;
  const decide = (action: "approve" | "dismiss") => {
    if (action === "approve" && review.digest === null) return;
    void runWorkflowReviewDecision(registry, {
      key: decisionKey,
      action,
      send: () =>
        action === "approve" && review.digest !== null
          ? approve({
              environmentId,
              input: {
                environmentId,
                threadId: item.threadId,
                reviewId: review.reviewId,
                digest: review.digest,
              },
            })
          : dismiss({
              environmentId,
              input: {
                environmentId,
                threadId: item.threadId,
                reviewId: review.reviewId,
                digest: review.digest,
              },
            }),
    });
  };
  return (
    <WorkflowReviewCard
      review={review}
      presentation={presentWorkflowReview({
        review,
        decision,
        canDecide,
        superseded: latestReviewId !== null && latestReviewId !== item.id,
      })}
      providers={providers}
      onApprove={() => decide("approve")}
      onDismiss={() => decide("dismiss")}
    />
  );
}

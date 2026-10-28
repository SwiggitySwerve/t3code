import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  latestWorkflowReviewItemId,
  type ProjectedWorkflowReviewItem,
  presentWorkflowReview,
  runWorkflowReviewDecision,
  workflowReviewDecisionAtom,
  workflowReviewDecisionKey,
  workflowReviewOf,
} from "@t3tools/client-runtime/state/workflowReview";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { WorkflowReviewCard } from "./WorkflowReviewCard";

/**
 * The review record the server wrote for a `graph_review`, drawn as the card the person approves
 * from. The decision goes to the thread that made the review, named by the review id and digest in
 * the record. A review this thread inherited from the one it was forked from is shown without
 * buttons.
 */
export function WorkflowReviewTimelineBlock(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: ProjectedWorkflowReviewItem;
}) {
  const { environmentId, projectedItem } = props;
  const { workflows } = useEnvironmentSettings(environmentId);
  const { item } = projectedItem;
  const review = workflowReviewOf(item);
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
  const latestReviewId = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, item.threadId)),
    (thread) => (thread === null ? null : latestWorkflowReviewItemId(thread.projection.turnItems)),
  );
  const decisionKey = workflowReviewDecisionKey(environmentId, item.threadId, review.reviewId);
  const decision = useAtomValue(workflowReviewDecisionAtom(decisionKey));
  const decide = (action: "approve" | "dismiss") => {
    const base = { environmentId, threadId: item.threadId, reviewId: review.reviewId };
    const digest = review.digest;
    if (action === "approve" && (!workflows || digest === null)) return;
    void runWorkflowReviewDecision(registry, {
      key: decisionKey,
      action,
      send: () =>
        action === "approve" && digest !== null
          ? approve({ environmentId, input: { ...base, digest } })
          : dismiss({ environmentId, input: { ...base, digest } }),
    });
  };
  return (
    <WorkflowReviewCard
      review={review}
      presentation={presentWorkflowReview({
        review,
        decision,
        canDecide: canDecide && workflows,
        superseded: latestReviewId !== null && latestReviewId !== item.id,
        local: projectedItem.visibility === "local",
      })}
      providers={providers}
      onApprove={() => decide("approve")}
      onDismiss={() => decide("dismiss")}
    />
  );
}

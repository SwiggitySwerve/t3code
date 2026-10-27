import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  latestWorkflowReviewItemId,
  presentWorkflowReview,
  runWorkflowReviewDecision,
  workflowReviewDecisionAtom,
  workflowReviewDecisionKey,
  workflowReviewNodeLines,
  workflowReviewOf,
  workflowReviewSteps,
  workflowReviewSummary,
  type ProjectedWorkflowReviewItem,
  type WorkflowReviewNodeView,
  type WorkflowReviewPresentation,
  type WorkflowReviewView,
} from "@t3tools/client-runtime/state/workflowReview";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import { useContext } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { useEnvironmentServerConfig } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The review record the server wrote for a `graph_review`, drawn as the card the person approves
 * from. The decision goes to the thread that made the review, named by the review id and digest in
 * the record. A review this thread inherited from the one it was forked from is shown without
 * buttons.
 */
export function ThreadWorkflowReview(props: {
  readonly environmentId: EnvironmentId;
  readonly projectedItem: ProjectedWorkflowReviewItem;
}) {
  const { environmentId, projectedItem } = props;
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
  const providers = useEnvironmentServerConfig(environmentId)?.providers;
  const latestReviewId = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, item.threadId)),
    (thread) => (thread === null ? null : latestWorkflowReviewItemId(thread.projection.turnItems)),
  );
  const decisionKey = workflowReviewDecisionKey(environmentId, item.threadId, review.reviewId);
  const decision = useAtomValue(workflowReviewDecisionAtom(decisionKey));
  const decide = (action: "approve" | "dismiss") => {
    const base = { environmentId, threadId: item.threadId, reviewId: review.reviewId };
    const digest = review.digest;
    if (action === "approve" && digest === null) return;
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
        canDecide,
        superseded: latestReviewId !== null && latestReviewId !== item.id,
        local: projectedItem.visibility === "local",
      })}
      providers={providers}
      onApprove={() => decide("approve")}
      onDismiss={() => decide("dismiss")}
    />
  );
}

function WorkflowReviewCard(props: {
  readonly review: WorkflowReviewView;
  readonly presentation: WorkflowReviewPresentation;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly onApprove: () => void;
  readonly onDismiss: () => void;
}) {
  const { review, presentation } = props;
  const summary = workflowReviewSummary(review);
  const title = review.name ?? "Workflow plan";
  return (
    <View
      accessibilityLabel={`Workflow review: ${title}`}
      testID="workflow-review"
      className="mb-3 gap-3 rounded-[20px] border border-border bg-card-alt p-4"
    >
      <View className="flex-row items-start gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-t3-medium text-2xs text-foreground-muted">Workflow plan</Text>
          <Text className="font-t3-bold text-base text-foreground">{title}</Text>
          <Text className="font-sans text-sm text-foreground-muted">{summary.shape}</Text>
        </View>
        <Text
          accessibilityLiveRegion="polite"
          className="shrink-0 font-t3-medium text-xs text-foreground-muted"
        >
          {presentation.statusLabel}
        </Text>
      </View>
      {presentation.note ? (
        <Notice
          message={presentation.note.text}
          tone={presentation.note.tone === "error" ? "danger" : "default"}
        />
      ) : null}
      {review.blockers.map((blocker) => (
        <Text key={blocker} className="font-sans text-sm text-foreground-muted">
          {`\u2022 ${blocker}`}
        </Text>
      ))}
      {summary.moreBlockers ? (
        <Text className="font-sans text-sm text-foreground-muted">{summary.moreBlockers}</Text>
      ) : null}
      {summary.cost ? (
        <Text className="font-sans text-sm text-foreground-muted">{summary.cost}</Text>
      ) : null}
      {summary.costBasis ? (
        <Text className="font-sans text-xs text-foreground-muted">{summary.costBasis}</Text>
      ) : null}
      {summary.fanOutReasons.length > 0 ? (
        <Text className="font-sans text-sm text-foreground-muted">
          {`One agent may do this for less: ${summary.fanOutReasons.join(" ")}`}
        </Text>
      ) : null}
      {summary.writeConflicts ? (
        <Text className="font-sans text-sm text-foreground-muted">{summary.writeConflicts}</Text>
      ) : null}
      {workflowReviewSteps(review).map(({ step, nodes }) => (
        <View key={step} accessibilityLabel={`Step ${step}`} className="gap-1">
          <Text className="font-t3-medium text-xs text-foreground-muted">{`Step ${step}`}</Text>
          {nodes.map((node) => (
            <ReviewNode key={node.id} node={node} providers={props.providers} />
          ))}
        </View>
      ))}
      {summary.moreTasks ? (
        <Text className="font-sans text-xs text-foreground-muted">{summary.moreTasks}</Text>
      ) : null}
      {presentation.approve.visible || presentation.dismiss.visible ? (
        <View className="flex-row flex-wrap items-center gap-2">
          {presentation.approve.visible ? (
            <Button
              label={presentation.approve.label}
              tone="primary"
              disabled={!presentation.approve.enabled}
              loading={presentation.status === "approving"}
              onPress={props.onApprove}
            />
          ) : null}
          {presentation.dismiss.visible ? (
            <Button
              label={presentation.dismiss.label}
              disabled={!presentation.dismiss.enabled}
              loading={presentation.status === "dismissing"}
              onPress={props.onDismiss}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ReviewNode(props: {
  readonly node: WorkflowReviewNodeView;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
}) {
  const { node } = props;
  const lines = workflowReviewNodeLines(node, props.providers);
  return (
    <View className="gap-0.5 rounded-lg px-1 py-1">
      <Text className="font-t3-medium text-sm text-foreground">{node.subject}</Text>
      <Text className="font-sans text-xs text-foreground-muted">{lines.runs}</Text>
      {lines.after === null ? null : (
        <Text className="font-sans text-xs text-foreground-muted">{lines.after}</Text>
      )}
    </View>
  );
}

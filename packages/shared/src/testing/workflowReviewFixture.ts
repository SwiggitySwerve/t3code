/**
 * The approval record of a `graph_review`, as the server writes it for the review card tests of
 * every client. Plain data, so a test can break one field and see what the card does without it.
 */
import type {
  OrchestrationV2WorkflowReviewRecord,
  OrchestrationV2WorkflowReviewTask,
} from "@t3tools/contracts";

export const WORKFLOW_REVIEW_FIXTURE_ID = "review-1";
export const WORKFLOW_REVIEW_FIXTURE_DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const WORKFLOW_REVIEW_FIXTURE_PROVIDER = "cliproxy";

const TASKS = [
  ["survey", "Survey the API surface", [], 0],
  ["tests", "Write the regression tests", ["survey"], 1],
  ["change", "Implement the change", ["survey"], 1],
  ["verify", "Verify the build and the tests", ["tests", "change"], 2],
] as const;

const target = (model: string) => ({
  providerInstanceId: WORKFLOW_REVIEW_FIXTURE_PROVIDER,
  model,
});

/** The record of a ready review with four tasks in three steps, one of them judged. */
export function workflowReviewFixtureRecord(
  overrides: Partial<OrchestrationV2WorkflowReviewRecord> = {},
): OrchestrationV2WorkflowReviewRecord {
  return {
    type: "workflow_review",
    reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
    digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
    ready: true,
    approvalRequired: true,
    name: "Fix the sync bug",
    blockers: [],
    tasks: TASKS.map(([key, label, dependsOn, wave], index): OrchestrationV2WorkflowReviewTask => ({
      key,
      label,
      wave,
      dependsOn,
      worker: target(index === 0 ? "claude-opus-5-5" : "claude-haiku-5-5"),
      ...(key === "verify" ? { judge: target("claude-opus-5-5"), check: "judgment" as const } : {}),
    })),
    taskCount: TASKS.length,
    writeConflictCount: 0,
    advice: {
      fanOut: "ok",
      reasons: [],
      nodeCount: 4,
      widestWave: 2,
      depth: 3,
      verifierCount: 1,
      estimatedTokens: {
        low: 180_000,
        high: 436_800,
        basis: "Measured figures for Codex workers; other drivers are not measured.",
      },
      suggestedBudgetTokens: 420_000,
    },
    ...overrides,
  };
}

/**
 * A review of `count` independent tasks with long labels, as a graph too large for its own tool
 * result to be stored in full: the record stays small and keeps the controls.
 */
export function workflowReviewFixtureLargeRecord(
  count: number,
): OrchestrationV2WorkflowReviewRecord {
  const listed = Math.min(count, 120);
  return workflowReviewFixtureRecord({
    name: "Port every package",
    tasks: Array.from({ length: listed }, (_, index) => ({
      key: `task-${index + 1}`,
      label: `Port package ${index + 1} to the new build and rerun its checks`,
      wave: 0,
      dependsOn: [],
      worker: target("claude-haiku-5-5"),
    })),
    taskCount: count,
    advice: {
      ...workflowReviewFixtureRecord().advice!,
      nodeCount: count,
      widestWave: count,
      depth: 1,
      verifierCount: 0,
    },
  });
}

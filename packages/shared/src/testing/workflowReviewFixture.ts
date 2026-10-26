/**
 * A `graph_review` result as the server returns it, and the shapes the coordinators store it in, for
 * the review card tests of every client. Plain JSON, so a test can break one field and see what the
 * card does without it.
 */
export const WORKFLOW_REVIEW_FIXTURE_ID = "review-1";
export const WORKFLOW_REVIEW_FIXTURE_DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const WORKFLOW_REVIEW_FIXTURE_PROVIDER = "cliproxy";

const NODES = [
  ["survey", "Survey the API surface", [], 0],
  ["tests", "Write the regression tests", ["survey"], 1],
  ["change", "Implement the change", ["survey"], 1],
  ["verify", "Verify the build and the tests", ["tests", "change"], 2],
] as const;

function target(model: string) {
  return {
    providerInstanceId: WORKFLOW_REVIEW_FIXTURE_PROVIDER,
    model,
    options: { reasoningEffort: "high" },
    inheritOptions: false,
  };
}

/** The structured result of a ready review with four tasks in three waves, one of them judged. */
export function workflowReviewFixtureResult(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
    approvalRequired: true,
    digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
    ready: true,
    expandedGraph: {
      schemaVersion: 1,
      name: "Fix the sync bug",
      nodes: Object.fromEntries(
        NODES.map(([id, subject, dependsOn]) => [id, { subject, description: subject, dependsOn }]),
      ),
    },
    targets: NODES.map(([nodeId], index) => ({
      nodeId,
      source: "target",
      target: target(index === 0 ? "claude-opus-5-5" : "claude-haiku-5-5"),
      ...(nodeId === "verify" ? { judgmentTarget: target("claude-opus-5-5") } : {}),
    })),
    layers: [["survey"], ["tests", "change"], ["verify"]],
    writeConflicts: [],
    inputs: [],
    blockers: [],
    advisory: {
      fanOut: "ok",
      reasons: [],
      nodeCount: 4,
      widestWave: 2,
      depth: 3,
      verifierCount: 1,
      estimatedModelCalls: { low: 6, high: 12 },
      estimatedTokens: {
        low: 180_000,
        high: 436_800,
        coordinator: { low: 96_000, high: 106_000 },
        basis: "Measured figures for Codex workers; other drivers are not measured.",
      },
      suggestedBudgetTokens: 420_000,
      overshootBoundTokens: 104_000,
    },
    ...overrides,
  };
}

/** Codex stores the structured result as the tool output. */
export const workflowReviewStoredByCodex = (result: Record<string, unknown>): unknown => result;

/** Claude Code stores the text content next to the structured result. */
export const workflowReviewStoredByClaude = (result: Record<string, unknown>): unknown => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});

import {
  EnvironmentId,
  OrchestrationV2WorkflowApprovalError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  WORKFLOW_REVIEW_FIXTURE_DIGEST,
  WORKFLOW_REVIEW_FIXTURE_ID,
  workflowReviewFixtureResult,
  workflowReviewStoredByClaude,
  workflowReviewStoredByCodex,
} from "@t3tools/shared/testing/workflowReviewFixture";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  isWorkflowReviewItem,
  latestWorkflowReviewItemId,
  presentWorkflowReview,
  readWorkflowReviewOutput,
  runWorkflowReviewDecision,
  workflowReviewDecisionAtom,
  workflowReviewDecisionKey,
  workflowReviewSteps,
  workflowReviewSummary,
  workflowReviewTargetLabel,
  type WorkflowReviewDecision,
  type WorkflowReviewView,
} from "./workflowReview.ts";

const result = () => workflowReviewFixtureResult();
const readOrThrow = (output: unknown): WorkflowReviewView => {
  const review = readWorkflowReviewOutput(output);
  if (review === null) throw new Error("The review did not decode.");
  return review;
};

describe("readWorkflowReviewOutput", () => {
  it("reads the plan: tasks by wave, what each waits for, who runs it, and the advice", () => {
    const review = readOrThrow(workflowReviewStoredByCodex(result()));
    expect(review).toMatchObject({
      reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
      digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      ready: true,
      approvalRequired: true,
      name: "Fix the sync bug",
      blockers: [],
      writeConflictCount: 0,
    });
    expect(review.nodes.map((node) => [node.id, node.wave, node.dependsOn])).toEqual([
      ["survey", 0, []],
      ["tests", 1, ["survey"]],
      ["change", 1, ["survey"]],
      ["verify", 2, ["tests", "change"]],
    ]);
    expect(review.nodes[0]).toMatchObject({
      subject: "Survey the API surface",
      worker: { providerInstanceId: "cliproxy", model: "claude-opus-5-5" },
      judge: null,
    });
    expect(review.nodes[3]?.judge).toEqual({
      providerInstanceId: "cliproxy",
      model: "claude-opus-5-5",
    });
    expect(review.advice).toMatchObject({
      nodeCount: 4,
      estimatedTokens: { low: 180_000, high: 436_800 },
      suggestedBudgetTokens: 420_000,
    });
  });

  it("reads the result however the coordinator stored it", () => {
    const codex = readOrThrow(workflowReviewStoredByCodex(result()));
    expect(readOrThrow(workflowReviewStoredByClaude(result()))).toEqual(codex);
    expect(readOrThrow({ content: [{ type: "text", text: JSON.stringify(result()) }] })).toEqual(
      codex,
    );
    expect(readOrThrow(JSON.stringify(result()))).toEqual(codex);
  });

  it("returns null for output that is not a review, so the generic tool row stays", () => {
    expect(readWorkflowReviewOutput(undefined)).toBeNull();
    expect(readWorkflowReviewOutput("not json")).toBeNull();
    // A truncated string, as the on-demand read returns a result over its size bound.
    expect(readWorkflowReviewOutput(JSON.stringify(result()).slice(0, 300))).toBeNull();
    // A tool error wraps what the provider reported; there is nothing to decide on.
    expect(
      readWorkflowReviewOutput({ error: "refused", result: { content: [{ type: "text" }] } }),
    ).toBeNull();
    expect(readWorkflowReviewOutput(workflowReviewFixtureResult({ reviewId: 7 }))).toBeNull();
  });

  it("offers no approval for a digest the server would not have issued", () => {
    expect(readOrThrow(result()).digest).toBe(WORKFLOW_REVIEW_FIXTURE_DIGEST);
    expect(readOrThrow(workflowReviewFixtureResult({ digest: "sha256:abc" })).digest).toBeNull();
    expect(readOrThrow(workflowReviewFixtureResult({ digest: null })).digest).toBeNull();
  });

  it("keeps the ability to decide when plan details cannot be read", () => {
    const review = readOrThrow(
      workflowReviewFixtureResult({
        expandedGraph: "gone",
        targets: "broken",
        layers: 3,
        advisory: { fanOut: "maybe" },
      }),
    );
    expect(review).toMatchObject({
      reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
      digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      nodes: [],
      advice: null,
    });
  });

  it("lists blockers and carries a review that has none ready", () => {
    const review = readOrThrow(
      workflowReviewFixtureResult({
        ready: false,
        digest: null,
        blockers: ["Node tests has a cycle"],
      }),
    );
    expect(review).toMatchObject({
      ready: false,
      digest: null,
      blockers: ["Node tests has a cycle"],
    });
  });
});

describe("isWorkflowReviewItem and latestWorkflowReviewItemId", () => {
  const item = (
    id: string,
    toolName: string | null,
    at: string,
    type: "dynamic_tool" | "command_execution" = "dynamic_tool",
  ) => ({
    id: TurnItemId.make(id),
    type,
    toolName,
    startedAt: DateTime.makeUnsafe(at),
    updatedAt: DateTime.makeUnsafe(at),
  });

  it("matches graph_review under every server prefix and nothing else", () => {
    for (const name of ["graph_review", "t3-code.graph_review", "mcp__t3-code__graph_review"]) {
      expect(isWorkflowReviewItem({ type: "dynamic_tool", toolName: name })).toBe(true);
    }
    for (const name of ["workflow_start", "graph_start", "other.graph_review", null]) {
      expect(isWorkflowReviewItem({ type: "dynamic_tool", toolName: name })).toBe(false);
    }
    expect(isWorkflowReviewItem({ type: "command_execution", toolName: "graph_review" })).toBe(
      false,
    );
  });

  it("names the newest review of the thread, and none when there is no review", () => {
    expect(
      latestWorkflowReviewItemId([
        item("old", "graph_review", "2026-10-26T10:00:00.000Z"),
        item("new", "t3-code.graph_review", "2026-10-26T11:00:00.000Z"),
        item("later-tool", "workflow_start", "2026-10-26T12:00:00.000Z"),
      ]),
    ).toBe("new");
    expect(
      latestWorkflowReviewItemId([item("only", "workflow_start", "2026-10-26T12:00:00.000Z")]),
    ).toBe(null);
  });
});

describe("runWorkflowReviewDecision", () => {
  const key = workflowReviewDecisionKey(
    EnvironmentId.make("environment-1"),
    ThreadId.make("thread-1"),
    WORKFLOW_REVIEW_FIXTURE_ID,
  );
  const approvalError = (reason: OrchestrationV2WorkflowApprovalError["reason"]) =>
    new OrchestrationV2WorkflowApprovalError({
      threadId: ThreadId.make("thread-1"),
      reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
      reason,
    });
  const failure = (error: unknown) => AsyncResult.failure<void, unknown>(Cause.fail(error));
  const success = AsyncResult.success<void, unknown>(undefined);
  const stateOf = (registry: AtomRegistry.AtomRegistry): WorkflowReviewDecision =>
    registry.get(workflowReviewDecisionAtom(key));

  it("settles after the server accepts the decision, and does not send it twice", async () => {
    const registry = AtomRegistry.make();
    let sent = 0;
    const send = async () => {
      sent += 1;
      return success;
    };
    const first = runWorkflowReviewDecision(registry, { key, action: "approve", send });
    expect(stateOf(registry)).toEqual({ _tag: "pending", action: "approve" });
    // A second click before the first answer, and one after it, both do nothing.
    await runWorkflowReviewDecision(registry, { key, action: "approve", send });
    await first;
    await runWorkflowReviewDecision(registry, { key, action: "dismiss", send });
    expect(sent).toBe(1);
    expect(stateOf(registry)).toEqual({ _tag: "settled", action: "approve" });
  });

  it("allows another try after a failure that does not say the review is gone", async () => {
    const registry = AtomRegistry.make();
    const outcomes = [failure(new Error("offline")), success];
    let sent = 0;
    const send = async () => outcomes[sent++]!;
    await runWorkflowReviewDecision(registry, { key, action: "approve", send });
    expect(stateOf(registry)).toMatchObject({
      _tag: "failed",
      kind: "retry",
      message: "Could not send your decision. Try again.",
    });
    await runWorkflowReviewDecision(registry, { key, action: "approve", send });
    expect(sent).toBe(2);
    expect(stateOf(registry)).toEqual({ _tag: "settled", action: "approve" });
  });

  it("shows the server's words and stops sending once the review is out of date", async () => {
    const registry = AtomRegistry.make();
    let sent = 0;
    const send = async () => {
      sent += 1;
      return failure(approvalError("review-not-found"));
    };
    await runWorkflowReviewDecision(registry, { key, action: "approve", send });
    expect(stateOf(registry)).toEqual({
      _tag: "failed",
      action: "approve",
      kind: "stale",
      message: "This review is out of date. Ask the agent to review the graph again.",
    });
    await runWorkflowReviewDecision(registry, { key, action: "dismiss", send });
    expect(sent).toBe(1);
  });

  it("refuses Approve again after the server reported blockers, but still lets the person dismiss", async () => {
    const registry = AtomRegistry.make();
    const actions: Array<string> = [];
    const send = (action: string) => async () => {
      actions.push(action);
      return action === "approve" ? failure(approvalError("review-blocked")) : success;
    };
    await runWorkflowReviewDecision(registry, { key, action: "approve", send: send("approve") });
    await runWorkflowReviewDecision(registry, { key, action: "approve", send: send("approve") });
    await runWorkflowReviewDecision(registry, { key, action: "dismiss", send: send("dismiss") });
    expect(actions).toEqual(["approve", "dismiss"]);
    expect(stateOf(registry)).toEqual({ _tag: "settled", action: "dismiss" });
  });

  it("returns to idle when the request was interrupted", async () => {
    const registry = AtomRegistry.make();
    await runWorkflowReviewDecision(registry, {
      key,
      action: "approve",
      send: async () => AsyncResult.failure<void, unknown>(Cause.interrupt()),
    });
    expect(stateOf(registry)).toEqual({ _tag: "idle" });
  });

  it("keeps each review's state apart", async () => {
    const registry = AtomRegistry.make();
    const other = workflowReviewDecisionKey(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-1"),
      "review-2",
    );
    await runWorkflowReviewDecision(registry, {
      key,
      action: "dismiss",
      send: async () => success,
    });
    expect(registry.get(workflowReviewDecisionAtom(other))).toEqual({ _tag: "idle" });
  });
});

describe("presentWorkflowReview", () => {
  const ready = readOrThrow(result());
  const blocked = readOrThrow(
    workflowReviewFixtureResult({ ready: false, digest: null, blockers: ["A cycle"] }),
  );
  const idle: WorkflowReviewDecision = { _tag: "idle" };
  const present = (
    overrides: Partial<Parameters<typeof presentWorkflowReview>[0]> = {},
  ): ReturnType<typeof presentWorkflowReview> =>
    presentWorkflowReview({
      review: ready,
      decision: idle,
      canDecide: true,
      superseded: false,
      ...overrides,
    });

  it("offers both buttons on a ready review", () => {
    expect(present()).toMatchObject({
      status: "ready",
      statusLabel: "Waiting for your approval",
      note: null,
      approve: { visible: true, enabled: true, label: "Approve & run" },
      dismiss: { visible: true, enabled: true, label: "Dismiss" },
    });
  });

  it("disables both buttons while a decision is pending, and names it", () => {
    expect(present({ decision: { _tag: "pending", action: "approve" } })).toMatchObject({
      status: "approving",
      approve: { visible: true, enabled: false, label: "Approving\u2026" },
      dismiss: { visible: true, enabled: false },
    });
    expect(present({ decision: { _tag: "pending", action: "dismiss" } })).toMatchObject({
      status: "dismissing",
      dismiss: { enabled: false, label: "Dismissing\u2026" },
    });
  });

  it("closes the card after a decision", () => {
    expect(present({ decision: { _tag: "settled", action: "approve" } })).toMatchObject({
      status: "approved",
      approve: { visible: false },
      dismiss: { visible: false },
    });
    expect(present({ decision: { _tag: "settled", action: "dismiss" } }).status).toBe("dismissed");
  });

  it("lets Dismiss through on a review that cannot be approved", () => {
    expect(present({ review: blocked })).toMatchObject({
      status: "blocked",
      note: { tone: "warning" },
      approve: { visible: true, enabled: false },
      dismiss: { visible: true, enabled: true },
    });
  });

  it("shows a retryable failure with its message and keeps the buttons", () => {
    expect(
      present({
        decision: { _tag: "failed", action: "approve", kind: "retry", message: "Try again." },
      }),
    ).toMatchObject({
      status: "ready",
      note: { tone: "error", text: "Try again." },
      approve: { enabled: true },
    });
  });

  it("shows a review the server no longer holds as out of date, with no buttons", () => {
    expect(
      present({
        decision: { _tag: "failed", action: "approve", kind: "stale", message: "Out of date." },
      }),
    ).toMatchObject({
      status: "stale",
      note: { tone: "error", text: "Out of date." },
      approve: { visible: false },
      dismiss: { visible: false },
    });
  });

  it("shows a replaced review without buttons, and a review that needs no approval as reviewed", () => {
    expect(present({ superseded: true })).toMatchObject({
      status: "superseded",
      approve: { visible: false },
    });
    expect(present({ review: { ...ready, approvalRequired: false } })).toMatchObject({
      status: "info",
      dismiss: { visible: false },
    });
  });

  it("offers no buttons to a person who may not decide here", () => {
    expect(present({ canDecide: false })).toMatchObject({
      status: "read-only",
      approve: { visible: false },
      dismiss: { visible: false },
    });
  });
});

describe("workflowReviewTargetLabel", () => {
  const providers = [
    {
      instanceId: "cliproxy",
      displayName: "CLI Proxy",
      models: [{ slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" }],
    },
  ] as never;
  it("uses the catalog's names, and falls back to the ids the review carries", () => {
    expect(
      workflowReviewTargetLabel(
        { providerInstanceId: "cliproxy", model: "claude-haiku-5-5" },
        providers,
      ),
    ).toBe("CLI Proxy \u00b7 Claude Haiku 5.5");
    expect(
      workflowReviewTargetLabel(
        { providerInstanceId: "cliproxy", model: "claude-opus-5-5" },
        providers,
      ),
    ).toBe("CLI Proxy \u00b7 claude-opus-5-5");
    expect(workflowReviewTargetLabel({ providerInstanceId: "other", model: "m" }, undefined)).toBe(
      "other \u00b7 m",
    );
    expect(workflowReviewTargetLabel(null, providers)).toBe("Provider and model not listed");
  });
});

describe("workflowReviewSummary", () => {
  it("states the shape, the estimate and its basis from the review", () => {
    expect(workflowReviewSummary(readOrThrow(result()))).toEqual({
      shape: "4 tasks in 3 steps",
      cost: "About 180K to 437K tokens, your agent included. Suggested budget 420K.",
      costBasis: "Measured figures for Codex workers; other drivers are not measured.",
      fanOutReasons: [],
      writeConflicts: null,
    });
  });

  it("passes on the server's reason to consider one agent, and write conflicts", () => {
    const summary = workflowReviewSummary(
      readOrThrow(
        workflowReviewFixtureResult({
          writeConflicts: [{ nodes: ["tests", "change"], paths: ["src/a.ts"] }],
          advisory: {
            ...(workflowReviewFixtureResult().advisory as object),
            fanOut: "consider_single",
            reasons: ["The nodes form a chain."],
          },
        }),
      ),
    );
    expect(summary.fanOutReasons).toEqual(["The nodes form a chain."]);
    expect(summary.writeConflicts).toBe("1 group of tasks write the same paths.");
  });

  it("omits the cost line when the server gave no advice", () => {
    const summary = workflowReviewSummary(
      readOrThrow(workflowReviewFixtureResult({ advisory: undefined })),
    );
    expect(summary.cost).toBeNull();
    expect(summary.costBasis).toBeNull();
  });
});

describe("workflowReviewSteps", () => {
  it("groups tasks by dependency layer, in layer order, numbered from one", () => {
    expect(
      workflowReviewSteps(readOrThrow(result())).map(({ step, nodes }) => [
        step,
        nodes.map((node) => node.id),
      ]),
    ).toEqual([
      [1, ["survey"]],
      [2, ["tests", "change"]],
      [3, ["verify"]],
    ]);
    expect(
      workflowReviewSteps(
        readOrThrow(workflowReviewFixtureResult({ layers: [], expandedGraph: null, targets: [] })),
      ),
    ).toEqual([]);
  });
});

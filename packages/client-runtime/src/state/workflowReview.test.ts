import {
  EnvironmentId,
  OrchestrationV2WorkflowApprovalError,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  WORKFLOW_REVIEW_FIXTURE_DIGEST,
  WORKFLOW_REVIEW_FIXTURE_ID,
  workflowReviewFixtureLargeRecord,
  workflowReviewFixtureRecord,
} from "@t3tools/shared/testing/workflowReviewFixture";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  isProjectedWorkflowReview,
  isWorkflowReviewItem,
  latestWorkflowReviewItemId,
  presentWorkflowReview,
  runWorkflowReviewDecision,
  workflowReviewDecisionAtom,
  workflowReviewDecisionKey,
  workflowReviewNodeLines,
  workflowReviewOf,
  workflowReviewSteps,
  workflowReviewSummary,
  workflowReviewTargetLabel,
  type WorkflowReviewDecision,
} from "./workflowReview.ts";

const at = DateTime.makeUnsafe("2026-10-26T12:00:00.000Z");
const reviewItem = (
  overrides: Parameters<typeof workflowReviewFixtureRecord>[0] = {},
  id = "review-item",
  time = at,
): Extract<OrchestrationV2TurnItem, { readonly type: "workflow_review" }> => ({
  id: TurnItemId.make(id),
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: time,
  completedAt: time,
  updatedAt: time,
  ...workflowReviewFixtureRecord(overrides),
});
const reviewOf = (overrides: Parameters<typeof workflowReviewFixtureRecord>[0] = {}) =>
  workflowReviewOf(workflowReviewFixtureRecord(overrides));

describe("workflowReviewOf", () => {
  it("reads the plan: tasks by wave, what each waits for, who runs it, and the advice", () => {
    const review = reviewOf();
    expect(review).toMatchObject({
      reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
      digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      ready: true,
      approvalRequired: true,
      name: "Fix the sync bug",
      blockers: [],
      taskCount: 4,
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
      check: null,
    });
    expect(review.nodes[3]).toMatchObject({
      judge: { providerInstanceId: "cliproxy", model: "claude-opus-5-5" },
      check: "judgment",
    });
    expect(review.advice).toMatchObject({
      nodeCount: 4,
      estimatedTokens: { low: 180_000, high: 436_800 },
      suggestedBudgetTokens: 420_000,
    });
  });

  it("keeps the id and digest of a review with no plan, advice or digest", () => {
    expect(reviewOf({ tasks: [], taskCount: 0, advice: undefined })).toMatchObject({
      reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
      digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      nodes: [],
      advice: null,
    });
    expect(reviewOf({ digest: null, ready: false, blockers: ["A cycle"] })).toMatchObject({
      ready: false,
      digest: null,
      blockers: ["A cycle"],
    });
  });

  it("keeps the controls of a review larger than the record lists, and says how many are not shown", () => {
    const review = workflowReviewOf(workflowReviewFixtureLargeRecord(400));
    expect(review).toMatchObject({
      reviewId: WORKFLOW_REVIEW_FIXTURE_ID,
      digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      taskCount: 400,
    });
    expect(review.nodes).toHaveLength(120);
    expect(
      presentWorkflowReview({
        review,
        decision: { _tag: "idle" },
        canDecide: true,
        superseded: false,
        local: true,
      }),
    ).toMatchObject({ status: "ready", approve: { enabled: true }, dismiss: { enabled: true } });
    expect(workflowReviewSummary(review)).toMatchObject({
      shape: "400 tasks in 1 step",
      moreTasks: "280 more tasks not listed here.",
    });
  });
});

describe("isWorkflowReviewItem and latestWorkflowReviewItemId", () => {
  it("is true for review records only: a graph_review tool call carries nothing to decide on", () => {
    expect(isWorkflowReviewItem(reviewItem())).toBe(true);
    expect(isWorkflowReviewItem({ type: "dynamic_tool" })).toBe(false);
    expect(isWorkflowReviewItem({ type: "secret_request" })).toBe(false);
    const row = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
      position: 0,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    });
    expect(isProjectedWorkflowReview(row(reviewItem()))).toBe(true);
  });

  it("names the newest review of the thread, and none when there is no review", () => {
    const later = (second: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 26, 12, 0, second));
    expect(
      latestWorkflowReviewItemId([
        reviewItem({}, "old", later(0)),
        reviewItem({}, "new", later(30)),
        { ...reviewItem({}, "tool", later(50)), type: "dynamic_tool" as never },
      ]),
    ).toBe("new");
    expect(latestWorkflowReviewItemId([])).toBe(null);
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
  const ready = reviewOf();
  const blocked = reviewOf({ ready: false, digest: null, blockers: ["A cycle"] });
  const idle: WorkflowReviewDecision = { _tag: "idle" };
  const present = (
    overrides: Partial<Parameters<typeof presentWorkflowReview>[0]> = {},
  ): ReturnType<typeof presentWorkflowReview> =>
    presentWorkflowReview({
      review: ready,
      decision: idle,
      canDecide: true,
      superseded: false,
      local: true,
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

  it("shows a review inherited from a forked thread without buttons", () => {
    expect(present({ local: false })).toMatchObject({
      status: "info",
      approve: { visible: false },
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
    expect(workflowReviewSummary(reviewOf())).toEqual({
      shape: "4 tasks in 3 steps",
      moreTasks: null,
      moreBlockers: null,
      cost: "About 180K to 437K tokens, your agent included. Suggested budget 420K.",
      costBasis: "Measured figures for Codex workers; other drivers are not measured.",
      fanOutReasons: [],
      writeConflicts: null,
    });
  });

  it("passes on the server's reason to consider one agent, and write conflicts", () => {
    const base = workflowReviewFixtureRecord();
    const summary = workflowReviewSummary(
      reviewOf({
        writeConflictCount: 1,
        advice: {
          ...base.advice!,
          fanOut: "consider_single",
          reasons: ["The nodes form a chain."],
        },
      }),
    );
    expect(summary.fanOutReasons).toEqual(["The nodes form a chain."]);
    expect(summary.writeConflicts).toBe("1 group of tasks write the same paths.");
  });

  it("omits the cost line when the server gave no advice, and counts blockers it did not list", () => {
    const summary = workflowReviewSummary(reviewOf({ advice: undefined, blockersMore: 3 }));
    expect(summary.cost).toBeNull();
    expect(summary.costBasis).toBeNull();
    expect(summary.moreBlockers).toBe("3 more blockers not listed.");
  });
});

describe("workflowReviewNodeLines", () => {
  it("names who runs a task, how it is checked and what it waits for", () => {
    const [survey, , , verify] = reviewOf().nodes;
    expect(workflowReviewNodeLines(survey!, undefined)).toEqual({
      runs: "cliproxy \u00b7 claude-opus-5-5",
      after: null,
    });
    expect(workflowReviewNodeLines(verify!, undefined)).toEqual({
      runs: "cliproxy \u00b7 claude-haiku-5-5 \u00b7 checked by cliproxy \u00b7 claude-opus-5-5",
      after: "After tests, change",
    });
    expect(
      workflowReviewNodeLines(
        { ...survey!, check: "process", dependsOn: ["a"], dependsOnMore: 2 },
        undefined,
      ),
    ).toEqual({
      runs: "cliproxy \u00b7 claude-opus-5-5 \u00b7 checked by a command",
      after: "After a, 2 more",
    });
    expect(workflowReviewNodeLines({ ...survey!, check: "structured" }, undefined).runs).toContain(
      "checked against its output",
    );
  });
});

describe("workflowReviewSteps", () => {
  it("groups tasks by dependency layer, in layer order, numbered from one", () => {
    expect(
      workflowReviewSteps(reviewOf()).map(({ step, nodes }) => [
        step,
        nodes.map((node) => node.id),
      ]),
    ).toEqual([
      [1, ["survey"]],
      [2, ["tests", "change"]],
      [3, ["verify"]],
    ]);
    expect(workflowReviewSteps(reviewOf({ tasks: [], taskCount: 0 }))).toEqual([]);
  });
});

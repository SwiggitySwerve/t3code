import {
  EnvironmentId,
  OrchestrationV2WorkflowApprovalError,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2WorkflowReviewRecord,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  WORKFLOW_REVIEW_FIXTURE_DIGEST,
  workflowReviewFixtureLargeRecord,
  workflowReviewFixtureRecord,
} from "@t3tools/shared/testing/workflowReviewFixture";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { createRef, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { QA_PROVIDERS } from "../../../test/workflow-fixtures/providers";
import { act, render } from "../../../test/render";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { orchestrationEnvironment } from "../../state/orchestration";
import { providersIgnoringCheckedAtAtom } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { MessagesTimeline } from "./MessagesTimeline";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("thread-review");
const RUN_ID = RunId.make("run-review");

// Everything the card reads from the app is replaced at the seam it reads it through: the two
// commands, the permission, the provider catalog and the thread's items. The decision state itself
// is the real shared atom, so the card is tested as the person uses it.
const app = vi.hoisted(() => ({
  canDecide: true,
  turnItems: [] as ReadonlyArray<unknown>,
  approve: undefined as unknown as ReturnType<typeof vi.fn>,
  dismiss: undefined as unknown as ReturnType<typeof vi.fn>,
}));

// The app modules are imported statically: a factory for the atom library must not import them,
// because they import the library back and the mock would wait on itself.
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: unknown) =>
    command === orchestrationEnvironment.approveWorkflowReview
      ? app.approve
      : app.dismiss) as never,
}));
vi.mock(import("@effect/atom-react"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAtomValue: ((atom: unknown, selector?: (value: unknown) => unknown) => {
      const stubs: ReadonlyArray<readonly [unknown, unknown]> = [
        [
          orchestrationEnvironment.approveWorkflowReview.permissionAtom(ENVIRONMENT_ID),
          app.canDecide,
        ],
        [providersIgnoringCheckedAtAtom(ENVIRONMENT_ID), QA_PROVIDERS],
        [
          environmentThreadDetails.threadAtom(scopeThreadRef(ENVIRONMENT_ID, THREAD_ID)),
          { projection: { turnItems: app.turnItems, subagents: [] } },
        ],
      ];
      const hit = stubs.find(([stubbed]) => stubbed === atom);
      if (hit === undefined) {
        return selector === undefined
          ? actual.useAtomValue(atom as never)
          : actual.useAtomValue(atom as never, selector as never);
      }
      return selector === undefined ? hit[1] : selector(hit[1]);
    }) as never,
  };
});

type TimelineProps = ComponentProps<typeof MessagesTimeline>;

function timelineProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `${ENVIRONMENT_ID}:${THREAD_ID}:${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
  };
}

const at = (second: number) => DateTime.makeUnsafe(new Date(Date.UTC(2026, 9, 26, 12, 0, second)));
const base = (id: string, second: number) => ({
  id: TurnItemId.make(id),
  threadId: THREAD_ID,
  runId: RUN_ID,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: second,
  status: "completed" as const,
  title: null,
  startedAt: at(second),
  completedAt: at(second),
  updatedAt: at(second),
});

/** The review record the server writes beside the graph_review call. */
function reviewItem(
  id: string,
  second: number,
  record: Partial<OrchestrationV2WorkflowReviewRecord> = {},
) {
  const item = {
    ...base(id, second),
    ...workflowReviewFixtureRecord(record),
  };
  return {
    position: second,
    visibility: "local" as const,
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  } satisfies OrchestrationV2ProjectedTurnItem;
}

/**
 * The graph_review call as the thread holds it: its result is model-facing text the client never
 * reads, and may be too large to store at all, so the item carries no output.
 */
function reviewToolCall(id: string, second: number) {
  const item = {
    ...base(id, second),
    type: "dynamic_tool" as const,
    toolName: "t3-code.graph_review",
    input: { graph: "..." },
    outputOmitted: true,
  };
  return {
    position: second,
    visibility: "local" as const,
    sourceThreadId: THREAD_ID,
    sourceItemId: item.id,
    item,
  } satisfies OrchestrationV2ProjectedTurnItem;
}

/** A finished turn: the person's request, the agent's review, and the agent's closing message. */
async function renderReviewTurn(options: {
  readonly record?: Partial<OrchestrationV2WorkflowReviewRecord>;
  readonly fullRecord?: OrchestrationV2WorkflowReviewRecord;
  readonly reviewItemId?: string;
}) {
  const review = reviewItem(
    options.reviewItemId ?? "review-item",
    3,
    options.fullRecord ?? options.record,
  );
  app.turnItems = app.turnItems.length > 0 ? app.turnItems : [review.item];
  const entries = deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        sourceItemId: TurnItemId.make("user-item"),
        item: {
          ...base("user-item", 0),
          runId: null,
          type: "user_message",
          messageId: "user-message" as never,
          text: "Run a workflow to fix the sync bug",
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
        },
      },
      reviewToolCall("review-tool-call", 2),
      review,
      {
        position: 4,
        visibility: "local",
        sourceThreadId: THREAD_ID,
        sourceItemId: TurnItemId.make("assistant-item"),
        item: {
          ...base("assistant-item", 4),
          type: "assistant_message",
          messageId: "assistant-message" as never,
          text: "I reviewed the graph. Approve it to start.",
          streaming: false,
        },
      },
    ],
    optimisticMessages: [],
  });
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(<MessagesTimeline {...timelineProps()} timelineEntries={entries} />, {
    container,
  });
  return screen;
}

function resetApp() {
  app.canDecide = true;
  app.turnItems = [];
  app.approve = vi.fn(async () => AsyncResult.success<void, unknown>(undefined));
  app.dismiss = vi.fn(async () => AsyncResult.success<void, unknown>(undefined));
}

// The assistant message beside the card has buttons of its own, so everything is read inside the card.
const button = (container: HTMLElement, name: string) => {
  const found = [...(card(container)?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent?.trim().startsWith(name),
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const click = (element: HTMLElement) => act(async () => element.click());
const card = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-workflow-review]");
const failure = (error: unknown) => AsyncResult.failure<void, unknown>(Cause.fail(error));
const approvalError = (reviewId: string, reason: OrchestrationV2WorkflowApprovalError["reason"]) =>
  new OrchestrationV2WorkflowApprovalError({ threadId: THREAD_ID, reviewId, reason });

describe("workflow review card in the chat timeline", () => {
  it("shows the reviewed graph on a finished turn: tasks, order, workers and cost", async () => {
    resetApp();
    await using screen = await renderReviewTurn({
      record: { reviewId: "review-shows" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    const text = card(screen.container)!.textContent ?? "";
    expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("ready");
    for (const expected of [
      "Fix the sync bug",
      "4 tasks in 3 steps",
      "Waiting for your approval",
      "Survey the API surface",
      "Verify the build and the tests",
      "After tests, change",
      "CLI Proxy \u00b7 Claude Opus 5.5",
      "CLI Proxy \u00b7 Claude Haiku 5.5",
      "checked by CLI Proxy \u00b7 Claude Opus 5.5",
      "About 180K to 437K tokens",
      "Suggested budget 420K",
      "Approve & run",
      "Dismiss",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("approves with the review id and digest the server issued, once, and shows it as approved", async () => {
    resetApp();
    let answer: (value: unknown) => void = () => {};
    app.approve = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await using screen = await renderReviewTurn({
      record: { reviewId: "review-approve" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    const approve = button(screen.container, "Approve & run");
    await click(approve);
    await click(approve);
    await click(approve);
    // Pending: disabled, named, and the Dismiss beside it is held too.
    expect(app.approve).toHaveBeenCalledTimes(1);
    expect(app.approve).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        reviewId: "review-approve",
        digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      },
    });
    expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("approving");
    expect(button(screen.container, "Approving").disabled).toBe(true);
    expect(button(screen.container, "Dismiss").disabled).toBe(true);
    await act(async () => answer(AsyncResult.success<void, unknown>(undefined)));
    await vi.waitFor(() =>
      expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("approved"),
    );
    expect(card(screen.container)!.textContent).toContain("The agent is starting this workflow.");
    expect(card(screen.container)!.querySelector("button")).toBeNull();
    expect(app.dismiss).not.toHaveBeenCalled();
  });

  it("dismisses with the same id and digest", async () => {
    resetApp();
    await using screen = await renderReviewTurn({
      record: { reviewId: "review-dismiss" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    await click(button(screen.container, "Dismiss"));
    expect(app.dismiss).toHaveBeenCalledTimes(1);
    expect(app.dismiss).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        reviewId: "review-dismiss",
        digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      },
    });
    await vi.waitFor(() =>
      expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("dismissed"),
    );
    expect(app.approve).not.toHaveBeenCalled();
  });

  it("cannot approve a review with blockers, but can dismiss it by id with no digest", async () => {
    resetApp();
    await using screen = await renderReviewTurn({
      record: {
        reviewId: "review-blocked",
        ready: false,
        digest: null,
        blockers: ["Task tests depends on itself"],
      },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("blocked");
    expect(card(screen.container)!.textContent).toContain("Task tests depends on itself");
    expect(button(screen.container, "Approve & run").disabled).toBe(true);
    await click(button(screen.container, "Approve & run"));
    expect(app.approve).not.toHaveBeenCalled();
    await click(button(screen.container, "Dismiss"));
    expect(app.dismiss).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        reviewId: "review-blocked",
        digest: null,
      },
    });
  });

  it("says so honestly when the send fails, and lets the person try again", async () => {
    resetApp();
    app.approve = vi
      .fn()
      .mockResolvedValueOnce(failure(new Error("offline")))
      .mockResolvedValueOnce(AsyncResult.success<void, unknown>(undefined));
    await using screen = await renderReviewTurn({
      record: { reviewId: "review-retry" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    await click(button(screen.container, "Approve & run"));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[role=alert]")?.textContent).toBe(
        "Could not send your decision. Try again.",
      ),
    );
    expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("ready");
    await click(button(screen.container, "Approve & run"));
    expect(app.approve).toHaveBeenCalledTimes(2);
    await vi.waitFor(() =>
      expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("approved"),
    );
  });

  it("shows a review the server no longer holds as out of date, with the server's words", async () => {
    resetApp();
    app.approve = vi.fn(async () => failure(approvalError("review-stale", "review-not-found")));
    await using screen = await renderReviewTurn({
      record: { reviewId: "review-stale" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    await click(button(screen.container, "Approve & run"));
    await vi.waitFor(() =>
      expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("stale"),
    );
    expect(card(screen.container)!.textContent).toContain(
      "This review is out of date. Ask the agent to review the graph again.",
    );
    expect(card(screen.container)!.querySelector("button")).toBeNull();
  });

  it("offers no decision on a review a newer one replaced, or to someone who may not decide", async () => {
    resetApp();
    app.turnItems = [reviewItem("review-item", 3).item, reviewItem("newer-review-item", 9).item];
    {
      await using screen = await renderReviewTurn({
        record: { reviewId: "review-old" },
      });
      await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
      expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("superseded");
      expect(card(screen.container)!.querySelector("button")).toBeNull();
    }
    resetApp();
    app.canDecide = false;
    await using screen = await renderReviewTurn({
      record: { reviewId: "review-readonly" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("read-only");
    expect(card(screen.container)!.querySelector("button")).toBeNull();
  });

  it("keeps Approve and Dismiss on a review whose tool result is too large to store", async () => {
    resetApp();
    // 400 tasks with long labels: the graph_review result is over 256 KiB, so the thread's tool item
    // holds no output. The decision comes from the record the server wrote, which lists 120 tasks.
    await using screen = await renderReviewTurn({
      fullRecord: { ...workflowReviewFixtureLargeRecord(400), reviewId: "review-large" },
    });
    await vi.waitFor(() => expect(card(screen.container)).not.toBeNull());
    expect(card(screen.container)!.dataset.workflowReviewStatus).toBe("ready");
    expect(card(screen.container)!.textContent).toContain("400 tasks in 1 step");
    expect(card(screen.container)!.textContent).toContain("280 more tasks not listed here.");
    expect(button(screen.container, "Approve & run").disabled).toBe(false);
    await click(button(screen.container, "Approve & run"));
    expect(app.approve).toHaveBeenCalledTimes(1);
    expect(app.approve).toHaveBeenCalledWith({
      environmentId: ENVIRONMENT_ID,
      input: {
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        reviewId: "review-large",
        digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      },
    });
  });

  it("keeps the generic tool row for a review made before records existed", async () => {
    resetApp();
    // An older thread holds the graph_review call and nothing else: there is no record to decide on,
    // so the call is an ordinary tool row in the turn's work and no card offers a decision.
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [reviewToolCall("old-review-tool-call", 1)],
      optimisticMessages: [],
    });
    await using screen = await render(
      <MessagesTimeline {...timelineProps()} timelineEntries={entries} />,
      { container: document.createElement("div") },
    );
    await vi.waitFor(() => expect(screen.container.textContent).toContain("Worked for"));
    expect(card(screen.container)).toBeNull();
    expect(screen.container.textContent).not.toContain("Approve & run");
  });
});

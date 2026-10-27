import {
  EnvironmentId,
  OrchestrationV2WorkflowApprovalError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  WORKFLOW_REVIEW_FIXTURE_DIGEST,
  workflowReviewFixtureLargeRecord,
  workflowReviewFixtureRecord,
} from "@t3tools/shared/testing/workflowReviewFixture";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type PressableProps = {
  children?: ReactNode;
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
};

const harness = vi.hoisted(() => ({
  permission: { kind: "permission" },
  thread: { kind: "thread" },
  canDecide: true,
  items: [] as ReadonlyArray<unknown>,
  approve: undefined as unknown as ReturnType<typeof vi.fn>,
  dismiss: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Pressable: (props: PressableProps) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      disabled={props.disabled}
      onClick={() => props.onPress?.()}
    >
      {props.children}
    </button>
  ),
  AccessibilityInfo: { announceForAccessibility: () => {} },
  Platform: { OS: "ios" },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <i data-busy />,
}));
vi.mock("../../components/ui/GlassSurface", () => ({
  GlassSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@effect/atom-react", async (original) => {
  const actual = await original<typeof import("@effect/atom-react")>();
  return {
    ...actual,
    useAtomValue: ((atom: unknown, select?: (thread: unknown) => unknown) =>
      atom === harness.permission
        ? harness.canDecide
        : atom === harness.thread
          ? select?.({ projection: { turnItems: harness.items } })
          : select === undefined
            ? actual.useAtomValue(atom as never)
            : actual.useAtomValue(atom as never, select as never)) as never,
  };
});
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    approveWorkflowReview: { permissionAtom: () => harness.permission },
    dismissWorkflowReview: {},
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => harness.thread },
}));
vi.mock("../../state/use-atom-command", async () => {
  const { orchestrationEnvironment } = await import("../../state/orchestration");
  return {
    useAtomCommand: (command: unknown) =>
      command === orchestrationEnvironment.approveWorkflowReview
        ? harness.approve
        : harness.dismiss,
  };
});
vi.mock("../../state/entities", () => ({
  useEnvironmentServerConfig: () => ({
    providers: [
      {
        instanceId: "cliproxy",
        displayName: "CLI Proxy",
        models: [
          { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
          { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
        ],
      },
    ],
  }),
}));

import { ThreadWorkflowReview } from "./thread-workflow-review";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const THREAD = ThreadId.make("thread-a");

const SECOND = (n: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 26, 12, 0, n));

/** The review record the server wrote for a graph_review, as the thread's feed holds it. */
function projectedReview(
  id = "review-item",
  record: Parameters<typeof workflowReviewFixtureRecord>[0] = {},
  visibility = "local",
) {
  return {
    position: 1,
    visibility,
    sourceThreadId: THREAD,
    sourceItemId: TurnItemId.make(id),
    item: {
      id: TurnItemId.make(id),
      threadId: THREAD,
      startedAt: SECOND(1),
      updatedAt: SECOND(1),
      ...workflowReviewFixtureRecord(record),
    },
  };
}

let root: Root;
let container: HTMLElement;

function show(
  record: Parameters<typeof workflowReviewFixtureRecord>[0] = {},
  visibility = "local",
) {
  act(() =>
    root.render(
      <ThreadWorkflowReview
        environmentId={ENVIRONMENT}
        projectedItem={projectedReview("review-item", record, visibility) as never}
      />,
    ),
  );
}

const button = (name: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith(name),
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const press = async (element: HTMLElement) => {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
};
const text = () => container.textContent ?? "";
const failure = (error: unknown) => AsyncResult.failure<void, unknown>(Cause.fail(error));
const ok = () => AsyncResult.success<void, unknown>(undefined);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  harness.canDecide = true;
  harness.items = [];
  harness.approve = vi.fn(async () => ok());
  harness.dismiss = vi.fn(async () => ok());
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ThreadWorkflowReview", () => {
  it("shows the reviewed graph: tasks by step, who runs each, and the cost", () => {
    show({ reviewId: "review-shows" });
    for (const expected of [
      "Fix the sync bug",
      "4 tasks in 3 steps",
      "Waiting for your approval",
      "Survey the API surface",
      "After tests, change",
      "CLI Proxy \u00b7 Claude Opus 5.5",
      "checked by CLI Proxy \u00b7 Claude Opus 5.5",
      "About 180K to 437K tokens",
    ]) {
      expect(text()).toContain(expected);
    }
  });

  it("approves with the review id and digest the server issued, once, and shows it approved", async () => {
    let answer: (value: unknown) => void = () => {};
    harness.approve = vi.fn(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    show({ reviewId: "review-approve" });
    const approve = button("Approve & run");
    await press(approve);
    await press(approve);
    expect(harness.approve).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: {
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        reviewId: "review-approve",
        digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      },
    });
    // Pending: the label names it, and both buttons are held.
    expect(text()).toContain("Approving\u2026");
    expect(button("Approving").disabled).toBe(true);
    expect(button("Dismiss").disabled).toBe(true);
    await act(async () => answer(ok()));
    expect(text()).toContain("Approved. The agent is starting this workflow.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("dismisses with the same id and digest", async () => {
    show({ reviewId: "review-dismiss" });
    await press(button("Dismiss"));
    expect(harness.dismiss).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: {
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        reviewId: "review-dismiss",
        digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      },
    });
    expect(harness.approve).not.toHaveBeenCalled();
    expect(text()).toContain("Dismissed. The agent will not start a workflow for this request.");
  });

  it("cannot approve a review with blockers, and dismisses it by id with no digest", async () => {
    show({
      reviewId: "review-blocked",
      ready: false,
      digest: null,
      blockers: ["Task tests depends on itself"],
    });
    expect(text()).toContain("Task tests depends on itself");
    expect(button("Approve & run").disabled).toBe(true);
    await press(button("Approve & run"));
    expect(harness.approve).not.toHaveBeenCalled();
    await press(button("Dismiss"));
    expect(harness.dismiss).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: {
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        reviewId: "review-blocked",
        digest: null,
      },
    });
  });

  it("says so when the send fails, lets the person try again, and shows a gone review as out of date", async () => {
    harness.approve = vi
      .fn()
      .mockResolvedValueOnce(failure(new Error("offline")))
      .mockResolvedValueOnce(
        failure(
          new OrchestrationV2WorkflowApprovalError({
            threadId: THREAD,
            reviewId: "review-error",
            reason: "review-not-found",
          }),
        ),
      );
    show({ reviewId: "review-error" });
    await press(button("Approve & run"));
    expect(text()).toContain("Could not send your decision. Try again.");
    expect(button("Approve & run").disabled).toBe(false);
    await press(button("Approve & run"));
    expect(harness.approve).toHaveBeenCalledTimes(2);
    expect(text()).toContain(
      "This review is out of date. Ask the agent to review the graph again.",
    );
    expect(text()).toContain("Out of date");
    expect(container.querySelector("button")).toBeNull();
  });

  it("offers no decision on a replaced review or to someone who may not decide", () => {
    harness.items = [
      projectedReview("review-item").item,
      { ...projectedReview("newer").item, startedAt: SECOND(30), updatedAt: SECOND(30) },
    ];
    // A newer review exists, so this one is replaced.
    show({ reviewId: "review-old" });
    expect(text()).toContain("Replaced");
    expect(container.querySelector("button")).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    harness.items = [];
    harness.canDecide = false;
    show({ reviewId: "review-readonly" });
    expect(text()).toContain("You cannot approve workflows in this environment.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps Approve and Dismiss on a review whose tool result is too large to store", async () => {
    // 400 tasks with long labels: the record lists 120 and says how many it left out.
    harness.items = [];
    act(() =>
      root.render(
        <ThreadWorkflowReview
          environmentId={ENVIRONMENT}
          projectedItem={
            {
              ...projectedReview("review-item"),
              item: {
                ...projectedReview("review-item").item,
                ...workflowReviewFixtureLargeRecord(400),
                reviewId: "review-large",
              },
            } as never
          }
        />,
      ),
    );
    expect(text()).toContain("400 tasks in 1 step");
    expect(text()).toContain("280 more tasks not listed here.");
    expect(button("Approve & run").disabled).toBe(false);
    await press(button("Approve & run"));
    expect(harness.approve).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT,
      input: {
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        reviewId: "review-large",
        digest: WORKFLOW_REVIEW_FIXTURE_DIGEST,
      },
    });
  });

  it("shows a review inherited from a forked thread without buttons", () => {
    show({}, "inherited");
    expect(text()).toContain("Fix the sync bug");
    expect(container.querySelector("button")).toBeNull();
  });
});

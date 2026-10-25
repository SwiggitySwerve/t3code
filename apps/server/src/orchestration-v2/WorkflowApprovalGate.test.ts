import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2WorkflowApprovalError,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorkflowApprovalGate from "./WorkflowApprovalGate.ts";

const environmentId = EnvironmentId.make("environment:gate");
const threadId = ThreadId.make("thread:gate");
const otherThreadId = ThreadId.make("thread:gate-other");
const digestA = `sha256:${"a".repeat(64)}`;
const digestB = `sha256:${"b".repeat(64)}`;
const triggers = { enabled: true, extras: [] };

const person = {
  workflowTriggers: triggers,
  createdBy: "user",
  creationSource: "web",
  delegatedThread: false,
  resumesEarlierTurn: false,
} as const;

const turn = (
  messageId: string,
  typedText: string,
  overrides: Partial<
    Parameters<WorkflowApprovalGate.WorkflowApprovalGate["Service"]["observeTurn"]>[0]
  > = {},
) => ({ ...person, threadId, messageId: MessageId.make(messageId), typedText, ...overrides });

/** What the thread has stored: only the parts the gate reads when it re-arms after a restart. */
interface Stored {
  readonly relationshipToParent?: "subagent" | null;
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly restartContinuationOfRunId?: string;
  }>;
  readonly items: ReadonlyArray<Record<string, unknown>>;
}

const start = (
  n: number,
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "user_message",
  id: `item:${n}`,
  runId: RunId.make(`run:${n}`),
  ordinal: n,
  messageId: MessageId.make(`message:${n}`),
  inputIntent: "turn_start",
  text,
  createdBy: "user",
  creationSource: "web",
  attachments: [],
  ...overrides,
});
const runs = (...ordinals: ReadonlyArray<number>) =>
  ordinals.map((n) => ({ id: RunId.make(`run:${n}`), ordinal: n }));

const NOTHING_STORED: Stored = { runs: [], items: [] };

const makeLayer = (
  read: (id: ThreadId) => Effect.Effect<Stored, ProjectionStore.ProjectionStoreReadError>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  WorkflowApprovalGate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (id) =>
            read(id).pipe(
              Effect.map(
                (stored) =>
                  ({
                    thread: {
                      lineage: { relationshipToParent: stored.relationshipToParent ?? null },
                    },
                    runs: stored.runs,
                    turnItems: stored.items,
                  }) as never,
              ),
            ),
        }),
        ServerSettings.layerTest(settings),
      ),
    ),
  );

const withGate = <A, E>(
  use: (gate: WorkflowApprovalGate.WorkflowApprovalGate["Service"]) => Effect.Effect<A, E>,
  stored: Stored = NOTHING_STORED,
  settings?: Parameters<typeof ServerSettings.layerTest>[0],
) =>
  Effect.gen(function* () {
    return yield* use(yield* WorkflowApprovalGate.WorkflowApprovalGate);
  }).pipe(Effect.provide(makeLayer(() => Effect.succeed(stored), settings)));

type Gate = WorkflowApprovalGate.WorkflowApprovalGate["Service"];

const reviewInput = (
  reviewId: string,
  digest: string | null,
  options: { readonly ready?: boolean } = {},
) => ({ environmentId, reviewId, digest, ready: options.ready ?? digest !== null });

/** A review that began and finished with nothing in between. */
const review = (
  gate: Gate,
  reviewId: string,
  digest: string | null,
  options: { readonly ready?: boolean; readonly thread?: ThreadId } = {},
) =>
  gate
    .beginReview(options.thread ?? threadId)
    .pipe(
      Effect.flatMap((ticket) =>
        gate.completeReview(ticket, reviewInput(reviewId, digest, options)),
      ),
    );

/**
 * A review whose work is still running while `meanwhile` happens, as a slow graph_review is
 * while the person writes. Answers with what the review reported or the reason it was refused.
 */
const reviewAcross = (
  gate: Gate,
  reviewId: string,
  digest: string,
  meanwhile: Effect.Effect<
    unknown,
    WorkflowApprovalGate.WorkflowApprovalRequiredError | OrchestrationV2WorkflowApprovalError
  >,
) =>
  Effect.gen(function* () {
    const begun = yield* Deferred.make<void>();
    const proceed = yield* Deferred.make<void>();
    const finished = yield* Effect.gen(function* () {
      const ticket = yield* gate.beginReview(threadId);
      yield* Deferred.succeed(begun, undefined);
      yield* Deferred.await(proceed);
      return yield* gate.completeReview(ticket, reviewInput(reviewId, digest));
    }).pipe(
      Effect.catchTags({
        WorkflowApprovalRequiredError: (error) => Effect.succeed({ refused: error.reason }),
      }),
      Effect.forkChild,
    );
    yield* Deferred.await(begun);
    yield* meanwhile;
    yield* Deferred.succeed(proceed, undefined);
    return yield* Fiber.join(finished);
  });

const decision = (reviewId: string, digest: string = digestA) => ({
  environmentId,
  threadId,
  reviewId,
  digest,
});

/** The request that arms the gate, with one ready review of it. */
const armedWithReview = (gate: Gate) =>
  Effect.gen(function* () {
    yield* gate.observeTurn(turn("message:1", "Plan this as a workflow"));
    yield* review(gate, "review:1", digestA);
  });

const reasonOf = <A, X>(effect: Effect.Effect<X, { readonly reason: A }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

/**
 * The launch key of an approved digest: the thread, the request message and the digest. The
 * decision that approved it is not part of it.
 */
const keyOf = (digest: string, request = "message:1", thread: ThreadId = threadId) =>
  `approval:${thread}:${request}:${digest}`;

/** Runs a start of `digest`. Answers with the key the start was given, or "open" when none. */
const guarded = <E = never>(
  gate: Gate,
  digest: string,
  run: (key: string | undefined) => Effect.Effect<string, E> = (key) =>
    Effect.succeed(key ?? "open") as Effect.Effect<string, E>,
) => gate.guardGraphStart({ threadId, digest }, run);

describe("turn start", () => {
  it.effect(
    "arms for a person's request, lifts for their next plain message, ignores the rest",
    () =>
      withGate((gate) =>
        Effect.gen(function* () {
          assert.equal(
            yield* gate.observeTurn(turn("message:1", "Plan this as a workflow")),
            "requested",
          );
          assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
          // None of these is a person's new message, so none of them changes what is waiting.
          for (const overrides of [
            { createdBy: "agent", creationSource: "mcp" },
            { createdBy: "user", creationSource: "server" },
            { createdBy: "user", creationSource: "web", scheduledTaskId: "task-1" },
            { createdBy: "user", creationSource: "web", senderThreadId: otherThreadId },
            { delegatedThread: true },
            { resumesEarlierTurn: true },
          ] as const) {
            assert.equal(
              yield* gate.observeTurn(turn("message:2", "A plain follow-up", overrides)),
              "ignored",
              JSON.stringify(overrides),
            );
            assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
          }
          assert.equal(
            yield* gate.observeTurn(turn("message:3", "Thanks, now fix the typo")),
            "plain",
          );
          yield* gate.requireNoRequest(threadId);
        }),
      ),
  );

  it.effect("keeps a decision when the same message starts its run again", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* gate.approve(decision("review:1"));
        // A retried or recovered attempt of the run reads the same message again.
        yield* gate.observeTurn(turn("message:1", "Plan this as a workflow"));
        assert.equal(yield* guarded(gate, digestA), keyOf(digestA));
      }),
    ),
  );

  it.effect("drops every review and approval when a new request arrives", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* gate.approve(decision("review:1"));
        yield* gate.observeTurn(turn("message:2", "Run another workflow"));
        assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
        assert.equal(yield* reasonOf(gate.approve(decision("review:1"))), "review-not-found");
      }),
    ),
  );
});

describe("deciding a review", () => {
  it.effect("approves only a ready review of this thread, environment, review id and digest", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* review(gate, "review:blocked", digestB, { ready: false });
        yield* review(gate, "review:digestless", null);
        const refused = (input: Parameters<typeof gate.approve>[0]) =>
          reasonOf(gate.approve(input));
        assert.equal(
          yield* refused({ ...decision("review:1"), digest: digestB }),
          "review-not-found",
        );
        assert.equal(yield* refused(decision("review:unknown")), "review-not-found");
        assert.equal(
          yield* refused({
            ...decision("review:1"),
            environmentId: EnvironmentId.make("environment:other"),
          }),
          "environment-mismatch",
        );
        assert.equal(
          yield* refused({ ...decision("review:1"), threadId: otherThreadId }),
          "no-pending-request",
        );
        assert.equal(yield* refused(decision("review:blocked", digestB)), "review-blocked");
        // Nothing above approved anything.
        assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
        assert.equal(yield* reasonOf(guarded(gate, digestB)), "needs-approval");
      }),
    ),
  );

  it.effect("says nothing is waiting when no request armed the gate", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* gate.observeTurn(turn("message:1", "Fix the typo"));
        assert.deepEqual(yield* review(gate, "review:1", digestA), { approvalRequired: false });
        assert.equal(yield* reasonOf(gate.approve(decision("review:1"))), "no-pending-request");
        // Without a request the start is the agent's own call, with the agent's own key.
        assert.equal(yield* guarded(gate, digestA), "open");
        yield* gate.requireNoRequest(threadId);
      }),
    ),
  );

  it.effect("starts only the approved digest while armed, and a start that succeeds settles", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        assert.deepEqual(yield* review(gate, "review:2", digestB), { approvalRequired: true });
        const first = yield* gate.approve(decision("review:1"));
        // A second click, or a retry, is the same decision.
        assert.deepEqual(yield* gate.approve(decision("review:1")), first);
        // Approving does not open anything else: another digest and the script path stay closed.
        assert.equal(yield* reasonOf(guarded(gate, digestB)), "needs-approval");
        assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        // The approved digest starts under the approval's own key.
        const key = keyOf(digestA);
        assert.equal(yield* guarded(gate, digestA), key);
        // That success settled the request: starts are as on a thread nobody asked about.
        assert.equal(yield* guarded(gate, digestB), "open");
        yield* gate.requireNoRequest(threadId);
        assert.deepEqual(yield* review(gate, "review:3", digestB), { approvalRequired: false });
        // A retry of the approved start still finds its key; approving again changes nothing.
        assert.equal(yield* guarded(gate, digestA), key);
        assert.deepEqual(yield* gate.approve(decision("review:1")), first);
        // A review that was not approved cannot be approved once the request is settled.
        assert.equal(
          yield* reasonOf(gate.approve(decision("review:2", digestB))),
          "no-pending-request",
        );
        assert.equal(yield* reasonOf(gate.dismiss(decision("review:1"))), "no-pending-request");
      }),
    ),
  );

  it.effect("records concurrent approvals as one decision with one start key", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* review(gate, "review:2", digestA);
        const decided = yield* Effect.all(
          [gate.approve(decision("review:1")), gate.approve(decision("review:2"))],
          { concurrency: 2 },
        );
        // A second review of the same digest joins the first decision.
        assert.deepEqual(decided[0], decided[1]);
        assert.equal(decided[0].decisionId, "review:1");
        const started = yield* Effect.all(
          [guarded<never>(gate, digestA), guarded<never>(gate, digestA)],
          {
            concurrency: 2,
          },
        );
        assert.deepEqual(started, [keyOf(digestA), keyOf(digestA)]);
      }),
    ),
  );

  it.effect("keeps the approval, and its one key, when a start fails", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* gate.approve(decision("review:1"));
        const key = keyOf(digestA);
        const seen: Array<string | undefined> = [];
        const failing = (startKey: string | undefined) => {
          seen.push(startKey);
          return Effect.fail("target no longer served");
        };
        assert.equal(
          yield* guarded(gate, digestA, failing).pipe(Effect.flip),
          "target no longer served",
        );
        // The failure settled nothing: everything else is still refused ...
        assert.equal(yield* reasonOf(guarded(gate, digestB)), "needs-approval");
        assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        // ... and the retry is the same start.
        assert.equal(
          yield* guarded(gate, digestA, failing).pipe(Effect.flip),
          "target no longer served",
        );
        assert.equal(yield* guarded(gate, digestA), key);
        assert.deepEqual(seen, [key, key]);
      }),
    ),
  );

  it.effect("keeps the approval, and its one key, when a start is interrupted", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* gate.approve(decision("review:1"));
        const entered = yield* Deferred.make<string | undefined>();
        const first = yield* guarded(gate, digestA, (key) =>
          Deferred.succeed(entered, key).pipe(Effect.andThen(Effect.never)),
        ).pipe(Effect.forkChild);
        assert.equal(yield* Deferred.await(entered), keyOf(digestA));
        yield* Fiber.interrupt(first);
        assert.equal(yield* reasonOf(guarded(gate, digestB)), "needs-approval");
        assert.equal(yield* guarded(gate, digestA), keyOf(digestA));
      }),
    ),
  );

  it.effect("dismisses the request at once: starts are open, nothing more can be approved", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* review(gate, "review:blocked", null);
        yield* gate.approve(decision("review:1"));
        // A review nothing can approve can still be dismissed, by its id alone.
        const dismissed = yield* gate.dismiss({ ...decision("review:blocked"), digest: null });
        // A repeated Dismiss, from any review of the request, is the same Dismiss.
        assert.deepEqual(yield* gate.dismiss(decision("review:1")), dismissed);
        assert.equal(dismissed.decisionId, "review:blocked");
        // The gate no longer refuses; only the digest the person had approved keeps its key.
        assert.equal(yield* guarded(gate, digestB), "open");
        assert.equal(yield* guarded(gate, digestA), keyOf(digestA));
        yield* gate.requireNoRequest(threadId);
        assert.equal(yield* reasonOf(gate.approve(decision("review:1"))), "no-pending-request");
        // A review made after Dismiss waits for nothing, and there is nothing to approve in it.
        assert.deepEqual(yield* review(gate, "review:2", digestB), { approvalRequired: false });
        assert.equal(
          yield* reasonOf(gate.approve(decision("review:2", digestB))),
          "review-not-found",
        );
        // The same message again does not bring the request back; a new one does.
        yield* gate.observeTurn(turn("message:1", "Plan this as a workflow"));
        yield* gate.requireNoRequest(threadId);
        yield* gate.observeTurn(turn("message:2", "Run another workflow"));
        assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
      }),
    ),
  );

  it.effect(
    "lets a start that was running when the person dismissed finish, and keeps its key",
    () =>
      withGate((gate) =>
        Effect.gen(function* () {
          yield* armedWithReview(gate);
          yield* gate.approve(decision("review:1"));
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const running = yield* guarded(gate, digestA, (key) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(key ?? "open"),
            ),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          yield* gate.dismiss(decision("review:1"));
          yield* Deferred.succeed(release, undefined);
          assert.equal(yield* Fiber.join(running), keyOf(digestA));
          // A retry after the dismissal and the finished start is still the same start.
          assert.equal(yield* guarded(gate, digestA), keyOf(digestA));
        }),
      ),
  );

  it.effect("does not let a decision on a stale request reach a newer one", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* gate.observeTurn(turn("message:2", "Another workflow, please"));
        yield* review(gate, "review:2", digestB);
        assert.equal(yield* reasonOf(gate.dismiss(decision("review:1"))), "review-not-found");
        yield* gate.approve({ ...decision("review:2", digestB) });
        assert.equal(yield* guarded(gate, digestB), keyOf(digestB, "message:2"));
      }),
    ),
  );
});

describe("a review that is still running", () => {
  it.effect("is recorded when its request is still armed", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* gate.observeTurn(turn("message:1", "Plan this as a workflow"));
        assert.deepEqual(yield* reviewAcross(gate, "review:1", digestA, Effect.void), {
          approvalRequired: true,
        });
        yield* gate.approve(decision("review:1"));
      }),
    ),
  );

  it.effect("is not recorded under a newer request that arrived while it ran", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* gate.observeTurn(turn("message:1", "Plan this as a workflow"));
        const result = yield* reviewAcross(
          gate,
          "review:old",
          digestA,
          gate.observeTurn(turn("message:2", "Plan something else as a workflow")),
        );
        assert.deepEqual(result, { refused: "stale-review" });
        // It cannot be approved under the request that is waiting now.
        assert.equal(yield* reasonOf(gate.approve(decision("review:old"))), "review-not-found");
        assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
      }),
    ),
  );

  it.effect("is not recorded when a trigger armed a thread that was open when it began", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* gate.observeTurn(turn("message:1", "Fix the typo"));
        const result = yield* reviewAcross(
          gate,
          "review:old",
          digestA,
          gate.observeTurn(turn("message:2", "Now plan a workflow")),
        );
        assert.deepEqual(result, { refused: "stale-review" });
        assert.equal(yield* reasonOf(gate.approve(decision("review:old"))), "review-not-found");
      }),
    ),
  );

  it.effect("is not recorded once the request was lifted or settled while it ran", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        assert.deepEqual(
          yield* reviewAcross(
            gate,
            "review:lifted",
            digestA,
            gate.observeTurn(turn("message:2", "Thanks, that is enough")),
          ),
          { refused: "stale-review" },
        );
        yield* gate.observeTurn(turn("message:3", "Plan a workflow again"));
        yield* review(gate, "review:3", digestB);
        assert.deepEqual(
          yield* reviewAcross(
            gate,
            "review:dismissed",
            digestA,
            gate.dismiss({
              ...decision("review:3", digestB),
            }),
          ),
          { refused: "stale-review" },
        );
        yield* gate.observeTurn(turn("message:4", "Plan a workflow once more"));
        yield* review(gate, "review:4", digestA);
        yield* gate.approve(decision("review:4"));
        assert.deepEqual(
          yield* reviewAcross(gate, "review:started", digestB, guarded(gate, digestA)),
          { refused: "stale-review" },
        );
      }),
    ),
  );

  it.effect("answers an open thread's review with no approval needed", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* gate.observeTurn(turn("message:1", "Fix the typo"));
        assert.deepEqual(yield* reviewAcross(gate, "review:1", digestA, Effect.void), {
          approvalRequired: false,
        });
      }),
    ),
  );
});

describe("decision ids", () => {
  it.effect("are the same for every call about one approval or dismissal", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* review(gate, "review:2", digestA);
        yield* review(gate, "review:3", digestB);
        const approved = yield* gate.approve(decision("review:2"));
        assert.deepEqual(yield* gate.approve(decision("review:1")), approved);
        assert.equal(approved.decisionId, "review:2");
        assert.equal(approved.request, "message:1");
        // Another digest is another approval.
        assert.equal((yield* gate.approve(decision("review:3", digestB))).decisionId, "review:3");
        const dismissed = yield* gate.dismiss(decision("review:3", digestB));
        assert.deepEqual(yield* gate.dismiss(decision("review:1")), dismissed);
      }),
    ),
  );

  it.effect("are new for a decision on a review made after a restart", () =>
    Effect.gen(function* () {
      const stored = { runs: runs(1), items: [start(1, "Plan this as a workflow")] };
      const before = yield* withGate(
        (gate) =>
          Effect.gen(function* () {
            yield* review(gate, "review:before", digestA);
            const decided = yield* gate.approve(decision("review:before"));
            return { decided, launch: yield* guarded(gate, digestA) };
          }),
        stored,
      );
      const after = yield* withGate(
        (gate) =>
          Effect.gen(function* () {
            yield* review(gate, "review:after", digestA);
            const decided = yield* gate.approve(decision("review:after"));
            return { decided, launch: yield* guarded(gate, digestA) };
          }),
        stored,
      );
      // The same request and digest, a different decision: a command receipt of the first must
      // not answer the second message.
      assert.equal(before.decided.request, after.decided.request);
      assert.notEqual(before.decided.decisionId, after.decided.decisionId);
      // The launch is the same one, whatever the decision: a workflow the first approval began
      // is the one the second approval's start finds.
      assert.equal(before.launch, keyOf(digestA));
      assert.equal(after.launch, before.launch);
    }),
  );
});

describe("the launch key of an approved digest", () => {
  it.effect("is shared by one thread, request and digest, and by no other", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* armedWithReview(gate);
        yield* review(gate, "review:2", digestB);
        yield* gate.approve(decision("review:1"));
        yield* gate.approve(decision("review:2", digestB));
        const first = yield* guarded(gate, digestA);
        // Another digest of the request.
        assert.equal(yield* guarded(gate, digestB), keyOf(digestB));
        assert.notEqual(first, keyOf(digestB));
        // Another request of the thread.
        yield* gate.observeTurn(turn("message:2", "Run another workflow"));
        yield* review(gate, "review:3", digestA);
        yield* gate.approve(decision("review:3"));
        const next = yield* guarded(gate, digestA);
        assert.equal(next, keyOf(digestA, "message:2"));
        assert.notEqual(next, first);
        // Another thread, even with the same request message id and digest.
        const other = { threadId: otherThreadId };
        yield* gate.observeTurn(turn("message:2", "Run another workflow", other));
        yield* review(gate, "review:4", digestA, { thread: otherThreadId });
        yield* gate.approve({ ...decision("review:4"), ...other });
        const elsewhere = yield* gate.guardGraphStart(
          { threadId: otherThreadId, digest: digestA },
          (key) => Effect.succeed(key ?? "open"),
        );
        assert.equal(elsewhere, keyOf(digestA, "message:2", otherThreadId));
        assert.notEqual(elsewhere, next);
      }),
    ),
  );
});

describe("after a restart", () => {
  it.effect("arms from the latest person-typed message and wants a fresh review", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          // The review made before the restart is gone, so nothing can be approved yet.
          assert.equal(yield* reasonOf(gate.approve(decision("review:old"))), "review-not-found");
          assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
          assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
          assert.deepEqual(yield* review(gate, "review:new", digestA), { approvalRequired: true });
          yield* gate.approve(decision("review:new"));
          assert.equal(yield* guarded(gate, digestA), keyOf(digestA));
        }),
      { runs: runs(1), items: [start(1, "Plan this as a workflow")] },
    ),
  );

  it.effect("arms again a request that was dismissed or already started before it", () =>
    Effect.gen(function* () {
      const stored = { runs: runs(1), items: [start(1, "Plan this as a workflow")] };
      for (const settle of ["dismiss", "start"] as const) {
        yield* withGate(
          (gate) =>
            Effect.gen(function* () {
              yield* review(gate, "review:before", digestA);
              if (settle === "dismiss") yield* gate.dismiss(decision("review:before"));
              else {
                yield* gate.approve(decision("review:before"));
                yield* guarded(gate, digestA);
              }
              yield* gate.requireNoRequest(threadId);
            }),
          stored,
        );
        yield* withGate(
          (gate) =>
            Effect.gen(function* () {
              assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
              assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
            }),
          stored,
        );
      }
    }),
  );

  it.effect("stays open when the latest person-typed message is plain", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          yield* gate.requireNoRequest(threadId);
          assert.equal(yield* guarded(gate, digestA), "open");
        }),
      {
        // Listed out of order: the later run decides.
        runs: runs(2, 1),
        items: [start(2, "Thanks, that is enough"), start(1, "Plan this as a workflow")],
      },
    ),
  );

  it.effect("skips what is not a person's start: steers, agent text, canned replies, resumes", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        }),
      {
        runs: [
          ...runs(1, 2, 3, 4, 5, 6),
          { id: RunId.make("run:7"), ordinal: 7, restartContinuationOfRunId: "run:1" },
        ],
        items: [
          start(1, "Plan this as a workflow"),
          start(2, "Never mind", { inputIntent: "steer" }),
          start(3, "Never mind", { inputIntent: "promoted_queued_to_steer" }),
          start(4, "Never mind", { createdBy: "agent", creationSource: "mcp" }),
          // The canned approval message the server sent for the person.
          start(5, "I approved it", { createdBy: "user", creationSource: "server" }),
          start(6, "Never mind", { scheduledTaskId: "task-1" }),
          start(7, "Never mind"),
        ],
      },
    ),
  );

  it.effect("never arms a delegated thread, whoever asked", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          yield* gate.requireNoRequest(threadId);
          assert.equal(yield* guarded(gate, digestA), "open");
        }),
      {
        relationshipToParent: "subagent",
        runs: runs(1),
        items: [start(1, "Plan this as a workflow")],
      },
    ),
  );

  it.effect("follows the trigger settings the person has now", () =>
    Effect.gen(function* () {
      const stored = { runs: runs(1), items: [start(1, "Please fan out the audit")] };
      yield* withGate((gate) => gate.requireNoRequest(threadId), stored);
      yield* withGate(
        (gate) =>
          gate.requireNoRequest(threadId).pipe(
            Effect.flip,
            Effect.map((error) => assert.equal(error.reason, "script-not-allowed")),
          ),
        stored,
        { workflowTriggers: { enabled: true, extras: ["fan out"] } },
      );
    }),
  );

  it.effect("refuses, rather than guess, when the stored messages cannot be read", () =>
    Effect.gen(function* () {
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "unverified");
      assert.equal(yield* reasonOf(guarded(gate, digestA)), "unverified");
      assert.equal(yield* reasonOf(gate.beginReview(threadId)), "unverified");
      assert.equal(yield* reasonOf(gate.approve(decision("review:1"))), "unavailable");
    }).pipe(
      Effect.provide(
        makeLayer((id) =>
          Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId: id })),
        ),
      ),
    ),
  );

  it.effect("lets a message turn start sees while it reads win over what it read", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const calls = yield* Ref.make(0);
      const stored: Stored = { runs: runs(1), items: [start(1, "Plan this as a workflow")] };
      const layer = makeLayer(() =>
        Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.tap((n) =>
            n === 1
              ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          ),
          Effect.as(stored),
        ),
      );
      yield* Effect.gen(function* () {
        const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
        const check = yield* gate.requireNoRequest(threadId).pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(reading);
        // The person's newer message reaches turn start while the stored ones are being read.
        yield* gate.observeTurn(turn("message:2", "Thanks, that is enough"));
        yield* Deferred.succeed(release, undefined);
        assert.isTrue((yield* Fiber.join(check))._tag === "Success");
        yield* gate.requireNoRequest(threadId);
      }).pipe(Effect.provide(layer));
    }),
  );
});

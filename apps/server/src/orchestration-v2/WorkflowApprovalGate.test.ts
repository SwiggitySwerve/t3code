import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2WorkflowApprovalError,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { workflowRequestOf } from "@t3tools/provider-core/server/workflowTrigger";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as WorkflowApprovalGate from "./WorkflowApprovalGate.ts";

const environmentId = EnvironmentId.make("environment:gate");
const threadId = ThreadId.make("thread:gate");
const otherThreadId = ThreadId.make("thread:gate-other");
const digestA = `sha256:${"a".repeat(64)}`;
const projectId = ProjectId.make("project:gate");
const triggers = { extras: [] };

const person = {
  workflowStart: "keyword",
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
  sessionWorkflows: boolean | (() => boolean) = true,
  sessionAvailable = () => true,
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
                      projectId,
                      lineage: { relationshipToParent: stored.relationshipToParent ?? null },
                    },
                    runs: stored.runs,
                    turnItems: stored.items,
                  }) as never,
              ),
            ),
        }),
        ServerSettings.layerTest({ workflows: true, ...settings }),
        Layer.mock(McpProviderSessions.McpProviderSessions)({
          read: () =>
            Effect.sync(() =>
              sessionAvailable()
                ? ({
                    capabilities: new Set(
                      (
                        typeof sessionWorkflows === "function"
                          ? sessionWorkflows()
                          : sessionWorkflows
                      )
                        ? ["workflows"]
                        : [],
                    ),
                  } as never)
                : undefined,
            ),
        }),
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

const reasonOf = <A, X>(effect: Effect.Effect<X, { readonly reason: A }>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );
const guarded = (gate: Gate, digest: string) =>
  gate.guardGraphStart({ threadId, digest }, () => Effect.succeed("open"));

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

  it.effect("arms for a steer that asks for a workflow, and a plain steer leaves it armed", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        const steer = (messageId: string, typedText: string) =>
          gate.observeTurn(turn(messageId, typedText, { steering: true }));
        assert.equal(yield* steer("message:1", "Actually, run it as a workflow"), "requested");
        assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        assert.equal(yield* steer("message:2", "Also check the tests"), "plain");
        assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        // A new message from the person, not a steer, still lifts it.
        assert.equal(
          yield* gate.observeTurn(turn("message:3", "Thanks, now fix the typo")),
          "plain",
        );
        yield* gate.requireNoRequest(threadId);
      }),
    ),
  );

  it.effect(
    "gives a steer the plan-first note only when a person's steer asks for a workflow",
    () =>
      withGate((gate) =>
        Effect.gen(function* () {
          const steer = (messageId: string, typedText: string, overrides = {}) =>
            gate.observeSteer({
              threadId,
              messageId: MessageId.make(messageId),
              typedText,
              createdBy: "user",
              creationSource: "web",
              ...overrides,
            });
          assert.isUndefined(yield* steer("message:1", "Also check the tests"));
          yield* gate.requireNoRequest(threadId);
          for (const overrides of [
            { createdBy: "agent", creationSource: "mcp" },
            { scheduledTaskId: "task-1" },
            { senderThreadId: otherThreadId },
          ]) {
            assert.isUndefined(
              yield* steer("message:2", "Run it as a workflow", overrides),
              JSON.stringify(overrides),
            );
            yield* gate.requireNoRequest(threadId);
          }
          const note = yield* steer("message:3", "Run it as a workflow");
          assert.isTrue(note?.startsWith("<t3-workflow>"));
          assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        }),
      ),
  );

  it.effect("gives a steer in a delegated thread no note and arms nothing", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          const note = yield* gate.observeSteer({
            threadId,
            messageId: MessageId.make("message:1"),
            typedText: "Run it as a workflow",
            createdBy: "user",
            creationSource: "web",
          });
          assert.isUndefined(note);
          yield* gate.requireNoRequest(threadId);
        }),
      { relationshipToParent: "subagent", runs: [], items: [] },
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

describe("after a restart", () => {
  it.effect("fails closed while the session capability is unknown and rescans once issued", () => {
    let sessionAvailable = false;
    return Effect.gen(function* () {
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "unverified");
      assert.equal(yield* reasonOf(guarded(gate, digestA)), "unverified");
      sessionAvailable = true;
      assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
      assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
    }).pipe(
      Effect.provide(
        makeLayer(
          () => Effect.succeed({ runs: runs(1), items: [start(1, "Plan this as a workflow")] }),
          {},
          true,
          () => sessionAvailable,
        ),
      ),
    );
  });

  it.effect("rescans for a session with workflows after one without them read the thread", () => {
    let sessionWorkflows = false;
    return Effect.gen(function* () {
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      // Without workflows the request reads as ignored; that must not be remembered.
      yield* gate.requireNoRequest(threadId);
      sessionWorkflows = true;
      assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
      assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
    }).pipe(
      Effect.provide(
        makeLayer(
          () => Effect.succeed({ runs: runs(1), items: [start(1, "Plan this as a workflow")] }),
          {},
          () => sessionWorkflows,
        ),
      ),
    );
  });

  it.effect.each(["awaiting", "approved", "started", "dismissed"] as const)(
    "restores a stored review's %s state after restart",
    (decision) =>
      withGate(
        (gate) =>
          Effect.gen(function* () {
            assert.equal(yield* gate.awaitsDecision(threadId), decision === "awaiting");
            const result = yield* guarded(gate, digestA).pipe(
              Effect.catchTags({
                WorkflowApprovalRequiredError: (error) => Effect.succeed(error.reason),
              }),
            );
            assert.equal(
              result,
              decision === "started" || decision === "dismissed" ? "open" : "needs-approval",
            );
          }),
        {
          runs: runs(1),
          items: [
            start(1, "Plan this as a workflow"),
            {
              type: "workflow_review",
              approvalRequest: { environmentId, messageId: MessageId.make("message:1") },
              reviewId: "review:stored",
              digest: digestA,
              ready: true,
              approvalRequired: true,
              decision,
            },
          ],
        },
      ),
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

  it.effect("re-arms from a person's steer that asked for a workflow", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
          assert.equal(yield* reasonOf(guarded(gate, digestA)), "needs-approval");
        }),
      {
        runs: runs(1),
        items: [
          start(1, "Thanks, that is enough"),
          // Steers share the run of the message they joined; the later item decides.
          {
            ...start(2, "Actually, run it as a workflow", { inputIntent: "steer" }),
            runId: "run:1",
          },
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
        { workflowTriggers: { extras: ["fan out"] } },
      );
    }),
  );

  it.effect.each(["keyword", "always", "off"] as const)(
    "re-arms after a restart as turn start reads the message under workflowStart %s",
    (workflowStart) =>
      Effect.gen(function* () {
        const typedText = "Plan this as a workflow";
        // The answer turn start gives for this message under the same setting.
        const atTurnStart = workflowRequestOf({ ...person, workflowStart, typedText });
        assert.equal(atTurnStart, workflowStart === "off" ? "plain" : "requested");
        const stored = { runs: runs(1), items: [start(1, typedText)] };
        for (const settings of [
          { workflowStart },
          // A project override decides for the gate as it does at turn start.
          {
            workflowStart: workflowStart === "off" ? "keyword" : "off",
            projectSettingsOverrides: { [projectId]: { workflowStart } },
          },
        ] as const) {
          yield* withGate(
            (gate) =>
              Effect.gen(function* () {
                const reason = yield* gate.requireNoRequest(threadId).pipe(
                  Effect.as("open"),
                  Effect.catchTags({
                    WorkflowApprovalRequiredError: (error) => Effect.succeed(error.reason),
                  }),
                );
                assert.equal(
                  reason,
                  atTurnStart === "requested" ? "script-not-allowed" : "open",
                  JSON.stringify(settings),
                );
              }),
            stored,
            settings,
          );
        }
      }),
  );

  it.effect("gives a steer no note and arms nothing while workflowStart is off", () =>
    withGate(
      (gate) =>
        Effect.gen(function* () {
          const note = yield* gate.observeSteer({
            threadId,
            messageId: MessageId.make("message:1"),
            typedText: "Run it as a workflow",
            createdBy: "user",
            creationSource: "web",
          });
          assert.isUndefined(note);
          yield* gate.requireNoRequest(threadId);
        }),
      NOTHING_STORED,
      { projectSettingsOverrides: { [projectId]: { workflowStart: "off" } } },
    ),
  );

  it.effect("lets a person's message under off lift a request that waits", () =>
    withGate((gate) =>
      Effect.gen(function* () {
        yield* gate.observeTurn(turn("message:1", "Plan this as a workflow"));
        assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "script-not-allowed");
        assert.equal(
          yield* gate.observeTurn(
            turn("message:2", "Plan this as a workflow", { workflowStart: "off" }),
          ),
          "plain",
        );
        yield* gate.requireNoRequest(threadId);
      }),
    ),
  );

  it.effect("refuses, rather than guess, when the stored messages cannot be read", () =>
    Effect.gen(function* () {
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      assert.equal(yield* reasonOf(gate.requireNoRequest(threadId)), "unverified");
      assert.equal(yield* reasonOf(guarded(gate, digestA)), "unverified");
      assert.equal(yield* reasonOf(gate.beginReview(threadId)), "unverified");
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

it.effect.each([false, true])(
  "steer notes and approvals follow the issued workflow capability (issued=%s)",
  (issued) =>
    Effect.gen(function* () {
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      const note = yield* gate.observeSteer({
        threadId,
        messageId: MessageId.make("message:steer-capability"),
        typedText: "Use a workflow",
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal(note?.startsWith("<t3-workflow>") === true, issued);
      const reviewed = yield* review(gate, "review:capability", digestA);
      assert.equal(reviewed.approvalRequired, issued);
    }).pipe(
      Effect.provide(
        makeLayer(() => Effect.succeed(NOTHING_STORED), { workflows: !issued }, issued),
      ),
    ),
);

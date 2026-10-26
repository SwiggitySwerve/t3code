import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  MessageId,
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkflowApprovalGate from "./WorkflowApprovalGate.ts";
import { layerOpen } from "./WorkflowApprovalGate.testkit.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeProjection(input: {
  readonly now: DateTime.Utc;
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId: RunAttemptId;
}): OrchestrationV2ThreadProjection {
  const runId = RunId.make("run:restart-session");
  const nodeId = NodeId.make("node:restart-session");
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make("project:restart-session"),
      title: "Restart session",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      activeProviderThreadId: input.providerThread.id,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: input.threadId,
      },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [
      {
        id: input.attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId,
        providerThreadId: input.providerThread.id,
        providerTurnId: input.providerTurnId,
        reason: "initial",
        status: "superseded",
        startedAt: input.now,
        completedAt: input.now,
      },
    ],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [input.providerThread],
    providerTurns: [
      {
        id: input.providerTurnId,
        providerThreadId: input.providerThread.id,
        nodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: {
          driver,
          nativeId: "native-turn:restart-session",
          strength: "strong",
        },
        ordinal: 1,
        status: "running",
        startedAt: input.now,
        completedAt: null,
      },
    ],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: input.now,
  };
}

it.effect(
  "interrupts the historical session only for the exact committed restart replacement",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:restart-session");
      const oldSessionId = ProviderSessionId.make("provider-session:restart-session:old");
      const replacementSessionId = ProviderSessionId.make(
        "provider-session:restart-session:replacement",
      );
      const unrelatedSessionId = ProviderSessionId.make(
        "provider-session:restart-session:unrelated",
      );
      const providerThreadId = ProviderThreadId.make("provider-thread:restart-session");
      const providerTurnId = ProviderTurnId.make("provider-turn:restart-session");
      const attemptId = RunAttemptId.make("run-attempt:restart-session");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: replacementSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: {
          driver,
          nativeId: "native-thread:restart-session",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "not_loaded",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const projection = yield* Ref.make(
        makeProjection({ now, threadId, providerThread, providerTurnId, attemptId }),
      );
      const interruptedThread = yield* Ref.make<OrchestrationV2ProviderThread | null>(null);
      const providerSession = {
        id: oldSessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: providerInstanceId,
        driver,
        providerSessionId: oldSessionId,
        providerSession,
        events: Stream.empty,
        ensureThread: () => Effect.die("unused ensureThread"),
        resumeThread: () => Effect.die("unused resumeThread"),
        startTurn: () => Effect.die("unused startTurn"),
        steerTurn: () => Effect.die("unused steerTurn"),
        interruptTurn: ({ providerThread: target }) =>
          Effect.all(
            [
              Ref.set(interruptedThread, target),
              Ref.update(projection, (current) => ({
                ...current,
                providerTurns: current.providerTurns.map((turn) =>
                  turn.id === providerTurnId
                    ? { ...turn, status: "interrupted" as const, completedAt: now }
                    : turn,
                ),
              })),
            ],
            { discard: true },
          ),
        respondToRuntimeRequest: () => Effect.die("unused respondToRuntimeRequest"),
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
      const layerProjection = Layer.succeed(
        ProjectionStore.ProjectionStoreV2,
        ProjectionStore.ProjectionStoreV2.of({
          apply: () => Effect.void,
          getLimitRecoveryCandidates: () => Effect.die("unused getLimitRecoveryCandidates"),
          getShellSnapshot: () => Effect.die("unused getShellSnapshot"),
          listActiveSubagentThreadIds: () => Effect.die("unused listActiveSubagentThreadIds"),
          listOlderSettledThreads: () => Effect.die("unused listOlderSettledThreads"),
          readShellSnapshot: () => Effect.die("unused readShellSnapshot"),
          getThreadShell: () => Effect.die("unused getThreadShell"),
          findGuestShareThreadId: () => Effect.die("unused findGuestShareThreadId"),
          getThread: () => Ref.get(projection).pipe(Effect.map((state) => state.thread)),
          getSettlementCandidates: () => Effect.die("unused getSettlementCandidates"),
          getThreadsWithPullRequests: () => Effect.die("unused getThreadsWithPullRequests"),
          getThreadWorktreePaths: () => Effect.die("unused getThreadWorktreePaths"),
          getThreadProjection: () => Effect.die("control effects must not load transcript"),
          getTurnStartContext: () => Effect.die("unused"),
          getTurnStartHistory: () => Effect.die("unused"),
          getRuntimeRecoveryProjection: () => Effect.die("unused getRuntimeRecoveryProjection"),
          getPlan: () => Effect.die("unused"),
          hasUnpairedRunInterruptRequest: () => Effect.die("unused interrupt read"),
          getThreadAttachmentIds: () => Effect.die("Unused attachment lookup"),
          searchThread: () => Effect.die("unused"),
          searchThreadStream: () => Stream.empty,
          getThreadHistoryPage: () => Effect.die("unused"),
          getTimelinePage: () => Effect.die("Unused timeline read"),
          getMessageCount: () => Effect.die("unused message count"),
          getNextTurnItemOrdinal: () => Effect.die("unused ordinal read"),
          getTurnItem: () => Effect.die("unused turn item read"),
          getThreadRecords: () => Effect.die("unused record read"),
          getRuntimeRequest: () => Effect.die("unused getRuntimeRequest"),
          getRunningTurnContext: () => Effect.die("unused getRunningTurnContext"),
          getThreadProviderContext: () => Effect.die("unused getThreadProviderContext"),
          getRuntimeResponseContext: () => Effect.die("unused getRuntimeResponseContext"),
          getPendingNativeUserInputs: () => Effect.die("unused getPendingNativeUserInputs"),
          getProviderControlContext: (_threadId, target) =>
            Ref.get(projection).pipe(
              Effect.map((current) => ({
                providerThread: current.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                ),
                providerTurn: current.providerTurns.find(
                  (turn) => turn.id === target.providerTurnId,
                ),
                attempt: current.attempts.find((attempt) => attempt.id === target.attemptId),
                message: undefined,
                run: undefined,
              })),
            ),
          getCheckpointContext: () => Effect.die("not used"),
          getCheckpointRollbackContext: () => Effect.die("unused rollback context"),
          getCheckpointCaptureContext: () => Effect.die("not used"),
          getRunMessage: () => Effect.die("not used"),
          isNodeStored: () => Effect.die("not used"),
          canStartQueuedRun: () => Effect.die("not used"),
          getRecoveryThreadIds: () => Effect.die("unused getRecoveryThreadIds"),
          getDelegatedRunAdmission: () => Effect.die("unused getDelegatedRunAdmission"),
          getUnreadableThreadIds: () => Effect.die("unused getUnreadableThreadIds"),
          getThreadSnapshot: () => Effect.die("unused getThreadSnapshot"),
          getThreadSnapshotWindow: () => Effect.die("unused getThreadSnapshotWindow"),
        }),
      );
      const layerSessionManager = Layer.succeed(
        ProviderSessionManager.ProviderSessionManagerV2,
        ProviderSessionManager.ProviderSessionManagerV2.of({
          shutdown: Effect.void,
          open: () => Effect.die("unused open"),
          get: (providerSessionId) =>
            Effect.succeed(
              providerSessionId === oldSessionId ? Option.some(runtime) : Option.none(),
            ),
          isLive: (providerSessionId) => Effect.succeed(providerSessionId === oldSessionId),
          close: () => Effect.void,
          closeInstance: () => Effect.void,
          release: () => Effect.void,
          detach: () => Effect.void,
        }),
      );
      const layerControl = ProviderTurnControlService.layer.pipe(
        Layer.provide(Layer.mergeAll(layerProjection, layerSessionManager, layerOpen)),
      );

      const [ordinaryInterrupt, unrelatedRestart] = yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        const ordinary = yield* Effect.exit(
          control.interrupt({
            threadId,
            providerSessionId: oldSessionId,
            providerThreadId,
            providerTurnId,
          }),
        );
        const unrelated = yield* Effect.exit(
          control.interruptAndAwaitTerminal({
            threadId,
            providerSessionId: oldSessionId,
            replacementProviderSessionId: unrelatedSessionId,
            providerThreadId,
            providerTurnId,
            interruptedAttemptId: attemptId,
          }),
        );
        return [ordinary, unrelated] as const;
      }).pipe(Effect.provide(layerControl));

      assert.isTrue(Exit.isFailure(ordinaryInterrupt));
      assert.isTrue(Exit.isFailure(unrelatedRestart));
      assert.isNull(yield* Ref.get(interruptedThread));

      yield* Effect.gen(function* () {
        const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
        yield* control.interruptAndAwaitTerminal({
          threadId,
          providerSessionId: oldSessionId,
          replacementProviderSessionId: replacementSessionId,
          providerThreadId,
          providerTurnId,
          interruptedAttemptId: attemptId,
        });
      }).pipe(Effect.provide(layerControl));

      const interrupted = yield* Ref.get(interruptedThread);
      assert.isNotNull(interrupted);
      assert.equal(interrupted?.providerSessionId, oldSessionId);
      assert.equal(interrupted?.id, providerThreadId);
      assert.equal(interrupted?.nativeThreadRef?.nativeId, "native-thread:restart-session");
    }),
);

/**
 * A running turn that receives one steering message from `author`, with the real approval gate.
 * Answers the text the provider received and what the gate then says to a graph_start.
 */
const steerOnce = (input: {
  readonly key: string;
  readonly text: string;
  readonly author?: {
    readonly createdBy: "user" | "agent";
    readonly creationSource: "web" | "mcp";
  };
  readonly armedBefore?: boolean;
}) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`thread:${input.key}`);
    const sessionId = ProviderSessionId.make(`provider-session:${input.key}`);
    const providerThreadId = ProviderThreadId.make(`provider-thread:${input.key}`);
    const providerTurnId = ProviderTurnId.make(`provider-turn:${input.key}`);
    const attemptId = RunAttemptId.make(`run-attempt:${input.key}`);
    const runId = RunId.make(`run:${input.key}`);
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: sessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: `native-thread:${input.key}`, strength: "strong" },
      nativeConversationHeadRef: null,
      status: "not_loaded",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    };
    const projection = makeProjection({ now, threadId, providerThread, providerTurnId, attemptId });
    const message = (id: string, text: string, author: NonNullable<typeof input.author>) => ({
      ...author,
      id: MessageId.make(id),
      threadId,
      runId,
      nodeId: NodeId.make(`node:${input.key}`),
      role: "user" as const,
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
    const person = { createdBy: "user", creationSource: "web" } as const;
    const current = yield* Ref.make(message("message:armed", "Run it as a workflow", person));
    const delivered = yield* Ref.make<ReadonlyArray<string>>([]);
    const runtime = {
      instanceId: providerInstanceId,
      driver,
      providerSessionId: sessionId,
      providerSession: {
        id: sessionId,
        driver,
        providerInstanceId,
        status: "running" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
      events: Stream.empty,
      steerTurn: ({ message: steered }: { readonly message: { readonly text: string } }) =>
        Ref.update(delivered, (texts) => [...texts, steered.text]),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const layerProjection = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () => Effect.succeed(projection.thread),
      getThreadRecords: () =>
        Effect.succeed({ thread: projection.thread, runs: [], turnItems: [] } as never),
      getProviderControlContext: () =>
        Ref.get(current).pipe(
          Effect.map(
            (steering) =>
              ({
                providerThread,
                providerTurn: projection.providerTurns[0],
                attempt: undefined,
                message: steering,
                run: { id: runId },
              }) as never,
          ),
        ),
    });
    const layerSessions = Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () => Effect.succeedSome(runtime),
    });
    const layerGate = WorkflowApprovalGate.layer.pipe(
      Layer.provide(Layer.merge(layerProjection, ServerSettings.layerTest({}))),
    );
    const layerControl = ProviderTurnControlService.layer.pipe(
      Layer.provide(Layer.mergeAll(layerProjection, layerSessions, layerGate)),
      Layer.provideMerge(layerGate),
    );
    return yield* Effect.gen(function* () {
      const control = yield* ProviderTurnControlService.ProviderTurnControlServiceV2;
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      if (input.armedBefore === true) {
        yield* gate.observeTurn({
          workflowTriggers: { enabled: true, extras: [] },
          typedText: "Run it as a workflow",
          threadId,
          messageId: MessageId.make("message:armed"),
          delegatedThread: false,
          resumesEarlierTurn: false,
          ...person,
        });
      }
      yield* Ref.set(current, message("message:steer", input.text, input.author ?? person));
      yield* control.steer({
        threadId,
        providerSessionId: sessionId,
        providerThreadId,
        providerTurnId,
        messageId: MessageId.make("message:steer"),
      });
      const start = yield* Effect.exit(
        gate.guardGraphStart({ threadId, digest: `sha256:${"a".repeat(64)}` }, () =>
          Effect.succeed("started"),
        ),
      );
      return {
        delivered: yield* Ref.get(delivered),
        start: Exit.isSuccess(start) ? "started" : "refused",
      };
    }).pipe(Effect.provide(layerControl));
  });

it.effect("a steer that asks for a workflow plans first and waits for approval", () =>
  Effect.gen(function* () {
    const steered = yield* steerOnce({ key: "steer-request", text: "Run it as a workflow" });
    assert.equal(steered.start, "refused", "no workflow starts before the person approves");
    assert.equal(steered.delivered.length, 1);
    assert.isTrue(steered.delivered[0]?.startsWith("Run it as a workflow\n\n<t3-workflow>"));
    assert.include(steered.delivered[0], "graph_review");
  }),
);

it.effect("a steer that does not ask for a workflow arrives unchanged and arms nothing", () =>
  Effect.gen(function* () {
    const plain = yield* steerOnce({ key: "steer-plain", text: "Also check the tests" });
    assert.deepEqual(plain.delivered, ["Also check the tests"]);
    assert.equal(plain.start, "started");
    // Only a person's words count: an agent's steer naming a workflow neither plans nor arms.
    const agent = yield* steerOnce({
      key: "steer-agent",
      text: "Run it as a workflow",
      author: { createdBy: "agent", creationSource: "mcp" },
    });
    assert.deepEqual(agent.delivered, ["Run it as a workflow"]);
    assert.equal(agent.start, "started");
  }),
);

it.effect("a plain steer does not lift a workflow request that waits for approval", () =>
  Effect.gen(function* () {
    const steered = yield* steerOnce({
      key: "steer-keeps-request",
      text: "Also check the tests",
      armedBefore: true,
    });
    assert.deepEqual(steered.delivered, ["Also check the tests"]);
    assert.equal(steered.start, "refused");
  }),
);

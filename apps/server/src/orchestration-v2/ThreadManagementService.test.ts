import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("waitForThread follows a restart continuation instead of the cut run", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-restart");
    const threadId = ThreadId.make("thread:thread-management:wait-restart");
    const runId = RunId.make("run:thread-management:wait-restart");
    const continuationId = RunId.make("run:thread-management:wait-restart:2");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let runs: Array<{
      id: RunId;
      status: OrchestrationV2Run["status"];
      restartContinuationOfRunId?: RunId;
    }> = [{ id: runId, status: "cancelled" }];
    let pending = true;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: (run) => Effect.succeed(pending && run.id === runId),
          awaitRestartContinuation: () => Effect.never,
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(
              () =>
                ({
                  thread: { id: threadId, projectId, deletedAt: null },
                  runs,
                }) as unknown as OrchestrationV2ThreadProjection,
            ),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    const continuation = { id: continuationId, restartContinuationOfRunId: runId };
    runs = [...runs, { ...continuation, status: "running" }];
    pending = false;
    yield* Queue.offer(
      events,
      stored(1, { type: "run.updated", payload: { ...continuation, status: "running" } }),
    );
    runs = [runs[0]!, { ...continuation, status: "completed" }];
    yield* Queue.offer(
      events,
      stored(2, { type: "run.updated", payload: { ...continuation, status: "completed" } }),
    );
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({
      timedOut: false,
      run: { id: continuationId, status: "completed" },
    });
  }),
);

it.effect("waitForThread returns the cut run once its continuation is declined", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-declined");
    const threadId = ThreadId.make("thread:thread-management:wait-declined");
    const runId = RunId.make("run:thread-management:wait-declined");
    const subscribed = yield* Deferred.make<void>();
    const declined = yield* Deferred.make<void>();
    let pending = true;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(pending),
          awaitRestartContinuation: () => Deferred.await(declined),
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.never),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status: "cancelled" }],
            } as unknown as OrchestrationV2ThreadProjection),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    pending = false;
    yield* Deferred.succeed(declined, undefined);
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "cancelled" } });
  }),
);

it.effect.each(["live", "no-session", "unsupported-runtime"] as const)(
  "marks background work awaited on the thread's active provider thread with state %s",
  (state) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-wait");
      const providerThreadId = ProviderThreadId.make("provider-thread:background-wait");
      const providerSessionId = ProviderSessionId.make("provider-session:background-wait");
      const driver = ProviderDriverKind.make("claudeAgent");
      const now = yield* DateTime.now;
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver,
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerSessionId,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "tests", kind: "command" }],
        contextUsage: null,
        nativeMetadata: null,
        createdAt: now,
        updatedAt: now,
      };
      const calls: Array<{ providerThreadId: ProviderThreadId; awaited: boolean }> = [];
      const runtime = {
        driver,
        providerSessionId,
        ...(state === "unsupported-runtime"
          ? {}
          : {
              awaitBackgroundTasks: (input: {
                readonly providerThread: OrchestrationV2ProviderThread;
                readonly taskIds: ReadonlyArray<string>;
                readonly awaited: boolean;
              }) =>
                Effect.sync(() => {
                  calls.push({
                    providerThreadId: input.providerThread.id,
                    awaited: input.awaited,
                  });
                  return { matched: input.taskIds.filter((taskId) => taskId === "tests") };
                }),
            }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    deletedAt: null,
                    activeProviderThreadId: providerThreadId,
                  },
                  providerThreads: [providerThread],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: () =>
                Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime)),
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      const result = yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        return yield* service
          .awaitBackgroundTasks({ threadId, taskIds: ["tests", "finished"], awaited: true })
          .pipe(Effect.result);
      }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));

      if (state === "live") {
        expect(result).toMatchObject({
          success: { matched: ["tests"], unmatched: ["finished"] },
        });
        expect(calls).toEqual([{ providerThreadId, awaited: true }]);
      } else {
        expect(result).toMatchObject({
          failure: {
            _tag: "ThreadManagementBackgroundWaitError",
            reason: state === "no-session" ? "unavailable" : "unsupported",
          },
        });
        expect(calls).toEqual([]);
      }
    }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          restartContinuationPending: () => Effect.succeed(false),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

// A T3-run workflow is a row on its thread whose members are delegated tasks on child threads.
const workflowStopParent = ThreadId.make("thread:workflow-stop:parent");
const workflowStopNode = NodeId.make("node:workflow-stop:workflow");
const workflowStopInput = { threadId: workflowStopParent, subagentId: workflowStopNode };

const makeWorkflowStopFixture = (input: {
  readonly workflowStatus: "running" | "cancelled" | "failed" | "completed";
  readonly graph: boolean;
  readonly members: ReadonlyArray<"running" | "cancelled">;
  /** A delegated task admitted in the same instant the workflow stops. */
  readonly lateMemberOnStop?: boolean;
  /** Command ids the dispatcher rejected before, as after an earlier failed stop. */
  readonly rejectedIds?: ReadonlyArray<string>;
}) => {
  const memberThreads = input.members.map((_, index) =>
    ThreadId.make(`thread:workflow-stop:member-${index}`),
  );
  const rows: Array<Record<string, unknown>> = [
    {
      id: workflowStopNode,
      threadId: workflowStopParent,
      origin: "app_owned",
      parentNodeId: null,
      childThreadId: null,
      status: input.workflowStatus,
      workflow: input.graph
        ? { phases: [], agents: [], plan: { nodes: [] } }
        : { phases: [], agents: [] },
    },
    ...input.members.map((status, index) => ({
      id: NodeId.make(`node:workflow-stop:member-${index}`),
      threadId: workflowStopParent,
      origin: "app_owned",
      parentNodeId: workflowStopNode,
      childThreadId: memberThreads[index]!,
      status,
    })),
  ];
  const lateMemberThread = ThreadId.make("thread:workflow-stop:member-late");
  const refusedThreads = new Set<ThreadId>();
  const refused = { workflowStop: false };
  const rejectedIds = new Set<string>(input.rejectedIds ?? []);
  const dispatched: Array<{
    readonly type: string;
    readonly commandId: string;
    readonly threadId?: ThreadId;
  }> = [];
  // A refusal while deciding a command stores a rejection under its id, as the dispatcher does.
  const refuse = (command: { readonly commandId: CommandId; readonly type: string }) => {
    rejectedIds.add(command.commandId);
    return Effect.fail(
      new Orchestrator.OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: "refused by the test",
      }),
    );
  };
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: (threadId) =>
          Effect.succeed({
            subagents: threadId === workflowStopParent ? rows.map((row) => ({ ...row })) : [],
          } as unknown as OrchestrationV2ThreadProjection),
        dispatch: (command) =>
          Effect.suspend((): Effect.Effect<never, Orchestrator.OrchestratorV2Error> => {
            dispatched.push({
              type: command.type,
              commandId: command.commandId,
              ...("threadId" in command ? { threadId: command.threadId } : {}),
            });
            if (rejectedIds.has(command.commandId)) {
              return Effect.fail(
                new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                  commandId: command.commandId,
                  commandType: command.type,
                  detail: "refused by the test",
                }),
              );
            }
            if (command.type === "workflow.stop") {
              const row = rows.find((candidate) => candidate.id === command.workflowId);
              if (refused.workflowStop || row?.status !== "running") return refuse(command);
              if (input.lateMemberOnStop === true) {
                rows.push({
                  id: NodeId.make("node:workflow-stop:member-late"),
                  threadId: workflowStopParent,
                  origin: "app_owned",
                  parentNodeId: workflowStopNode,
                  childThreadId: lateMemberThread,
                  status: "running",
                });
              }
              row.status = "cancelled";
            }
            if (command.type === "thread.stop") {
              if (refusedThreads.has(command.threadId)) return refuse(command);
              const member = rows.find((candidate) => candidate.childThreadId === command.threadId);
              if (member !== undefined) member.status = "cancelled";
            }
            return Effect.succeed({ sequence: 1, storedEvents: [] } as never);
          }),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );
  return {
    layerTest,
    memberThreads,
    lateMemberThread,
    refusedThreads,
    refused,
    dispatched,
    memberStatuses: () => rows.slice(1).map((row) => row.status),
    workflowStatus: () => rows[0]!.status,
    stopsOf: (type: string) => dispatched.filter((command) => command.type === type),
  };
};

it.effect.each([{ kind: "script" as const }, { kind: "graph" as const }])(
  "stopWorkflow stops every active member of a $kind workflow even when one member's stop fails",
  ({ kind }) => {
    const fixture = makeWorkflowStopFixture({
      workflowStatus: "running",
      graph: kind === "graph",
      members: ["running", "running", "running"],
    });
    return Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      fixture.refusedThreads.add(fixture.memberThreads[0]!);

      const first = yield* Effect.flip(service.stopWorkflow(workflowStopInput));

      // The failure is reported, but it does not leave later members running.
      expect(first).toMatchObject({ reason: "stop-failed" });
      expect(first.cause).toBeDefined();
      expect(fixture.stopsOf("thread.stop").map((command) => command.threadId)).toEqual(
        fixture.memberThreads,
      );
      expect(fixture.memberStatuses()).toEqual(["running", "cancelled", "cancelled"]);

      // A retry reaches the member the first try could not stop, instead of saying "not running".
      fixture.refusedThreads.clear();
      yield* service.stopWorkflow(workflowStopInput);
      expect(fixture.memberStatuses()).toEqual(["cancelled", "cancelled", "cancelled"]);
      expect(fixture.stopsOf("workflow.stop")).toHaveLength(1);

      const settled = yield* Effect.flip(service.stopWorkflow(workflowStopInput));
      expect(settled).toMatchObject({ reason: "not-running" });
    }).pipe(Effect.provide(fixture.layerTest));
  },
);

it.effect.each([
  { workflowStatus: "cancelled" as const },
  { workflowStatus: "failed" as const },
  { workflowStatus: "completed" as const },
])(
  "stopWorkflow still stops members left active under a $workflowStatus workflow",
  ({ workflowStatus }) => {
    const fixture = makeWorkflowStopFixture({
      workflowStatus,
      graph: false,
      members: ["cancelled", "running"],
    });
    return Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;

      yield* service.stopWorkflow(workflowStopInput);

      expect(fixture.stopsOf("thread.stop").map((command) => command.threadId)).toEqual([
        fixture.memberThreads[1],
      ]);
      expect(fixture.stopsOf("workflow.stop")).toHaveLength(0);
      expect(fixture.workflowStatus()).toBe(workflowStatus);

      const settled = yield* Effect.flip(service.stopWorkflow(workflowStopInput));
      expect(settled).toMatchObject({ reason: "not-running" });
      expect(fixture.dispatched).toHaveLength(1);
    }).pipe(Effect.provide(fixture.layerTest));
  },
);

it.effect("stopWorkflow leaves members alone when the workflow itself cannot be stopped", () => {
  const fixture = makeWorkflowStopFixture({
    workflowStatus: "running",
    graph: false,
    members: ["running", "running"],
  });
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    fixture.refused.workflowStop = true;

    const failed = yield* Effect.flip(service.stopWorkflow(workflowStopInput));

    // The script is still running and would start more agents, so no member is stopped early.
    expect(failed).toMatchObject({ reason: "stop-failed" });
    expect(fixture.stopsOf("thread.stop")).toHaveLength(0);
    expect(fixture.workflowStatus()).toBe("running");

    fixture.refused.workflowStop = false;
    yield* service.stopWorkflow(workflowStopInput);
    expect(fixture.workflowStatus()).toBe("cancelled");
    expect(fixture.memberStatuses()).toEqual(["cancelled", "cancelled"]);
  }).pipe(Effect.provide(fixture.layerTest));
});

it.effect("stopWorkflow stops a member admitted just before the workflow stopped", () => {
  const fixture = makeWorkflowStopFixture({
    workflowStatus: "running",
    graph: false,
    members: ["running"],
    lateMemberOnStop: true,
  });
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;

    yield* service.stopWorkflow(workflowStopInput);

    // The member list read before the stop misses it; once the stop commits, nothing more is admitted.
    expect(fixture.stopsOf("thread.stop").map((command) => command.threadId)).toEqual([
      fixture.memberThreads[0],
      fixture.lateMemberThread,
    ]);
    expect(fixture.memberStatuses()).toEqual(["cancelled", "cancelled"]);
  }).pipe(Effect.provide(fixture.layerTest));
});

it.effect(
  "stopWorkflow stops a workflow whose stop command id the dispatcher already rejected",
  () => {
    const workflowStopId = `command:workflow-stop:${workflowStopNode}`;
    const fixture = makeWorkflowStopFixture({
      workflowStatus: "running",
      graph: false,
      members: ["running"],
      rejectedIds: [workflowStopId],
    });
    return Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;

      yield* service.stopWorkflow(workflowStopInput);

      const attempts = fixture.stopsOf("workflow.stop").map((command) => command.commandId);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]).toBe(workflowStopId);
      expect(attempts[1]!.startsWith(`${workflowStopId}:retry:`)).toBe(true);
      expect(fixture.workflowStatus()).toBe("cancelled");
      expect(fixture.memberStatuses()).toEqual(["cancelled"]);
    }).pipe(Effect.provide(fixture.layerTest));
  },
);

it.effect(
  "stopWorkflow stops a member whose stop command id the dispatcher already rejected",
  () => {
    const memberStopId = `command:workflow-stop:${workflowStopNode}:thread:workflow-stop:member-0`;
    const fixture = makeWorkflowStopFixture({
      workflowStatus: "running",
      graph: false,
      members: ["running", "running"],
      rejectedIds: [memberStopId],
    });
    return Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;

      yield* service.stopWorkflow(workflowStopInput);

      const attempts = fixture
        .stopsOf("thread.stop")
        .filter((command) => command.threadId === fixture.memberThreads[0]);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.commandId).toBe(memberStopId);
      expect(attempts[1]!.commandId.startsWith(`${memberStopId}:retry:`)).toBe(true);
      expect(fixture.memberStatuses()).toEqual(["cancelled", "cancelled"]);
    }).pipe(Effect.provide(fixture.layerTest));
  },
);

it.effect(
  "stopWorkflow gives a permanently refused member one more try per call, not a loop",
  () => {
    const fixture = makeWorkflowStopFixture({
      workflowStatus: "running",
      graph: false,
      members: ["running"],
    });
    const memberStops = () =>
      fixture
        .stopsOf("thread.stop")
        .filter((command) => command.threadId === fixture.memberThreads[0]);
    return Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      fixture.refusedThreads.add(fixture.memberThreads[0]!);

      const first = yield* Effect.flip(service.stopWorkflow(workflowStopInput));
      expect(first).toMatchObject({ reason: "stop-failed" });
      expect(memberStops()).toHaveLength(1);

      // The first call stored a rejection under the member's id: the next call finds it, then
      // tries once under a fresh id, which the refusal rejects as well.
      const second = yield* Effect.flip(service.stopWorkflow(workflowStopInput));
      expect(second).toMatchObject({ reason: "stop-failed" });
      expect(memberStops()).toHaveLength(3);
      expect(fixture.stopsOf("workflow.stop")).toHaveLength(1);
    }).pipe(Effect.provide(fixture.layerTest));
  },
);

it.effect("stopWorkflow keeps every failure when several members cannot be stopped", () => {
  const fixture = makeWorkflowStopFixture({
    workflowStatus: "running",
    graph: false,
    members: ["running", "running", "running"],
  });
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    fixture.refusedThreads.add(fixture.memberThreads[0]!);
    fixture.refusedThreads.add(fixture.memberThreads[1]!);

    const failed = yield* Effect.flip(service.stopWorkflow(workflowStopInput));

    expect(failed).toMatchObject({ reason: "stop-failed" });
    expect(failed.cause).toBeInstanceOf(AggregateError);
    expect((failed.cause as AggregateError).errors).toHaveLength(2);
    // Each failed member is reported, and the member after them was still stopped.
    expect(fixture.memberStatuses()).toEqual(["running", "running", "cancelled"]);
  }).pipe(Effect.provide(fixture.layerTest));
});

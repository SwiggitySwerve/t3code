import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.4" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "delegated-admission" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  {
    databaseLayer: SqlitePersistence.layerMemory,
    runEffectWorker: false,
    maxRunningDelegatedTasks: 1,
  },
);

const parentThreadId = ThreadId.make("thread:admission-parent");

const startParent = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:admission-parent"),
    threadId: parentThreadId,
    projectId: ProjectId.make("project:admission"),
    title: "Admission parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send:admission-parent"),
    threadId: parentThreadId,
    messageId: MessageId.make("message:admission-parent"),
    text: "Fan out.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
});

const delegate = (task: string, workspaceStrategy?: { readonly type: "root" }) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

const firstRun = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs[0]!;
    const preparation = projection.turnItems.find(
      (item) => item.runId === run.id && item.type === "command_execution",
    );
    return { run, preparationTitle: preparation?.title ?? null };
  });

/** What the workspace preparer does once a checkout is ready. */
const releasePrepared = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { run } = yield* firstRun(threadId);
    yield* orchestrator.dispatch({
      type: "prepared-run.release",
      commandId: CommandId.make(`release:${threadId}`),
      threadId,
      runId: run.id,
    });
  });

const stop = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`stop:${threadId}`),
      threadId,
    });
  });

it.effect("a delegated task over the running limit waits, then starts when a slot frees", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* startParent;
    const first = yield* delegate("first task");
    const second = yield* delegate("second task");

    const running = yield* firstRun(first);
    assert.equal(running.run.status, "starting");
    assert.equal(running.run.admission, "admitted");
    const waiting = yield* firstRun(second);
    assert.equal(waiting.run.status, "preparing");
    assert.equal(waiting.run.admission, "waiting");
    assert.equal(waiting.preparationTitle, "Waiting for a free agent slot");

    const afterSequence = yield* orchestrator.getThreadEventSequence(second);
    yield* stop(first);
    yield* orchestrator.streamStoredEventsFrom({ threadId: second, afterSequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting",
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({ onNone: () => Effect.die("never started"), onSome: () => Effect.void }),
      ),
    );
    const admitted = yield* firstRun(second);
    assert.equal(admitted.run.admission, "admitted");
    assert.equal(admitted.preparationTitle, "Agent slot free");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("stopping a waiting task ends it without taking a slot", () =>
  Effect.gen(function* () {
    yield* startParent;
    yield* delegate("first task");
    const second = yield* delegate("second task");
    const third = yield* delegate("third task");
    yield* stop(second);
    assert.equal((yield* firstRun(second)).run.status, "interrupted");
    const stillWaiting = yield* firstRun(third);
    assert.equal(stillWaiting.run.status, "preparing");
    assert.equal(stillWaiting.run.admission, "waiting");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegate with a prepared workspace waits for a slot when the limit is reached", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* startParent;
    const first = yield* delegate("first task");
    const prepared = yield* delegate("prepared task", { type: "root" });

    // Its checkout is not ready yet, so it only holds its place.
    assert.equal((yield* firstRun(prepared)).run.status, "preparing");
    yield* releasePrepared(prepared);
    const waiting = yield* firstRun(prepared);
    assert.equal(waiting.run.status, "preparing");
    assert.equal(waiting.run.admission, "waiting");
    assert.equal(waiting.preparationTitle, "Waiting for a free agent slot");

    const afterSequence = yield* orchestrator.getThreadEventSequence(prepared);
    yield* stop(first);
    yield* orchestrator.streamStoredEventsFrom({ threadId: prepared, afterSequence }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" && stored.event.payload.status === "starting",
      ),
      Stream.runHead,
      Effect.flatMap(
        Option.match({ onNone: () => Effect.die("never started"), onSome: () => Effect.void }),
      ),
    );
    const admitted = yield* firstRun(prepared);
    assert.equal(admitted.run.admission, "admitted");
    assert.equal(admitted.preparationTitle, "Agent slot free");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a delegate with a prepared workspace starts at once when a slot freed meanwhile", () =>
  Effect.gen(function* () {
    yield* startParent;
    const first = yield* delegate("first task");
    const prepared = yield* delegate("prepared task", { type: "root" });
    yield* stop(first);
    yield* releasePrepared(prepared);
    const started = yield* firstRun(prepared);
    assert.equal(started.run.status, "starting");
    assert.equal(started.run.admission, "admitted");
    assert.equal(started.preparationTitle, "Workspace ready");
  }).pipe(Effect.provide(layerTest)),
);

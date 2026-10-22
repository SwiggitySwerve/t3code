import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpDelegateTasksResult,
  OrchestratorMcpTaskWaitResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const instanceId = ProviderInstanceId.make("codex");
const model = "gpt-5.4";
const modelSelection = { instanceId, model };
const parentThreadId = ThreadId.make("thread:delegate-tasks-parent");

const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-22T00:00:00.000Z",
  models: [{ slug: model, name: model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};

const layerDatabase = SqlitePersistence.layerMemory;
const makeLayerTest = (maxRunningDelegatedTasks?: number) => {
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "delegate-tasks" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      ...(maxRunningDelegatedTasks === undefined ? {} : { maxRunningDelegatedTasks }),
    },
  );
  const layerOrchestration = ThreadManagementService.layer.pipe(
    Layer.provideMerge(layerOrchestrator),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerSecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () =>
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeed(Option.none()),
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
      remove: () => Effect.void,
    }),
  );
  return McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(layerOrchestration),
    Layer.provide(ProviderAdapterRegistry.layerFromAdapters([adapter])),
    Layer.provide(ProviderRegistryMock.layer([provider])),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provideMerge(
      SecretRequests.layer.pipe(Layer.provide(layerSecretStore), Layer.provide(layerOrchestration)),
    ),
    Layer.provide(NodeServices.layer),
  );
};
const layerTest = makeLayerTest();

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "delegate-tasks-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "delegate-tasks-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:delegate-tasks"),
  requestNamespace: "provider-session:delegate-tasks",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:delegate-tasks",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const invoke = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const decodeStarted = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTasksResult);
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpTaskWaitResult);

const errorText = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("");

const startParent = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:delegate-tasks:create"),
    threadId: parentThreadId,
    projectId: ProjectId.make("project:delegate-tasks"),
    title: "Delegate tasks parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command:delegate-tasks:start"),
    threadId: parentThreadId,
    messageId: MessageId.make("message:delegate-tasks:start"),
    text: "Fan out work.",
    attachments: [],
    modelSelection,
    dispatchMode: { type: "start_immediately" },
  });
});

const childTasks = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
    (task) => task.origin === "app_owned",
  );
});

describe("delegate_tasks", () => {
  it.effect("starts every task in one call, in request order, and retries without duplicates", () =>
    Effect.gen(function* () {
      yield* startParent;
      const call = {
        tasks: [
          { task: "Count the files.", title: "files" },
          { task: "Count the lines.", title: "lines", role: "research" },
          {
            task: "Sum the results.",
            title: "sum",
            target: { providerInstanceId: instanceId, model },
          },
        ],
        clientRequestId: "batch-1",
      };
      const started = yield* decodeStarted(
        (yield* invoke("delegate_tasks", call)).structuredContent,
      );
      expect(started.tasks.map((task) => task.status)).toEqual(["running", "running", "running"]);
      expect(new Set(started.tasks.map((task) => task.childThreadId)).size).toBe(3);

      const tasks = new Map((yield* childTasks).map((task) => [task.id, task]));
      expect(started.tasks.map((task) => tasks.get(task.taskId)?.title)).toEqual([
        "files",
        "lines",
        "sum",
      ]);
      expect(tasks.get(started.tasks[1]!.taskId)?.prompt).toBe(
        "Act as the research sub-agent for this task.\n\nCount the lines.",
      );

      const retried = yield* decodeStarted(
        (yield* invoke("delegate_tasks", call)).structuredContent,
      );
      expect(retried.tasks.map((task) => task.taskId)).toEqual(
        started.tasks.map((task) => task.taskId),
      );
      expect(yield* childTasks).toHaveLength(3);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("shares a task's retry key with delegate_task", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* invoke("delegate_task", { task: "Review the diff.", clientRequestId: "review-1" });
      const started = yield* decodeStarted(
        (yield* invoke("delegate_tasks", {
          tasks: [
            { task: "Review the diff.", clientRequestId: "review-1" },
            { task: "Test the change." },
          ],
        })).structuredContent,
      );
      const tasks = yield* childTasks;
      expect(tasks).toHaveLength(2);
      expect(started.tasks[0]?.taskId).toContain("review-1");
      expect(new Set(started.tasks.map((task) => task.taskId))).toEqual(
        new Set(tasks.map((task) => task.id)),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("starts nothing when one entry is invalid, and names its index", () =>
    Effect.gen(function* () {
      yield* startParent;
      const result = yield* invoke("delegate_tasks", {
        tasks: [
          { task: "Valid task." },
          { task: "Bad target.", target: { providerInstanceId: "missing-provider" } },
        ],
      });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("tasks[1]:");
      expect(yield* childTasks).toHaveLength(0);
    }).pipe(Effect.provide(layerTest)),
  );
});

const startThree = Effect.gen(function* () {
  yield* startParent;
  return yield* decodeStarted(
    (yield* invoke("delegate_tasks", {
      tasks: [{ task: "First." }, { task: "Second." }, { task: "Third." }],
    })).structuredContent,
  );
});

const stopChild = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`command:delegate-tasks:stop:${childThreadId}`),
      threadId: childThreadId,
    });
  });

describe("task_wait", () => {
  it.effect("any returns the tasks that are ready and lists the rest as pending", () =>
    Effect.gen(function* () {
      const { tasks } = yield* startThree;
      yield* stopChild(tasks[1]!.childThreadId);
      const waited = yield* decodeWait(
        (yield* invoke("task_wait", {
          taskIds: tasks.map((task) => task.taskId),
          mode: "any",
        })).structuredContent,
      );
      expect(waited.timedOut).toBe(false);
      expect(waited.ready.map((task) => [task.taskId, task.status])).toEqual([
        [tasks[1]!.taskId, "interrupted"],
      ]);
      expect(waited.pending.map((task) => task.taskId)).toEqual([
        tasks[0]!.taskId,
        tasks[2]!.taskId,
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("all returns once every task is ready, in request order", () =>
    Effect.gen(function* () {
      const { tasks } = yield* startThree;
      const waiting = yield* invoke("task_wait", {
        taskIds: tasks.map((task) => task.taskId),
      }).pipe(Effect.forkChild);
      for (const task of tasks.toReversed()) yield* stopChild(task.childThreadId);
      const waited = yield* decodeWait((yield* Fiber.join(waiting)).structuredContent);
      expect(waited.timedOut).toBe(false);
      expect(waited.pending).toEqual([]);
      expect(waited.ready.map((task) => task.taskId)).toEqual(tasks.map((task) => task.taskId));
      expect(new Set(waited.ready.map((task) => task.status))).toEqual(new Set(["interrupted"]));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns why a task asked for a json result has none", () =>
    Effect.gen(function* () {
      yield* startParent;
      const { tasks } = yield* decodeStarted(
        (yield* invoke("delegate_tasks", {
          tasks: [
            { task: "Report a verdict.", resultSchema: { type: "object", required: ["verdict"] } },
          ],
        })).structuredContent,
      );
      const task = (yield* childTasks)[0]!;
      expect(task.prompt).toContain('{"type":"object","required":["verdict"]}');
      yield* stopChild(tasks[0]!.childThreadId);
      const waited = yield* decodeWait(
        (yield* invoke("task_wait", { taskIds: [tasks[0]!.taskId] })).structuredContent,
      );
      expect(waited.ready[0]).toMatchObject({
        status: "interrupted",
        structuredResultError: "The result has no fenced ```json block.",
      });
      expect(waited.ready[0]?.structuredResult).toBeUndefined();
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("rejects a task that belongs to another thread", () =>
    Effect.gen(function* () {
      yield* startParent;
      const result = yield* invoke("task_wait", { taskIds: ["node:not-a-task"] });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("task_not_found");
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("delegate_tasks over the running limit", () => {
  it.effect("reports the tasks past the limit as queued", () =>
    Effect.gen(function* () {
      const { tasks } = yield* startThree;
      expect(tasks.map((task) => task.status)).toEqual(["running", "running", "queued"]);
      const status = yield* invoke("task_status", { taskId: tasks[2]!.taskId });
      expect(status.structuredContent).toMatchObject({ status: "queued", workState: "working" });
    }).pipe(Effect.provide(makeLayerTest(2))),
  );
});

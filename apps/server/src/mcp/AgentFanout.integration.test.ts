// @effect-diagnostics nodeBuiltinImport:off -- tests write the declared files an agent would.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  NodeId,
  OrchestratorMcpDelegateTasksResult,
  OrchestratorMcpGraphReviewResult,
  OrchestratorMcpTaskWaitResult,
  OrchestratorMcpWorkflowResult,
  OrchestrationV2ThreadStreamItem,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2Run,
  type ModelSelection,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  type ServerProvider,
  type TurnTokenUsage,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { storedWorkflowScript } from "@t3tools/shared/storedWorkflowScript";
import { subscribeOrchestrationV2Thread } from "../ws.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { workflowPatches } from "@t3tools/shared/workflowUpdate";
import { applyOrchestrationV2ProjectionEvent } from "../../../../packages/client-runtime/src/state/orchestrationV2Projection.ts";
import {
  projectDomainEventForWire,
  projectThreadProjectionForWire,
} from "../orchestration-v2/WireProjection.ts";
import {
  buildBoundedThreadStreamSnapshot,
  boundWorkflowUpdateBatches,
} from "../orchestration-v2/ThreadStream.ts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as SqlClient from "effect/sql/SqlClient";
import { json as rpcJson } from "effect/rpc/RpcSerialization";
import type { ResponseChunkEncoded } from "effect/rpc/RpcMessage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  CLAUDE_PROVIDER,
  ClaudeProviderCapabilitiesV2,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WorkflowApprovalGate from "../orchestration-v2/WorkflowApprovalGate.ts";
import * as WorkflowApprovalService from "../orchestration-v2/WorkflowApprovalService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import { HtmlToolkit } from "./toolkits/html/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import { WorktreeRemovalToolkit, WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

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

const claudeInstanceId = ProviderInstanceId.make("claude-test");
const claudeModel = "claude-sonnet-4-6";
const claudeAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  ...adapter,
  instanceId: claudeInstanceId,
  driver: CLAUDE_PROVIDER,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
};
const claudeProvider: ServerProvider = {
  ...provider,
  instanceId: claudeInstanceId,
  driver: claudeAdapter.driver,
  models: [{ slug: claudeModel, name: claudeModel, isCustom: false, capabilities: null }],
};

const layerDatabase = SqlitePersistence.layerMemory;
const makeLayerTest = (
  maxRunningDelegatedTasks?: number,
  providers: ReadonlyArray<ServerProvider> = [provider, claudeProvider],
) => {
  const layerAdapters = ProviderAdapterRegistry.layerFromAdapters([adapter, claudeAdapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "delegate-tasks" },
    layerAdapters,
    {
      databaseLayer: layerDatabase,
      runEffectWorker: false,
      ...(maxRunningDelegatedTasks === undefined ? {} : { maxRunningDelegatedTasks }),
    },
  );
  const layerOrchestration = ThreadManagementService.layer.pipe(
    Layer.provideMerge(layerOrchestrator),
    Layer.provideMerge(
      ServerSettings.layerTest({
        providerInstances: Object.fromEntries(
          providers.map((provider) => [
            provider.instanceId,
            {
              driver: provider.driver,
              enabled: provider.enabled,
              config: {},
            },
          ]),
        ),
      }),
    ),
    Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerSecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () =>
    ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
      remove: () => Effect.void,
    }),
  );
  return McpHttpServer.layerOrchestratorToolkit.pipe(
    // Enough checkout for isolation "worktree": the run preparation itself is not under test.
    Layer.provideMerge(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({ prepareRun: () => Effect.void }),
    ),
    Layer.provideMerge(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        resolveCommit: () => Effect.succeed({ commitSha: "0123456789abcdef" } as never),
      }),
    ),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(WorkflowApprovalService.layer),
    Layer.provideMerge(layerOrchestration),
    Layer.provideMerge(layerAdapters),
    Layer.provideMerge(ProviderRegistryMock.layer(providers)),
    Layer.provideMerge(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) =>
          Effect.succeedSome({
            id: projectId,
            title: "Delegate tasks",
            // A real directory, so process checks have somewhere to run.
            workspaceRoot: process.cwd(),
          } as never),
      }),
    ),
    Layer.provideMerge(
      SecretRequests.layer.pipe(Layer.provide(layerSecretStore), Layer.provide(layerOrchestration)),
    ),
    Layer.provideMerge(NodeServices.layer),
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

const errorText = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("");

const startParentWithSelection = (selection: ModelSelection, text = "Fan out work.") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:delegate-tasks:create"),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:delegate-tasks"),
      title: "Delegate tasks parent",
      modelSelection: selection,
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
      text,
      attachments: [],
      modelSelection: selection,
      dispatchMode: { type: "start_immediately" },
    });
  });
const startParent = startParentWithSelection(modelSelection);

const childTasks = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
    (task) => task.origin === "app_owned",
  );
});

/** Finishes a delegated child's run as if its provider replied with `text`. */
const completeChild = (
  childThreadId: ThreadId,
  text: string,
  runPatch: Partial<OrchestrationV2Run> = { status: "completed" },
  tokens?: number | ReadonlyArray<TurnTokenUsage>,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const run = child.runs.at(-1)!;
    const usages: ReadonlyArray<TurnTokenUsage> =
      typeof tokens === "number"
        ? [
            {
              usageStatus: "complete",
              usageScope: "main_agent",
              hasSubagents: false,
              inputTokens: tokens,
              cachedInputTokens: Math.floor(tokens / 2),
              cacheCreationTokens: 0,
              outputTokens: 0,
            },
          ]
        : (tokens ?? []);
    const now = yield* DateTime.now;
    yield* sink.commitCommand({
      commandId: CommandId.make(`command:test-complete:${run.id}`),
      threadId: childThreadId,
      commandType: "test.complete",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make(`event:test-reply:${run.id}`),
          type: "message.updated",
          threadId: childThreadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: MessageId.make(`message:test-reply:${run.id}`),
            threadId: childThreadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            role: "assistant",
            text,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: now,
            updatedAt: now,
          },
        },
        ...usages.flatMap((usage, index) =>
          run.providerThreadId === null || run.rootNodeId === null
            ? []
            : [
                {
                  id: EventId.make(`event:test-turn:${run.id}:${index}`),
                  type: "provider-turn.updated" as const,
                  threadId: childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: {
                    id: ProviderTurnId.make(`provider-turn:test:${run.id}:${index}`),
                    providerThreadId: run.providerThreadId,
                    nodeId: run.rootNodeId,
                    runAttemptId: run.activeAttemptId,
                    nativeTurnRef: null,
                    ordinal: index + 1,
                    status: "completed" as const,
                    startedAt: now,
                    completedAt: now,
                    // Context occupancy deliberately differs from cumulative response usage.
                    tokenUsage: { usedTokens: 7, updatedAt: DateTime.formatIso(now) },
                    turnTokenUsage: usage,
                  },
                },
              ],
        ),
        {
          id: EventId.make(`event:test-complete:${run.id}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now, ...runPatch },
        },
      ],
    });
  });

const decodeStarted = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTasksResult);
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpTaskWaitResult);
const decodeWorkflow = Schema.decodeUnknownEffect(OrchestratorMcpWorkflowResult);

const refusedTargets = [
  {
    name: "unregistered provider",
    target: { providerInstanceId: "missing-provider", model },
    reason: "Provider instance missing-provider is not registered.",
  },
  {
    name: "disabled provider",
    target: { providerInstanceId: claudeInstanceId, model: claudeModel },
    reason: `Provider ${claudeInstanceId} cannot run a child task:`,
  },
  {
    name: "unknown model",
    target: { providerInstanceId: instanceId, model: "unknown-model" },
    reason: `Model unknown-model is not advertised by provider ${instanceId}.`,
  },
];
const layerRefusedTargets = makeLayerTest(undefined, [
  provider,
  { ...claudeProvider, enabled: false },
]);

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

/**
 * Answers every agent a workflow starts, as its provider would, with `reply(prompt)`.
 * Agents whose reply is undefined are left running.
 */
const answerWorkflowAgents = (reply: (prompt: string) => string | undefined, tokens?: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const answered = new Set<string>();
    return yield* orchestrator
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: 0,
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            if (stored.event.type !== "subagent.updated") return;
            const task = stored.event.payload;
            if (
              task.childThreadId === null ||
              task.status !== "running" ||
              answered.has(task.id) ||
              !String(task.parentNodeId).startsWith("workflow:")
            )
              return;
            const text = reply(task.prompt);
            if (text === undefined) return;
            answered.add(task.id);
            yield* completeChild(task.childThreadId, text, { status: "completed" }, tokens);
          }),
        ),
        Effect.forkChild,
      );
  });

const awaitWorkflowEnd = (workflowId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: 0,
      })
      .pipe(
        Stream.filter(
          (stored) =>
            (stored.event.type === "subagent.updated" ||
              stored.event.type === "workflow.updated") &&
            stored.event.payload.id === workflowId &&
            stored.event.payload.status !== undefined &&
            stored.event.payload.status !== "running",
        ),
        Stream.runHead,
      );
    return yield* decodeWorkflow(
      (yield* invoke("workflow_status", { workflowId })).structuredContent,
    );
  });

it.effect(
  "C7 reconstructs bounded 150-node commands, persisted events, wire replay and reconnect",
  () =>
    Effect.gen(function* () {
      yield* startParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const initial = yield* orchestrator.getThreadProjection(parentThreadId);
      const workflowId = NodeId.make("workflow:scale");
      yield* orchestrator.dispatch({
        type: "workflow.start",
        commandId: CommandId.make("scale-start"),
        createdBy: "agent",
        creationSource: "mcp",
        threadId: parentThreadId,
        runId: initial.runs.at(-1)!.id,
        workflowId,
        title: "Scale 日本語 🧪",
        script: "// frozen reviewed graph\n" + "Long prompt 日本語 🧪\n".repeat(150),
      });
      const base = yield* orchestrator.getThreadProjection(parentThreadId);
      const highWater = yield* sql<{
        sequence: number;
      }>`SELECT max(sequence) AS sequence FROM orchestration_events`;
      const workflow: OrchestrationV2SubagentWorkflow = {
        phases: [{ index: 0, title: "Audit 日本語" }],
        budget: { limit: 100000, exhausted: true },
        plan: {
          nodes: Array.from({ length: 150 }, (_, i) => ({
            key: `n${i}`,
            label: `Audit ${i} données 日本語 🧪`,
            wave: Math.floor(i / 10),
            dependsOn: i < 10 ? [] : [`n${i - 10}`],
          })),
        },
        agents: Array.from({ length: 450 }, (_, index) => ({
          index,
          label: `${index < 150 ? "Worker" : "Check"} ${index}`,
          state: "completed",
          ...(index < 150
            ? { graphNodeKey: `n${index}` }
            : {
                judgmentFor: {
                  agentIndex: index % 150,
                  attempt: index < 300 ? 0 : 1,
                  graphNodeKey: `n${index % 150}`,
                },
                judgmentOutcome: "passed",
              }),
          prompt: "Inspect données 日本語 🧪 ".repeat(20),
          result: "Evidence and reasons 日本語 🧪 ".repeat(50),
          agentId: `task-${index}-1`,
          childThreadId: ThreadId.make(`child-${index}-1`),
          attemptTaskIds: [NodeId.make(`task-${index}-0`), NodeId.make(`task-${index}-1`)],
          attemptHistory: [0, 1].map((attempt) => ({
            taskId: NodeId.make(`task-${index}-${attempt}`),
            childThreadId: ThreadId.make(`child-${index}-${attempt}`),
            attempt,
            state: attempt === 0 ? "failed" : "completed",
            providerInstanceId: instanceId,
            model,
            usageStatus: "complete",
            totalTokens: 1234,
            durationMs: 3210,
            timingComplete: true,
          })),
        })),
        nodeOutcomes: Object.fromEntries(
          Array.from({ length: 150 }, (_, i) => [
            `n${i}`,
            { status: "passed", attempts: 2, reason: "Reviewed evidence 日本語 🧪 ".repeat(20) },
          ]),
        ),
      };
      const commands = workflowPatches({ phases: [], agents: [] }, workflow).map(
        (patch, index) => ({
          type: "workflow.update" as const,
          commandId: CommandId.make(`scale-update-${index}`),
          threadId: parentThreadId,
          workflowId,
          workflow: patch,
        }),
      );
      for (const command of commands) yield* orchestrator.dispatch(command);
      // A producer that read an older row still lands: the sink rebases it on the current revision.
      {
        const sink = yield* EventSink.EventSinkV2;
        const before = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === workflowId,
        )!;
        const stale = before.workflow!.revision! - 1;
        const now = yield* DateTime.now;
        yield* sink.commitCommand({
          commandId: CommandId.make("scale-stale-revision"),
          threadId: parentThreadId,
          commandType: "test.stale-workflow-update",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("event:scale-stale-revision"),
              type: "workflow.updated",
              threadId: parentThreadId,
              occurredAt: now,
              payload: {
                id: workflowId,
                previousRevision: stale - 1,
                revision: stale,
                progress: "Stale producer progress",
                updatedAt: now,
              },
            },
          ],
        });
        const after = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === workflowId,
        )!;
        expect(after.workflow!.revision).toBe(before.workflow!.revision! + 1);
        expect(after.progress).toBe("Stale producer progress");
        // Restore the progress the remaining assertions expect.
        yield* sink.commitCommand({
          commandId: CommandId.make("scale-stale-revision-restore"),
          threadId: parentThreadId,
          commandType: "test.stale-workflow-update",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("event:scale-stale-revision-restore"),
              type: "workflow.updated",
              threadId: parentThreadId,
              occurredAt: now,
              payload: {
                id: workflowId,
                previousRevision: 0,
                revision: 1,
                ...(before.progress === undefined ? {} : { progress: before.progress }),
                updatedAt: now,
              },
            },
          ],
        });
      }
      // Retried delivery uses the command receipt; it must not add a revision or reapply usage.
      yield* orchestrator.dispatch(commands.at(-1)!);
      const oversized = yield* Effect.result(
        orchestrator.dispatch({
          ...commands[0]!,
          commandId: CommandId.make("scale-oversized"),
          workflow: {
            kind: "patch",
            agents: [{ ...workflow.agents[0]!, result: "日本語".repeat(20000) }],
          },
        }),
      );
      expect(oversized._tag).toBe("Failure");
      const changedPlan = yield* Effect.result(
        orchestrator.dispatch({
          ...commands[0]!,
          commandId: CommandId.make("scale-changed-plan"),
          workflow: { kind: "patch", plan: { nodes: [] } },
        }),
      );
      expect(changedPlan._tag).toBe("Failure");
      const complete = {
        type: "workflow.complete" as const,
        commandId: CommandId.make("scale-complete"),
        threadId: parentThreadId,
        workflowId,
        status: "completed" as const,
        result: "Recorded result 日本語 🧪",
      };
      yield* orchestrator.dispatch(complete);
      const acknowledgements = [1, 2].map((index) => ({
        type: "delegated_task.completion-delivery.acknowledge" as const,
        commandId: CommandId.make(`scale-observed-${index}`),
        parentThreadId,
        taskId: workflowId,
        observedByRunId: initial.runs.at(-1)!.id,
      }));
      for (const command of acknowledgements) yield* orchestrator.dispatch(command);
      const projected = yield* orchestrator.getThreadProjection(parentThreadId);
      const final = projected.subagents.find((task) => task.id === workflowId)!;
      // Commands, the two stale-producer events, completion and two acknowledgements.
      expect(final.workflow).toEqual({ ...workflow, revision: commands.length + 5 });
      const rows = yield* sql<{
        event_type: string;
        payload_json: string;
      }>`SELECT event_type, payload_json FROM orchestration_events WHERE sequence > ${highWater[0]!.sequence} AND event_type = 'workflow.updated' ORDER BY sequence`;
      expect(rows).toHaveLength(commands.length + 5);
      const stored = yield* orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: highWater[0]!.sequence,
          eventType: "workflow.updated",
        })
        .pipe(Stream.take(rows.length), Stream.runCollect);
      const encode = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
      const decode = Schema.decodeUnknownEffect(
        Schema.toCodecJson(OrchestrationV2ThreadStreamItem),
      );
      const wire = yield* Effect.forEach(stored, (item) =>
        encode({
          kind: "event",
          sequence: item.sequence,
          event: projectDomainEventForWire(item.event),
        }),
      );
      const batches = yield* Stream.fromArray(
        stored.map((item) => ({
          kind: "event" as const,
          sequence: item.sequence,
          event: item.event,
        })),
      ).pipe(boundWorkflowUpdateBatches, Stream.chunks, Stream.runCollect);
      const serializer = rpcJson.makeUnsafe();
      const rpcFrames = yield* Effect.forEach(batches, (batch) =>
        Effect.gen(function* () {
          const values = yield* Effect.forEach(batch, (item) => encode(item));
          const message: ResponseChunkEncoded = {
            _tag: "Chunk",
            requestId: "workflow-scale-subscription",
            values: [values[0]!, ...values.slice(1)],
          };
          const frame = serializer.encode(message);
          if (typeof frame !== "string")
            throw new Error("Expected the production JSON RPC serializer");
          return frame;
        }),
      );
      let client = base;
      for (const encoded of wire) {
        const item = yield* decode(encoded);
        if (item.kind !== "event") throw new Error("Expected event");
        client = applyOrchestrationV2ProjectionEvent(client, item.event)!;
      }
      expect(client.subagents.find((task) => task.id === workflowId)).toEqual(final);
      // The finished workflow's timeline item changes through its own event, for every client.
      const itemEvents = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_events WHERE sequence > ${highWater[0]!.sequence} AND event_type = 'turn-item.updated' ORDER BY sequence`;
      const workflowItems = itemEvents
        .map((row) => JSON.parse(row.payload_json))
        .filter((item) => item.type === "subagent" && item.subagentId === workflowId);
      expect(workflowItems.at(-1)).toMatchObject({ status: "completed" });
      expect(
        projected.turnItems.find(
          (item) => item.type === "subagent" && item.subagentId === workflowId,
        ),
      ).toMatchObject({ status: "completed", result: complete.result });
      // Older clients do not apply patches.
      const subscribe = (input: { afterSequence?: number; acceptWorkflowUpdates?: true }) =>
        subscribeOrchestrationV2Thread({ threadId: parentThreadId, ...input }).pipe(
          // Replay reads the same in-memory database the orchestrator writes.
          Effect.provide(OrchestrationEventStore.layer),
        );
      // A replay holding a patch sends an older client a snapshot rather than one full row per
      // patch, which could far exceed the replay byte limit.
      const tail = stored.slice(-3);
      const legacyResume = yield* subscribe({ afterSequence: tail[0]!.sequence - 1 }).pipe(
        Effect.flatMap((stream) => Stream.runHead(stream)),
        Effect.timeout("20 seconds"),
      );
      if (legacyResume._tag !== "Some" || legacyResume.value.kind !== "snapshot")
        throw new Error("Expected an older client's resume to start from a snapshot");
      expect(
        boundedSnapshotProjection(legacyResume.value).subagents.find(
          (task) => task.id === workflowId,
        ),
      ).toEqual(final);
      // A current client replays the patches themselves.
      const currentResume = yield* subscribe({
        afterSequence: tail[0]!.sequence - 1,
        acceptWorkflowUpdates: true,
      }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.filter(
              (item) =>
                item.kind === "event" &&
                item.event.type === "workflow.updated" &&
                item.event.payload.id === workflowId,
            ),
            Stream.take(tail.length),
            Stream.runCollect,
          ),
        ),
        Effect.timeout("20 seconds"),
      );
      expect(Array.from(currentResume)).toHaveLength(tail.length);
      // Live, an older client receives each new patch as the workflow's full row.
      const subscribed = yield* Deferred.make<void>();
      const live = yield* subscribe({}).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            // Commit only after the snapshot, so the change arrives as a live event.
            Stream.tap((item) =>
              item.kind === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
            ),
            Stream.filter(
              (item) =>
                item.kind === "event" &&
                (item.event.type === "workflow.updated" ||
                  item.event.type === "subagent.updated") &&
                item.event.payload.id === workflowId,
            ),
            Stream.runHead,
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed).pipe(Effect.timeout("20 seconds"));
      {
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        yield* sink.commitCommand({
          commandId: CommandId.make("scale-live-legacy"),
          threadId: parentThreadId,
          commandType: "test.live-workflow-update",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make("event:scale-live-legacy"),
              type: "workflow.updated",
              threadId: parentThreadId,
              occurredAt: now,
              payload: {
                id: workflowId,
                previousRevision: 0,
                revision: 1,
                progress: "Live progress for older clients",
                updatedAt: now,
              },
            },
          ],
        });
      }
      const liveItem = yield* Fiber.join(live).pipe(Effect.timeout("20 seconds"));
      if (liveItem._tag !== "Some" || liveItem.value.kind !== "event")
        throw new Error("Expected a live workflow event");
      expect(liveItem.value.event.type).toBe("subagent.updated");
      expect(
        liveItem.value.event.type === "subagent.updated"
          ? liveItem.value.event.payload.progress
          : null,
      ).toBe("Live progress for older clients");
      const snapshot = buildBoundedThreadStreamSnapshot({
        snapshotSequence: stored.at(-1)!.sequence,
        projection: projected,
      });
      const encodedSnapshot = yield* encode(snapshot);
      const reconnect = yield* decode(encodedSnapshot);
      if (reconnect.kind !== "snapshot") throw new Error("Expected snapshot");
      expect(
        boundedSnapshotProjection(reconnect).subagents.find((task) => task.id === workflowId),
      ).toEqual(final);
      const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
      expect(Math.max(...commands.map(bytes))).toBeLessThan(65536);
      expect(
        Math.max(...rows.map((row) => Buffer.byteLength(row.payload_json, "utf8"))),
      ).toBeLessThan(65536);
      expect(Math.max(...wire.map(bytes))).toBeLessThan(65536);
      expect(Math.max(...rpcFrames.map((frame) => Buffer.byteLength(frame, "utf8")))).toBeLessThan(
        65536,
      );
      expect(bytes(encodedSnapshot)).toBeGreaterThan(65536);
      if (process.env.C7_BOUNDARY_ARTIFACT)
        NodeFS.writeFileSync(
          process.env.C7_BOUNDARY_ARTIFACT,
          JSON.stringify(
            {
              commands: [...commands, complete, ...acknowledgements],
              persistedPayloads: rows,
              wire,
              rpcFrames,
              snapshot: encodedSnapshot,
              commandBytes: [...commands, complete, ...acknowledgements].map(bytes),
              persistedBytes: rows.map((row) => Buffer.byteLength(row.payload_json, "utf8")),
              wireBytes: wire.map(bytes),
              rpcFrameBytes: rpcFrames.map((frame) => Buffer.byteLength(frame, "utf8")),
              snapshotBytes: bytes(encodedSnapshot),
            },
            null,
            2,
          ),
        );
    }).pipe(Effect.provide(Layer.merge(layerTest, layerDatabase))),
);

const startWorkflow = (script: string, args?: unknown) =>
  Effect.gen(function* () {
    const result = yield* invoke("workflow_start", {
      script,
      title: "Test workflow",
      ...(args === undefined ? {} : { args }),
    });
    return yield* decodeWorkflow(result.structuredContent);
  });

describe("workflow_start", () => {
  it.effect(
    "C4 preserves script target, legacy, preset, workflow default and caller precedence",
    () =>
      Effect.gen(function* () {
        yield* startParentWithSelection({
          ...modelSelection,
          options: [{ id: "serviceTier", value: "priority" }],
        });
        yield* answerWorkflowAgents(() => "done");
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          workflowPresets: {
            presets: [
              {
                id: "worker",
                name: "Worker",
                target: { providerInstanceId: claudeInstanceId, model: claudeModel, options: [] },
              },
              {
                id: "same",
                name: "Same model",
                target: {
                  providerInstanceId: instanceId,
                  model,
                  options: [{ id: "reasoningEffort", value: "high" }],
                },
              },
            ],
            defaultPresetId: "worker",
          },
        });
        expect((yield* invoke("orchestrator_capabilities", {})).structuredContent).toMatchObject({
          workflowPresets: {
            defaultPresetId: "worker",
            presets: [
              {
                id: "worker",
                name: "Worker",
                target: { providerInstanceId: claudeInstanceId, model: claudeModel },
              },
              { id: "same", name: "Same model", target: { providerInstanceId: instanceId, model } },
            ],
          },
        });
        const script = `return [
        await agent("own", { target: { model: "${model}" }, preset: "missing" }),
        await agent("legacy", { model: "${model}", preset: "missing" }),
        await agent("preset", { preset: "worker" }),
        await agent("same", { preset: "same" }),
        await agent("default")
      ]`;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        for (const workerTarget of [
          undefined,
          { providerInstanceId: instanceId, model, options: [] },
        ]) {
          const started = yield* decodeWorkflow(
            (yield* invoke("workflow_start", {
              script,
              ...(workerTarget === undefined ? {} : { workerTarget }),
            })).structuredContent,
          );
          expect((yield* awaitWorkflowEnd(started.workflowId)).status).toBe("completed");
          const expected = [
            { ...modelSelection, options: [{ id: "serviceTier", value: "priority" }] },
            { ...modelSelection, options: [{ id: "serviceTier", value: "priority" }] },
            { instanceId: claudeInstanceId, model: claudeModel, options: [] },
            // The preset was frozen at start with its complete, sorted options.
            {
              ...modelSelection,
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "serviceTier", value: "priority" },
              ],
            },
            workerTarget === undefined
              ? { instanceId: claudeInstanceId, model: claudeModel, options: [] }
              : { ...modelSelection, options: [] },
          ];
          for (const [index, selection] of expected.entries()) {
            const member = yield* awaitMember(started.workflowId, index + 1);
            expect(
              (yield* orchestrator.getThreadProjection(member.childThreadId!)).thread
                .modelSelection,
            ).toEqual(selection);
          }
        }
        yield* settings.updateSettings({ workflowPresets: { presets: [], defaultPresetId: null } });
        const caller = yield* startWorkflow('return await agent("caller")');
        yield* awaitWorkflowEnd(caller.workflowId);
        expect((yield* awaitMember(caller.workflowId, 1)).providerInstanceId).toBe(instanceId);
        expect(
          (yield* orchestrator.getThreadProjection(parentThreadId)).thread.modelSelection,
        ).toEqual({ ...modelSelection, options: [{ id: "serviceTier", value: "priority" }] });
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect("C3 preserves resolver option inheritance overrides and clearing", () =>
    Effect.gen(function* () {
      const inherited = [
        { id: "reasoningEffort", value: "medium" },
        { id: "serviceTier", value: "priority" },
      ];
      yield* startParentWithSelection({ ...modelSelection, options: inherited });
      yield* answerWorkflowAgents(() => "done");
      const workerTarget = { options: { reasoningEffort: "high" } };
      const cases: Array<{ own: Record<string, unknown>; expected: ModelSelection }> = [
        {
          own: {},
          expected: {
            ...modelSelection,
            options: [{ id: "reasoningEffort", value: "high" }, inherited[1]!],
          },
        },
        { own: { target: { options: [] } }, expected: { ...modelSelection, options: [] } },
        { own: { target: { options: {} } }, expected: { ...modelSelection, options: [] } },
        { own: { target: { model } }, expected: { ...modelSelection, options: inherited } },
        { own: { model: "other-model" }, expected: { instanceId, model: "other-model" } },
        {
          own: { target: { providerInstanceId: claudeInstanceId } },
          expected: { instanceId: claudeInstanceId, model: claudeModel },
        },
      ];
      const started = yield* decodeWorkflow(
        (yield* invoke("workflow_start", {
          workerTarget,
          args: cases.map(({ own }) => own),
          script: 'return await parallel(args.map((own) => () => agent("options", own)))',
        })).structuredContent,
      );
      expect((yield* awaitWorkflowEnd(started.workflowId)).status).toBe("completed");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const [index, entry] of cases.entries()) {
        const member = yield* awaitMember(started.workflowId, index + 1);
        const child = yield* orchestrator.getThreadProjection(member.childThreadId!);
        expect(child.thread.modelSelection).toEqual(entry.expected);
        const graph = {
          schemaVersion: 1,
          nodes: {
            a: { subject: "options", description: "options", dependsOn: [], ...entry.own },
          },
        };
        const reviewed = yield* decodeReview(
          (yield* invoke("graph_review", { graph, workerTarget })).structuredContent,
        );
        const target = {
          providerInstanceId: entry.expected.instanceId,
          model: entry.expected.model,
          options: [...(entry.expected.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
        };
        expect(reviewed).toMatchObject({ ready: true, targets: [{ target }] });
        const explicit = yield* reviewGraph({
          ...graph,
          nodes: { a: { subject: "options", description: "options", dependsOn: [], target } },
        });
        expect(reviewed.digest).toBe(explicit.digest);
      }
    }).pipe(
      Effect.provide(
        makeLayerTest(undefined, [
          {
            ...provider,
            models: [
              ...provider.models,
              { slug: "other-model", name: "Other", isCustom: true, capabilities: null },
            ],
          },
          claudeProvider,
        ]),
      ),
    ),
  );
  it.effect("C3 selects the whole agent target before the worker default", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(() => "done");
      const started = yield* decodeWorkflow(
        (yield* invoke("workflow_start", {
          workerTarget: { providerInstanceId: claudeInstanceId, model: claudeModel },
          script: `return [
          await agent("default"),
          await agent("partial", { target: { model: "${model}" } }),
          await agent("legacy", { model: "${model}" }),
          await agent("empty", { target: {} })
        ]`,
        })).structuredContent,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("completed");
      expect(
        (yield* childTasks)
          .filter((task) => task.parentNodeId === started.workflowId)
          .map((agent) => [agent.providerInstanceId, agent.model]),
      ).toEqual([
        [claudeInstanceId, claudeModel],
        [instanceId, model],
        [instanceId, model],
        [instanceId, model],
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(refusedTargets)(
    "records a refused $name without substituting a worker",
    ({ target, reason }) =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents(() => "unexpected dispatch");
        const started = yield* startWorkflow(
          `return await agent("refused worker", { target: ${JSON.stringify(target)} })`,
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        // Scripts receive null for an agent that could not start; the failed attempt stays visible.
        expect(ended.status).toBe("completed");
        expect(JSON.parse(ended.result!)).toBeNull();
        expect(ended.agents).toHaveLength(1);
        expect(ended.agents[0]).toMatchObject({
          status: "failed",
          taskId: null,
          outcomeCategory: "never_started",
        });
        expect(ended.agents[0]?.result).toContain(reason);
        expect((yield* childTasks).map((task) => task.id)).toEqual([started.workflowId]);
      }).pipe(Effect.provide(layerRefusedTargets)),
  );

  it.effect("persists each mixed-provider worker's selected model and options", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(() => "mixed reply");
      const targets = [
        { providerInstanceId: instanceId, model, options: { reasoningEffort: "high" } },
        {
          providerInstanceId: claudeInstanceId,
          model: claudeModel,
          options: { effort: "max", fastMode: true },
        },
      ];
      const started = yield* startWorkflow(
        `return await parallel(args.map((target) => () => agent("mixed worker", { target })))`,
        targets,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("completed");
      expect(JSON.parse(ended.result!)).toEqual(["mixed reply", "mixed reply"]);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const members = (yield* childTasks).filter(
        (task) => task.parentNodeId === started.workflowId,
      );
      expect(members).toHaveLength(2);
      expect(new Set(members.map((task) => task.childThreadId)).size).toBe(2);
      for (const [index, target] of targets.entries()) {
        const member = members.find(
          (task) => task.providerInstanceId === target.providerInstanceId,
        )!;
        const driver = index === 0 ? adapter.driver : claudeAdapter.driver;
        expect(member).toMatchObject({ driver, model: target.model });
        const child = yield* orchestrator.getThreadProjection(member.childThreadId!);
        const expectedSelection = {
          instanceId: target.providerInstanceId,
          model: target.model,
          options: Object.entries(target.options).map(([id, value]) => ({ id, value })),
        };
        expect(child.thread.modelSelection).toEqual(expectedSelection);
        expect(child.runs).toHaveLength(1);
        expect(child.runs[0]?.modelSelection).toEqual(expectedSelection);
      }
      expect(ended.agents.map((agent) => [agent.model, agent.status])).toEqual(
        targets.map((target) => [target.model, "completed"]),
      );
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      expect(parent.thread.modelSelection).toEqual(modelSelection);
      const row = parent.subagents.find((task) => task.id === started.workflowId);
      expect(
        row?.workflow?.agents.map((agent) => [
          agent.providerInstanceId,
          agent.driver,
          agent.model,
          agent.state,
        ]),
      ).toEqual(
        targets.map((target, index) => [
          target.providerInstanceId,
          index === 0 ? adapter.driver : claudeAdapter.driver,
          target.model,
          "completed",
        ]),
      );
      expect(
        parent.subagents.filter((task) => task.parentNodeId === started.workflowId),
      ).toHaveLength(2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "keeps concurrent workflows on one parent independent through completion and wake",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const [first, second] = yield* Effect.all(
          [startWorkflow(twoStepScript), startWorkflow(twoStepScript)],
          { concurrency: "unbounded" },
        );
        expect(first.workflowId).not.toBe(second.workflowId);
        const firstMember = yield* awaitMember(first.workflowId, 1);
        const secondMember = yield* awaitMember(second.workflowId, 1);
        expect(firstMember.id).not.toBe(secondMember.id);
        expect(firstMember.childThreadId).not.toBe(secondMember.childThreadId);
        expect(firstMember.prompt).toBe(secondMember.prompt);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        expect(
          (yield* childTasks).filter(
            (task) =>
              task.parentNodeId === first.workflowId || task.parentNodeId === second.workflowId,
          ),
        ).toHaveLength(2);

        yield* completeChild(secondMember.childThreadId!, "second one");
        const secondNext = yield* awaitMember(second.workflowId, 2);
        expect(secondNext.prompt).toBe("second after second one");
        yield* completeChild(secondNext.childThreadId!, "second two");
        const secondEnded = yield* awaitWorkflowEnd(second.workflowId);
        expect(JSON.parse(secondEnded.result!)).toEqual(["second one", "second two"]);
        expect(secondEnded.status).toBe("completed");
        const firstPending = yield* decodeWorkflow(
          (yield* invoke("workflow_status", { workflowId: first.workflowId })).structuredContent,
        );
        expect(firstPending.status).toBe("running");
        expect(firstPending.agents).toHaveLength(1);
        expect(firstPending.agents[0]).toMatchObject({ taskId: firstMember.id, status: "running" });
        const midway = yield* orchestrator.getThreadProjection(parentThreadId);
        expect(
          midway.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
        ).toEqual([second.workflowId]);

        yield* completeChild(firstMember.childThreadId!, "first one");
        const firstNext = yield* awaitMember(first.workflowId, 2);
        expect(firstNext.prompt).toBe("second after first one");
        yield* completeChild(firstNext.childThreadId!, "first two");
        const firstEnded = yield* awaitWorkflowEnd(first.workflowId);
        expect(firstEnded.status).toBe("completed");
        expect(JSON.parse(firstEnded.result!)).toEqual(["first one", "first two"]);
        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const members = parent.subagents.filter(
          (task) =>
            task.parentNodeId === first.workflowId || task.parentNodeId === second.workflowId,
        );
        expect(members).toHaveLength(4);
        expect(new Set(members.map((task) => task.id)).size).toBe(4);
        expect(new Set(members.map((task) => task.childThreadId)).size).toBe(4);
        for (const [ended, owned] of [
          [firstEnded, [firstMember, firstNext]],
          [secondEnded, [secondMember, secondNext]],
        ] as const) {
          expect(ended.agents.map((agent) => agent.taskId)).toEqual(owned.map((task) => task.id));
          expect(ended.agents.map((agent) => agent.status)).toEqual(["completed", "completed"]);
          expect(
            members
              .filter((task) => task.parentNodeId === ended.workflowId)
              .map((task) => task.completionDelivery?.state),
          ).toEqual(["disposed", "disposed"]);
        }
        expect(
          parent.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
        ).toEqual([second.workflowId, first.workflowId]);
        expect(
          parent.turnItems
            .filter((item) => item.type === "subagent")
            .map((item) => item.type === "subagent" && item.subagentId),
        ).toEqual(expect.arrayContaining([first.workflowId, second.workflowId]));
        expect(parent.turnItems.filter((item) => item.type === "subagent")).toHaveLength(2);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("runs phases of parallel and pipelined agents and wakes the caller once", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) => `done(${prompt})`);
      const started = yield* startWorkflow(
        `export const meta = { name: "review", phases: [{ title: "Scan" }, { title: "Review" }] }
const scanned = await parallel(args.files.map((file) => () => agent("scan " + file, { label: file, phase: "Scan" })))
log("scanned", scanned.length)
const reviewed = await pipeline(scanned, (text) => agent("review " + text, { label: "review", phase: "Review" }))
return { scanned, reviewed }`,
        { files: ["a", "b", "c"] },
      );
      expect(started.status).toBe("running");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended).toMatchObject({
        status: "completed",
        name: "review",
        phases: ["Scan", "Review"],
      });
      expect(JSON.parse(ended.result!)).toEqual({
        scanned: ["done(scan a)", "done(scan b)", "done(scan c)"],
        reviewed: [
          "done(review done(scan a))",
          "done(review done(scan b))",
          "done(review done(scan c))",
        ],
      });
      expect(ended.agents).toHaveLength(6);
      expect(new Set(ended.agents.map((agent) => agent.status))).toEqual(new Set(["completed"]));
      expect(ended.agents.filter((agent) => agent.phase === "Review")).toHaveLength(3);

      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const members = parent.subagents.filter((task) => task.parentNodeId === started.workflowId);
      expect(members).toHaveLength(6);
      expect(new Set(members.map((task) => task.completionDelivery?.state))).toEqual(
        new Set(["disposed"]),
      );
      // One timeline item for the workflow, none for its members.
      expect(
        parent.turnItems
          .filter((item) => item.type === "subagent")
          .map((item) => item.type === "subagent" && item.subagentId),
      ).toEqual([started.workflowId]);
      const deliveries = parent.runs.flatMap(
        (run) => run.delegatedCompletion?.delivery?.taskIds ?? [],
      );
      expect(deliveries).toEqual([started.workflowId]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns structured results for agents given a schema", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(() => 'Counted.\n```json\n{"lines": 42}\n```');
      const started = yield* startWorkflow(
        `const counted = await agent("count lines", { schema: { type: "object", required: ["lines"], properties: { lines: { type: "integer" } } } })
return counted.lines + 1`,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended).toMatchObject({ status: "completed", result: "43" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports a script error as a failed workflow", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('if (!args) throw new Error("args are required")');
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("failed");
      expect(ended.result).toContain("args are required");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("caps a failed workflow's result at 4,096 bytes and marks the cut", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('throw new Error("x".repeat(100000))');
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("failed");
      expect(ended.result!.startsWith("The workflow failed: xxx")).toBe(true);
      expect(Buffer.byteLength(ended.result!, "utf8")).toBeLessThanOrEqual(4_096);
      expect(ended.result!).toMatch(/\.\.\.truncated \(\d+ of \d+ bytes\)$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses a script that does not compile and starts nothing", () =>
    Effect.gen(function* () {
      yield* startParent;
      const result = yield* invoke("workflow_start", { script: "const = 1" });
      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("does not compile");
      expect(yield* childTasks).toHaveLength(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["workflow_stop", "task_cancel"] as const)(
    "%s stops the script and every running agent, with no completion wake",
    (tool) =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) => (prompt === "quick" ? "quick done" : undefined));
        const started = yield* startWorkflow(
          'await agent("quick")\nreturn await parallel([() => agent("slow one"), () => agent("slow two")])',
        );
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: 0,
            eventType: "subagent.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.prompt === "slow two" &&
                stored.event.payload.status === "running",
            ),
            Stream.runHead,
          );
        yield* invoke(
          tool,
          tool === "workflow_stop"
            ? { workflowId: started.workflowId }
            : { taskId: started.workflowId },
        );
        const ended = yield* decodeWorkflow(
          (yield* invoke("workflow_status", { workflowId: started.workflowId })).structuredContent,
        );
        expect(ended.status).toBe("cancelled");
        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const slow = parent.subagents.filter((task) => task.prompt.startsWith("slow"));
        expect(slow).toHaveLength(2);
        for (const task of slow) {
          const child = yield* orchestrator.getThreadProjection(task.childThreadId!);
          expect(child.runs.at(-1)?.status).toBe("interrupted");
        }
        expect(
          parent.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
        ).toEqual([]);
        const refused = yield* invoke("workflow_stop", { workflowId: started.workflowId });
        expect(refused.isError).not.toBe(true);
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect("stopping the calling thread stops its workflow and the workflow's agents", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('return await agent("slow")');
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const member = yield* orchestrator
        .streamStoredEventsFrom({
          threadId: parentThreadId,
          afterSequence: 0,
          eventType: "subagent.updated",
        })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.prompt === "slow" &&
              stored.event.payload.childThreadId !== null,
          ),
          Stream.runHead,
        );
      const commandId = CommandId.make("command:stop-workflow-caller");
      yield* orchestrator.dispatch({ type: "thread.stop", commandId, threadId: parentThreadId });
      yield* threads.stopDelegatedTasks({ threadId: parentThreadId, commandId });
      // The caller's own turn stopped too, so its MCP calls are refused; read the row.
      const workflow = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (task) => task.id === started.workflowId,
      );
      expect(workflow).toMatchObject({ status: "cancelled", result: "Workflow stopped." });
      const event = Option.getOrThrow(member).event;
      const childThreadId = event.type === "subagent.updated" ? event.payload.childThreadId! : null;
      expect((yield* orchestrator.getThreadProjection(childThreadId!)).runs.at(-1)?.status).toBe(
        "interrupted",
      );
    }).pipe(Effect.provide(layerTest)),
  );
});

/** Waits for the workflow's `count`-th agent task, in start order. */
const awaitMember = (workflowId: string, count: number) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const seen: Array<OrchestrationV2Subagent> = [];
    yield* orchestrator
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: 0,
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.filter((stored) => {
          if (stored.event.type !== "subagent.updated") return false;
          const task = stored.event.payload;
          if (task.parentNodeId !== workflowId || task.childThreadId === null) return false;
          if (!seen.some((known) => known.id === task.id)) seen.push(task);
          return seen.length >= count;
        }),
        Stream.runHead,
      );
    return seen[count - 1]!;
  });

/** Runs `use` against a fresh workflow service, then shuts it down as a server stop would. */
const withServerProcess = <A, E, R>(
  use: (
    service: OrchestratorMcpService.OrchestratorMcpService["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(Layer.fresh(OrchestratorMcpService.layer));
      return yield* use(Context.get(context, OrchestratorMcpService.OrchestratorMcpService));
    }),
  );

const twoStepScript =
  'const first = await agent("first")\nconst second = await agent("second after " + first)\nreturn [first, second]';

describe("workflow resume", () => {
  it.effect.each([
    { status: "failed", runStatus: "completed", restart: false, legacy: false, tokens: 17 },
    { status: "failed", runStatus: "failed", restart: true, legacy: true, tokens: 17 },
    { status: "cancelled", runStatus: "cancelled", restart: true, legacy: true, tokens: undefined },
  ] as const)(
    "settles orphan turns for $status tasks (restart=$restart, legacy=$legacy)",
    (scenario) =>
      Effect.gen(function* () {
        yield* startParent;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const orphan = Effect.fn("test.orphanTurn")(function* (workflowId: NodeId) {
          const member = yield* awaitMember(workflowId, 1);
          const run = (yield* orchestrator.getThreadProjection(member.childThreadId!)).runs.at(-1)!;
          const start = DateTime.makeUnsafe(1000);
          const end = DateTime.makeUnsafe(4001);
          const { delegatedTaskId: _taskId, ...legacyRun } = run;
          yield* sink.commitCommand({
            commandId: CommandId.make("command:orphan-turn"),
            threadId: member.childThreadId!,
            commandType: "test.orphan-turn",
            acceptedAt: end,
            effects: [],
            events: [
              {
                id: EventId.make("event:orphan-turn"),
                type: "provider-turn.updated",
                threadId: member.childThreadId!,
                runId: run.id,
                occurredAt: start,
                payload: {
                  id: ProviderTurnId.make("provider-turn:orphan"),
                  providerThreadId: run.providerThreadId!,
                  nodeId: run.rootNodeId!,
                  runAttemptId: run.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "running",
                  startedAt: start,
                  completedAt: null,
                  ...(scenario.tokens === undefined
                    ? {}
                    : {
                        // Even a provider's complete counter cannot finalize an open turn.
                        turnTokenUsage: {
                          usageStatus: "complete" as const,
                          usageScope: "main_agent" as const,
                          hasSubagents: false,
                          inputTokens: scenario.tokens,
                          outputTokens: 0,
                        },
                      }),
                },
              },
              {
                id: EventId.make("event:orphan-run-end"),
                type: "run.updated",
                threadId: member.childThreadId!,
                runId: run.id,
                occurredAt: end,
                payload: {
                  ...(scenario.legacy ? legacyRun : run),
                  status: scenario.runStatus,
                  startedAt: start,
                  completedAt: end,
                },
              },
              ...(!scenario.legacy
                ? [
                    {
                      id: EventId.make("event:unrelated-run"),
                      type: "run.updated" as const,
                      threadId: member.childThreadId!,
                      runId: RunId.make("run:unrelated"),
                      occurredAt: start,
                      payload: {
                        ...run,
                        id: RunId.make("run:unrelated"),
                        ordinal: 2,
                        delegatedTaskId: NodeId.make("task:unrelated"),
                        activeAttemptId: RunAttemptId.make("attempt:unrelated"),
                        rootNodeId: NodeId.make("node:unrelated"),
                        status: "running" as const,
                        startedAt: start,
                        completedAt: null,
                      },
                    },
                    {
                      id: EventId.make("event:unrelated-turn"),
                      type: "provider-turn.updated" as const,
                      threadId: member.childThreadId!,
                      runId: RunId.make("run:unrelated"),
                      occurredAt: start,
                      payload: {
                        id: ProviderTurnId.make("provider-turn:unrelated"),
                        providerThreadId: run.providerThreadId!,
                        nodeId: NodeId.make("node:unrelated"),
                        runAttemptId: RunAttemptId.make("attempt:unrelated"),
                        nativeTurnRef: null,
                        ordinal: 2,
                        status: "running" as const,
                        startedAt: start,
                        completedAt: null,
                        turnTokenUsage: {
                          usageStatus: "complete" as const,
                          usageScope: "main_agent" as const,
                          hasSubagents: false,
                          inputTokens: 999,
                          outputTokens: 0,
                        },
                      },
                    },
                  ]
                : []),
              {
                id: EventId.make("event:orphan-task-end"),
                type: "subagent.updated",
                threadId: parentThreadId,
                runId: member.runId!,
                occurredAt: end,
                payload: {
                  ...member,
                  status: scenario.status,
                  result: "provider stopped",
                  completedAt: end,
                  updatedAt: end,
                },
              },
            ],
          });
          return member;
        });
        const finish = Effect.fn("test.finishOrphanWorkflow")(function* (workflowId: NodeId) {
          if (scenario.status === "failed") {
            const retry = yield* awaitMember(workflowId, 2);
            yield* completeChild(retry.childThreadId!, "recovered", { status: "completed" }, 23);
          }
          const ended = yield* awaitWorkflowEnd(workflowId);
          expect(JSON.parse(ended.result!)).toBe(scenario.status === "failed" ? "recovered" : null);
          expect(ended.usage).toMatchObject({
            status: scenario.tokens === undefined ? "unavailable" : "partial",
            totalTokens: scenario.tokens === undefined ? null : 40,
          });
          const worker = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === workflowId,
          )!.workflow!.agents[0]!;
          expect(worker.attemptHistory?.[0]).toMatchObject({
            state: scenario.status,
            durationMs: 3001,
            timingComplete: true,
            usageStatus: scenario.tokens === undefined ? "unavailable" : "partial",
          });
          expect(worker.attemptHistory?.[0]?.totalTokens).toBe(scenario.tokens);
          expect(worker.attemptTaskIds).toHaveLength(scenario.status === "failed" ? 2 : 1);
        });
        if (scenario.restart) {
          const workflowId = yield* withServerProcess((service) =>
            Effect.gen(function* () {
              const started = yield* service.workflowStart(invocation, {
                script: 'return await agent("orphan")',
              });
              yield* awaitMember(started.workflowId, 1);
              return started.workflowId;
            }),
          );
          // No service is observing when these terminal legacy records arrive.
          yield* orphan(workflowId);
          yield* withServerProcess((service) =>
            Effect.gen(function* () {
              expect(yield* service.resumeWorkflows).toBe(1);
              yield* finish(workflowId);
            }),
          );
        } else {
          const started = yield* startWorkflow('return await agent("orphan")');
          yield* orphan(started.workflowId);
          yield* finish(started.workflowId);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("settles terminal tasks after late run and usage completion across replay", () =>
    Effect.gen(function* () {
      yield* startParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const terminalBeforeRun = Effect.fn("test.terminalBeforeRun")(function* (
        workflowId: NodeId,
        member: OrchestrationV2Subagent,
        status: "failed" | "completed",
        startedAt: number,
      ) {
        const run = (yield* orchestrator.getThreadProjection(member.childThreadId!)).runs.at(-1)!;
        const now = DateTime.makeUnsafe(startedAt);
        yield* sink.commitCommand({
          commandId: CommandId.make(`command:early-task:${member.id}`),
          threadId: member.childThreadId!,
          commandType: "test.early-task",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make(`event:open-run:${member.id}`),
              type: "run.updated",
              threadId: member.childThreadId!,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "running", startedAt: now, completedAt: null },
            },
            {
              id: EventId.make(`event:early-task:${member.id}`),
              type: "subagent.updated",
              threadId: parentThreadId,
              runId: member.runId!,
              occurredAt: now,
              payload: {
                ...member,
                status,
                result: "early result",
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        // The runner has consumed the terminal task while the run is still open.
        yield* orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: 0,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                (stored.event.type === "subagent.updated" ||
                  stored.event.type === "workflow.updated") &&
                stored.event.payload.id === workflowId &&
                ((stored.event.type === "workflow.updated"
                  ? stored.event.payload.patch?.agents
                  : stored.event.payload.workflow?.agents
                )?.some((agent) =>
                  agent.attemptHistory?.some(
                    (attempt) => attempt.taskId === member.id && attempt.state === status,
                  ),
                ) ??
                  false),
            ),
            Stream.runHead,
          );
      });
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, {
            script: 'return await agent("retry")',
          });
          const first = yield* awaitMember(started.workflowId, 1);
          yield* terminalBeforeRun(started.workflowId, first, "failed", 1000);
          return started.workflowId;
        }),
      );
      // Shutdown interrupted the settlement wait. Replay must read the persisted open run.
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          yield* service.resumeWorkflows;
          const first = yield* awaitMember(workflowId, 1);
          yield* completeChild(
            first.childThreadId!,
            "failed",
            {
              status: "failed",
              startedAt: DateTime.makeUnsafe(1000),
              completedAt: DateTime.makeUnsafe(4001),
            },
            30,
          );
          const second = yield* awaitMember(workflowId, 2);
          yield* terminalBeforeRun(workflowId, second, "completed", 10000);
          yield* completeChild(
            second.childThreadId!,
            "done",
            {
              startedAt: DateTime.makeUnsafe(10000),
              completedAt: DateTime.makeUnsafe(14590),
            },
            70,
          );
          yield* awaitWorkflowEnd(workflowId);
        }),
      );
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const worker = parent.subagents.find((task) => task.id === workflowId)!.workflow!.agents[0]!;
      expect(
        worker.attemptHistory?.map((attempt) => [
          attempt.durationMs,
          attempt.timingComplete,
          attempt.totalTokens,
        ]),
      ).toEqual([
        [3001, true, 30],
        [4590, true, 70],
      ]);
      expect(worker.attemptHistory?.reduce((sum, attempt) => sum + attempt.durationMs!, 0)).toBe(
        7591,
      );
      expect(worker.totalTokens).toBe(100);
      expect(new Set(worker.attemptTaskIds).size).toBe(2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("observes run start and retains late usage while execution is open", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('return await agent("late usage")');
      const member = yield* awaitMember(started.workflowId, 1);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const run = (yield* orchestrator.getThreadProjection(member.childThreadId!)).runs.at(-1)!;
      const start = DateTime.makeUnsafe(1000);
      const end = DateTime.makeUnsafe(4001);
      const turn = {
        id: ProviderTurnId.make("provider-turn:late-usage"),
        providerThreadId: run.providerThreadId!,
        nodeId: run.rootNodeId!,
        runAttemptId: run.activeAttemptId,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: start,
        completedAt: null,
        turnTokenUsage: {
          usageScope: "main_agent" as const,
          usageStatus: "partial" as const,
          hasSubagents: false,
          inputTokens: 10,
          outputTokens: 0,
        },
      };
      const awaitAttempt = (
        matches: (
          attempt: NonNullable<
            NonNullable<OrchestrationV2Subagent["workflow"]>["agents"][number]["attemptHistory"]
          >[number],
        ) => boolean,
      ) =>
        orchestrator
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence: 0,
          })
          .pipe(
            Stream.filter(
              (stored) =>
                (stored.event.type === "subagent.updated" ||
                  stored.event.type === "workflow.updated") &&
                stored.event.payload.id === started.workflowId &&
                ((stored.event.type === "workflow.updated"
                  ? stored.event.payload.patch?.agents
                  : stored.event.payload.workflow?.agents
                )?.some((agent) => agent.attemptHistory?.some(matches)) ??
                  false),
            ),
            Stream.runHead,
          );
      yield* sink.commitCommand({
        commandId: CommandId.make("command:late-usage:start"),
        threadId: member.childThreadId!,
        commandType: "test.run-start",
        acceptedAt: start,
        effects: [],
        events: [
          {
            id: EventId.make("event:late-usage:start"),
            type: "run.updated",
            threadId: member.childThreadId!,
            runId: run.id,
            occurredAt: start,
            payload: { ...run, status: "running", startedAt: start },
          },
          {
            id: EventId.make("event:late-usage:turn-start"),
            type: "provider-turn.updated",
            threadId: member.childThreadId!,
            runId: run.id,
            occurredAt: start,
            payload: turn,
          },
        ],
      });
      // No parent task update accompanies admission: the child run event must publish the clock anchor.
      yield* awaitAttempt((attempt) => attempt.activeStartedAt === 1000);
      yield* sink.commitCommand({
        commandId: CommandId.make("command:late-usage:task-end"),
        threadId: member.childThreadId!,
        commandType: "test.task-end",
        acceptedAt: end,
        effects: [],
        events: [
          {
            id: EventId.make("event:late-usage:task-end"),
            type: "subagent.updated",
            threadId: parentThreadId,
            runId: member.runId!,
            occurredAt: end,
            payload: {
              ...member,
              status: "completed",
              result: "done",
              completedAt: end,
              updatedAt: end,
            },
          },
        ],
      });
      yield* awaitAttempt(
        (attempt) => attempt.state === "completed" && attempt.usageStatus === "partial",
      );
      expect(
        (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === started.workflowId,
        )?.status,
      ).toBe("running");
      yield* sink.commitCommand({
        commandId: CommandId.make("command:late-usage:turn-end"),
        threadId: member.childThreadId!,
        commandType: "test.turn-end",
        acceptedAt: end,
        effects: [],
        events: [
          {
            id: EventId.make("event:late-usage:turn-end"),
            type: "provider-turn.updated",
            threadId: member.childThreadId!,
            runId: run.id,
            occurredAt: end,
            payload: {
              ...turn,
              status: "completed",
              completedAt: end,
              turnTokenUsage: { ...turn.turnTokenUsage, usageStatus: "complete", inputTokens: 20 },
            },
          },
        ],
      });
      // Adapters finalize usage before emitting the terminal that ends the run.
      yield* awaitAttempt((attempt) => attempt.totalTokens === 20 && !attempt.timingComplete);
      expect(
        (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === started.workflowId,
        )?.status,
      ).toBe("running");
      yield* sink.commitCommand({
        commandId: CommandId.make("command:late-usage:run-end"),
        threadId: member.childThreadId!,
        commandType: "test.run-end",
        acceptedAt: end,
        effects: [],
        events: [
          {
            id: EventId.make("event:late-usage:run-end"),
            type: "run.updated",
            threadId: member.childThreadId!,
            runId: run.id,
            occurredAt: end,
            payload: { ...run, status: "completed", startedAt: start, completedAt: end },
          },
        ],
      });
      yield* awaitWorkflowEnd(started.workflowId);
      const worker = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
        (task) => task.id === started.workflowId,
      )!.workflow!.agents[0]!;
      expect(worker.attemptHistory?.[0]).toMatchObject({
        durationMs: 3001,
        timingComplete: true,
        usageStatus: "complete",
        totalTokens: 20,
      });
      expect(worker.totalTokens).toBe(20);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("C4 preserves historical script inheritance despite a new configured default", () =>
    Effect.gen(function* () {
      yield* startParent;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        workflowPresets: {
          presets: [
            {
              id: "worker",
              name: "Worker",
              target: { providerInstanceId: claudeInstanceId, model: claudeModel },
            },
          ],
          defaultPresetId: "worker",
        },
      });
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      for (const [index, script] of [
        'return await agent("historical")',
        storedWorkflowScript('return await agent("historical")', {}),
      ].entries()) {
        const workflowId = NodeId.make(`workflow:historical-${index}`);
        yield* orchestrator.dispatch({
          type: "workflow.start",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:historical-${index}`),
          threadId: parentThreadId,
          runId: parent.runs.at(-1)!.id,
          workflowId,
          title: "Historical",
          script,
        });
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            expect(yield* service.resumeWorkflows).toBe(1);
            const member = yield* awaitMember(workflowId, 1);
            expect(member).toMatchObject({ providerInstanceId: instanceId, model });
            yield* completeChild(member.childThreadId!, "done");
            expect((yield* awaitWorkflowEnd(workflowId)).status).toBe("completed");
          }),
        );
      }
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "C4 retains a failed preset snapshot even if its model becomes available after restart",
    () => {
      const providers: ServerProvider[] = [provider, claudeProvider];
      return Effect.gen(function* () {
        yield* startParent;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          workflowPresets: {
            presets: [
              {
                id: "late",
                name: "Late",
                target: { providerInstanceId: instanceId, model: "late-model" },
              },
            ],
            defaultPresetId: "late",
          },
        });
        const workflowId = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            const started = yield* service.workflowStart(invocation, {
              script: `await agent("own", { target: { model: "${model}" } }); return await agent("late", { preset: "late" })`,
            });
            yield* awaitMember(started.workflowId, 1);
            return started.workflowId;
          }),
        );
        providers[0] = {
          ...provider,
          models: [
            ...provider.models,
            { slug: "late-model", name: "Late", isCustom: true, capabilities: null },
          ],
        };
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            expect(yield* service.resumeWorkflows).toBe(1);
            yield* answerWorkflowAgents((prompt) => (prompt === "late" ? "unexpected" : undefined));
            const own = yield* awaitMember(workflowId, 1);
            yield* completeChild(own.childThreadId!, "done");
            const ended = yield* awaitWorkflowEnd(workflowId);
            expect(ended.agents[1]?.result).toContain("Model late-model is not advertised");
            expect(
              (yield* childTasks).filter((task) => task.parentNodeId === workflowId),
            ).toHaveLength(1);
          }),
        );
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );
  it.effect("C4 snapshots preset definitions and the default across edit, delete and restart", () =>
    Effect.gen(function* () {
      yield* startParent;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        workflowPresets: {
          presets: [
            {
              id: "worker",
              name: "Worker",
              target: { providerInstanceId: claudeInstanceId, model: claudeModel, options: [] },
            },
          ],
          defaultPresetId: "worker",
        },
      });
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, {
            script:
              'await agent("first"); await agent("named", { preset: "worker" }); return await agent("default")',
          });
          const first = yield* awaitMember(started.workflowId, 1);
          expect(first).toMatchObject({ providerInstanceId: claudeInstanceId, model: claudeModel });
          yield* settings.updateSettings({
            workflowPresets: {
              presets: [
                { id: "worker", name: "Edited", target: { providerInstanceId: instanceId, model } },
              ],
              defaultPresetId: "worker",
            },
          });
          yield* completeChild(first.childThreadId!, "one");
          expect(yield* awaitMember(started.workflowId, 2)).toMatchObject({
            providerInstanceId: claudeInstanceId,
            model: claudeModel,
          });
          return started.workflowId;
        }),
      );
      yield* settings.updateSettings({ workflowPresets: { presets: [], defaultPresetId: null } });
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          const named = yield* awaitMember(workflowId, 2);
          yield* answerWorkflowAgents((prompt) =>
            prompt === "default" || prompt === "first" ? "three" : undefined,
          );
          yield* completeChild(named.childThreadId!, "two");
          const ended = yield* awaitWorkflowEnd(workflowId);
          expect(ended.agents[2]?.status).toBe("completed");
          const last = yield* awaitMember(workflowId, 3);
          expect(last).toMatchObject({ providerInstanceId: claudeInstanceId, model: claudeModel });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          expect(
            (yield* orchestrator.getThreadProjection(last.childThreadId!)).thread.modelSelection
              .options,
          ).toEqual([]);
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).thread.modelSelection,
          ).toEqual(modelSelection);
          expect(ended.status).toBe("completed");
        }),
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("C4 refuses a missing script preset without falling back to the worker target", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* decodeWorkflow(
        (yield* invoke("workflow_start", {
          workerTarget: { providerInstanceId: instanceId, model },
          script: 'return await agent("missing", { preset: "deleted" })',
        })).structuredContent,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.agents[0]?.result).toContain("Workflow preset deleted was not found.");
      expect(
        (yield* childTasks).filter((task) => task.parentNodeId === started.workflowId),
      ).toHaveLength(0);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("C3 freezes a model-omitted worker default across catalog reordering", () => {
    const providers: ServerProvider[] = [
      provider,
      {
        ...claudeProvider,
        models: [
          ...claudeProvider.models,
          {
            slug: "other-claude",
            name: "Other",
            isCustom: true,
            capabilities: null,
          },
        ],
      },
    ];
    return Effect.gen(function* () {
      yield* startParent;
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, {
            workerTarget: { providerInstanceId: claudeInstanceId },
            script: 'await agent("first"); await agent("second"); return await agent("third")',
          });
          const first = yield* awaitMember(started.workflowId, 1);
          expect(first.model).toBe(claudeModel);
          yield* completeChild(first.childThreadId!, "one");
          yield* awaitMember(started.workflowId, 2);
          return started.workflowId;
        }),
      );
      providers[1] = { ...providers[1]!, models: providers[1]!.models.toReversed() };
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          const second = yield* awaitMember(workflowId, 2);
          yield* completeChild(second.childThreadId!, "two");
          const third = yield* awaitMember(workflowId, 3);
          expect(third.providerInstanceId).toBe(claudeInstanceId);
          expect(third.model).toBe(claudeModel);
          yield* completeChild(third.childThreadId!, "three");
          expect((yield* awaitWorkflowEnd(workflowId)).status).toBe("completed");
        }),
      );
    }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
  });

  it.effect(
    "C3 defers a failed default until selected and retains its refusal after restart",
    () => {
      const providers: ServerProvider[] = [provider, claudeProvider];
      return Effect.gen(function* () {
        yield* startParent;
        const workflowId = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            const started = yield* service.workflowStart(invocation, {
              workerTarget: { model: "late-model" },
              script: `return [await agent("own", { target: { model: "${model}" } }), await agent("default")]`,
            });
            yield* awaitMember(started.workflowId, 1);
            return started.workflowId;
          }),
        );
        // Making the model available later must not replace the recorded refusal.
        providers[0] = {
          ...provider,
          models: [
            ...provider.models,
            {
              slug: "late-model",
              name: "Late",
              isCustom: true,
              capabilities: null,
            },
          ],
        };
        const ended = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            expect(yield* service.resumeWorkflows).toBe(1);
            yield* answerWorkflowAgents((prompt) =>
              prompt === "default" ? "unexpected" : undefined,
            );
            const own = yield* awaitMember(workflowId, 1);
            yield* completeChild(own.childThreadId!, "done");
            return yield* awaitWorkflowEnd(workflowId);
          }),
        );
        expect(JSON.parse(ended.result!)).toEqual(["done", null]);
        expect(ended.agents[1]?.result).toContain(
          `Model late-model is not advertised by provider ${instanceId}.`,
        );
        expect((yield* childTasks).filter((task) => task.parentNodeId === workflowId)).toHaveLength(
          1,
        );
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );
  it.effect("C3 resumes worker routing for new calls and preserves completed calls", () =>
    Effect.gen(function* () {
      yield* startParentWithSelection({
        ...modelSelection,
        options: [
          { id: "reasoningEffort", value: "medium" },
          { id: "serviceTier", value: "priority" },
        ],
      });
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, {
            script:
              'const first = await agent("first"); const second = await agent("second after " + first, { target: { options: { reasoningEffort: "high" } } }); return [first, second]',
            workerTarget: { options: [{ id: "reasoningEffort", value: "high" }] },
          });
          const first = yield* awaitMember(started.workflowId, 1);
          expect(first.providerInstanceId).toBe(instanceId);
          yield* completeChild(first.childThreadId!, "one");
          yield* awaitMember(started.workflowId, 2);
          return started.workflowId;
        }),
      );
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* orchestrator.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("command:change-caller"),
        threadId: parentThreadId,
        modelSelection: {
          instanceId,
          model: "other-model",
          options: [{ id: "new-option", value: true }],
        },
      });
      const second = yield* awaitMember(workflowId, 2);
      yield* completeChild(second.childThreadId!, "", {
        status: "cancelled",
        cancelledByServerRestart: true,
      });
      const ended = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          const retried = yield* awaitMember(workflowId, 3);
          expect(retried.prompt).toBe("second after one");
          expect(retried.providerInstanceId).toBe(instanceId);
          expect(retried.model).toBe(model);
          expect(
            (yield* orchestrator.getThreadProjection(retried.childThreadId!)).thread.modelSelection,
          ).toEqual({
            ...modelSelection,
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "priority" },
            ],
          });
          yield* completeChild(retried.childThreadId!, "two");
          return yield* awaitWorkflowEnd(workflowId);
        }),
      );
      expect(JSON.parse(ended.result!)).toEqual(["one", "two"]);
      const row = (yield* childTasks).find((task) => task.id === workflowId)!;
      expect(row.workflow!.agents.map((agent) => agent.attemptTaskIds!.length)).toEqual([1, 2]);
    }).pipe(
      Effect.provide(
        makeLayerTest(undefined, [
          {
            ...provider,
            models: [
              ...provider.models,
              { slug: "other-model", name: "Other", isCustom: true, capabilities: null },
            ],
          },
          claudeProvider,
        ]),
      ),
    ),
  );
  it.effect("resumes a running workflow after a restart without starting its agents twice", () =>
    Effect.gen(function* () {
      yield* startParent;
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, { script: twoStepScript });
          const first = yield* awaitMember(started.workflowId, 1);
          yield* completeChild(first.childThreadId!, "one", { status: "completed" }, [
            {
              usageStatus: "complete",
              usageScope: "main_agent",
              hasSubagents: false,
              inputTokens: 200,
              cachedInputTokens: 100,
              cacheCreationTokens: 0,
              outputTokens: 50,
            },
            {
              usageStatus: "complete",
              usageScope: "main_agent",
              hasSubagents: false,
              inputTokens: 300,
              cachedInputTokens: 150,
              cacheCreationTokens: 0,
              outputTokens: 50,
            },
          ]);
          yield* awaitMember(started.workflowId, 2);
          return started.workflowId;
        }),
      );
      const second = yield* awaitMember(workflowId, 2);
      // The resumed script re-attaches to the second agent instead of starting another.
      const resumed = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          yield* completeChild(second.childThreadId!, "two", { status: "completed" }, 900);
          return yield* awaitWorkflowEnd(workflowId);
        }),
      );
      expect(resumed.status).toBe("completed");
      expect(JSON.parse(resumed.result!)).toEqual(["one", "two"]);
      expect(resumed.usage).toMatchObject({
        status: "complete",
        inputTokens: 1400,
        cachedInputTokens: 700,
        uncachedInputTokens: 700,
        outputTokens: 100,
        totalTokens: 1500,
      });
      expect(resumed.agents.map((agent) => agent.usage.totalTokens)).toEqual([600, 900]);
      const reread = yield* withServerProcess((service) =>
        service.workflowStatus(invocation, { workflowId }),
      );
      expect(reread.usage).toEqual(resumed.usage);
      expect(reread.agents.map((agent) => agent.usage)).toEqual(
        resumed.agents.map((agent) => agent.usage),
      );
      expect(resumed.agents.map((agent) => agent.outcomeCategory)).toEqual([
        "completed",
        "completed",
      ]);
      const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        parentThreadId,
      );
      expect(parent.subagents.filter((task) => task.parentNodeId === workflowId)).toHaveLength(2);
      expect(
        parent.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
      ).toEqual([workflowId]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "starts again an agent that a server restart cancelled, but not one a user stopped",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const workflowId = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            const started = yield* service.workflowStart(invocation, { script: twoStepScript });
            return started.workflowId;
          }),
        );
        const first = yield* awaitMember(workflowId, 1);
        yield* completeChild(first.childThreadId!, "", {
          status: "cancelled",
          cancelledByServerRestart: true,
        });
        const ended = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            yield* service.resumeWorkflows;
            const retried = yield* awaitMember(workflowId, 2);
            expect(retried.prompt).toBe("first");
            yield* completeChild(retried.childThreadId!, "one");
            const second = yield* awaitMember(workflowId, 3);
            // A user's stop is a judgment the script sees, so it is not retried.
            yield* completeChild(second.childThreadId!, "", { status: "cancelled" });
            return yield* awaitWorkflowEnd(workflowId);
          }),
        );
        expect(ended.status).toBe("completed");
        expect(JSON.parse(ended.result!)).toEqual(["one", null]);
        expect(ended.agents.map((agent) => agent.status)).toEqual(["completed", "cancelled"]);
        expect(ended.agents.map((agent) => agent.outcomeCategory)).toEqual([
          "completed",
          "cancelled",
        ]);
        expect(ended.usage.status).toBe("unavailable");
        expect(ended.tokensUsed).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "replays persisted retry history without losing usage or duplicating child identity",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const workflowId = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            const started = yield* service.workflowStart(invocation, {
              script: 'return await agent("retry")',
            });
            const first = yield* awaitMember(started.workflowId, 1);
            yield* completeChild(first.childThreadId!, "failed", { status: "failed" }, 30);
            yield* awaitMember(started.workflowId, 2);
            return started.workflowId;
          }),
        );
        const second = yield* awaitMember(workflowId, 2);
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            expect(yield* service.resumeWorkflows).toBe(1);
            yield* completeChild(second.childThreadId!, "done", { status: "completed" }, 70);
            yield* awaitWorkflowEnd(workflowId);
          }),
        );
        const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        );
        const worker = parent.subagents.find((task) => task.id === workflowId)?.workflow?.agents[0];
        expect(worker?.totalTokens).toBe(100);
        expect(
          worker?.attemptHistory?.map((attempt) => [
            attempt.state,
            attempt.totalTokens,
            attempt.usageStatus,
          ]),
        ).toEqual([
          ["failed", 30, "complete"],
          ["completed", 70, "complete"],
        ]);
        expect(worker?.attemptHistory?.map((attempt) => attempt.taskId)).toEqual(
          worker?.attemptTaskIds,
        );
        expect(worker?.attemptHistory?.[1]?.childThreadId).toBe(second.childThreadId);
        expect(
          worker?.attemptHistory?.map((attempt) => [attempt.durationMs, attempt.timingComplete]),
        ).toEqual([
          [0, true],
          [0, true],
        ]);
        expect(parent.subagents.filter((task) => task.parentNodeId === workflowId)).toHaveLength(2);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("starts a failed agent again, up to three attempts in all", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('return await agent("flaky")');
      for (const attempt of [1, 2, 3]) {
        const member = yield* awaitMember(started.workflowId, attempt);
        yield* completeChild(member.childThreadId!, "", { status: "failed" });
      }
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toBeNull();
      expect(ended.agents[0]?.outcomeCategory).toBe("provider_error");
      expect(ended.usage.status).toBe("unavailable");
      const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        parentThreadId,
      );
      expect(
        parent.subagents.filter((task) => task.parentNodeId === started.workflowId),
      ).toHaveLength(3);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "reports an exhausted attempt deadline as timed_out after rereading persisted state",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const started = yield* startWorkflow(
          'return await agent("slow", { attemptTimeoutMs: 60000 })',
        );
        for (const attempt of [1, 2, 3]) {
          yield* awaitMember(started.workflowId, attempt);
          yield* TestClock.adjust("2 minutes");
        }
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(ended.agents[0]?.outcomeCategory).toBe("timed_out");
        const reread = yield* withServerProcess((service) =>
          service.workflowStatus(invocation, { workflowId: started.workflowId }),
        );
        expect(reread.agents[0]?.outcomeCategory).toBe("timed_out");
        expect(reread.usage.status).toBe("unavailable");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops an agent that records nothing for too long and starts it again", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("quiet", { stallTimeoutMs: 60000 })',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      yield* TestClock.adjust("2 minutes");
      const second = yield* awaitMember(started.workflowId, 2);
      expect(second.prompt).toBe("quiet");
      yield* completeChild(second.childThreadId!, "spoke");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toBe("spoke");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      expect(
        (yield* orchestrator.getThreadProjection(first.childThreadId!)).runs.at(-1)?.status,
      ).toBe("interrupted");
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "uses cumulative provider usage for the runner budget and persisted workflow totals",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents(() => "done", 250);
        const started = yield* startWorkflow('await agent("one"); return budget.spent');
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toBe(250);
        expect(ended.tokensUsed).toBe(250);
        // A pre-accounting server persisted context occupancy in the workflow row.
        // A restart must trust turn records rather than this obsolete derived counter.
        const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        );
        const workflow = parent.subagents.find((task) => task.id === started.workflowId)!;
        const now = yield* DateTime.now;
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("event:test-obsolete-workflow-counter"),
              type: "subagent.updated",
              threadId: parentThreadId,
              occurredAt: now,
              payload: {
                ...workflow,
                workflow: {
                  ...workflow.workflow!,
                  agents: workflow.workflow!.agents.map((agent) => {
                    const legacy = { ...agent, totalTokens: 7, attempt: 1 };
                    delete legacy.attemptTaskIds;
                    return legacy;
                  }),
                },
              },
            },
          ],
        });
        const reread = yield* withServerProcess((service) =>
          service.workflowStatus(invocation, { workflowId: started.workflowId }),
        );
        expect(reread.tokensUsed).toBe(250);
        expect(reread.agents[0]?.usage).toMatchObject({ status: "partial", totalTokens: 250 });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses new agents once finished agents spent the token budget", () =>
    Effect.gen(function* () {
      yield* startParent;
      const result = yield* invoke("workflow_start", {
        script:
          'const a = await agent("one")\nconst b = await agent("two")\nlet refused = null\ntry { await agent("three") } catch (error) { refused = error.message }\nreturn { a, b, refused, remaining: budget.remaining() }',
        budgetTokens: 1500,
      });
      const started = yield* decodeWorkflow(result.structuredContent);
      expect(started.budgetTokens).toBe(1500);
      const one = yield* awaitMember(started.workflowId, 1);
      expect(
        (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(one.childThreadId!)).thread
          .lineage.workflowId,
      ).toBe(started.workflowId);
      yield* completeChild(one.childThreadId!, "1", { status: "completed" }, [
        {
          usageStatus: "complete",
          usageScope: "main_agent",
          hasSubagents: false,
          inputTokens: 800,
          cachedInputTokens: 600,
          cacheCreationTokens: 0,
          outputTokens: 200,
        },
      ]);
      const two = yield* awaitMember(started.workflowId, 2);
      yield* completeChild(two.childThreadId!, "2", { status: "completed" }, 800);
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toEqual({
        a: "1",
        b: "2",
        refused:
          "The workflow's budget of 1500 tokens is spent (1800 recorded). New agents will not start; already-running agents may exceed this budget.",
        remaining: 0,
      });
      expect(ended.tokensUsed).toBe(1800);
      expect(ended.usage).toMatchObject({
        status: "complete",
        inputTokens: 1600,
        outputTokens: 200,
      });
      expect(ended.agents.map((agent) => agent.outcomeCategory)).toEqual([
        "completed",
        "completed",
        "never_started",
      ]);
      expect(ended.agents[0]?.timings).toMatchObject({
        createdAt: expect.any(Number),
        runStartedAt: expect.any(Number),
        providerTurnStartedAt: expect.any(Number),
        providerTurnEndedAt: expect.any(Number),
        completedAt: expect.any(Number),
        runnerSettledAt: expect.any(Number),
      });
      expect(ended.agents.map((agent) => agent.status)).toEqual([
        "completed",
        "completed",
        "failed",
      ]);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("gives each agent asked for a worktree its own checkout", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) => `done ${prompt}`);
      const started = yield* startWorkflow(
        'return await parallel([1, 2].map((n) => () => agent("edit " + n, { isolation: "worktree" })))',
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toEqual(["done edit 1", "done edit 2"]);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // Each child thread prepares its own checkout of the parent's commit.
      expect(new Set(ended.agents.map((agent) => agent.childThreadId)).size).toBe(2);
      for (const agent of ended.agents) {
        const child = yield* orchestrator.getThreadProjection(agent.childThreadId!);
        expect(child.runs[0]?.workspacePreparation).toMatchObject({
          type: "worktree",
          baseRef: "0123456789abcdef",
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );
});

// Declared files live in the test project's checkout, the working directory, under a scratch folder.
const withScratchDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) => {
  const dir = `.t3-workflow-files-${NodeCrypto.randomUUID()}`;
  NodeFS.mkdirSync(dir);
  return use(dir).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
  );
};

describe("workflow checks", () => {
  const retried = (prompt: string) => prompt.includes("did not pass its");

  it.effect(
    "starts an agent again with what a failed structured check saw, then returns the passing result",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) =>
          retried(prompt)
            ? 'Recounted.\n```json\n{"count": 3}\n```'
            : 'Counted.\n```json\n{"count": 2}\n```',
        );
        const started = yield* startWorkflow(
          'return await agent("count", { schema: { type: "object", required: ["count"] }, verify: { type: "structured", equals: { "/count": 3 } } })',
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toEqual({ count: 3 });
        expect(ended.agents[0]?.verification).toMatchObject({
          type: "structured",
          outcome: "passed",
          attempts: 2,
        });
        const retry = yield* awaitMember(started.workflowId, 2);
        expect(retry.prompt).toContain("/count is 2, expected 3");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "runs a process check on the result without a shell, and fails the agent after its attempts",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) => (prompt.startsWith("good") ? "ok" : "nope"));
        const check = (word: string) =>
          JSON.stringify({
            type: "process",
            argv: [
              process.execPath,
              "-e",
              "process.exit(require('fs').readFileSync(process.argv[1], 'utf8') === process.argv[2] ? 0 : 3)",
              "{{result}}",
              word,
            ],
          });
        const started = yield* startWorkflow(
          `return [await agent("good", { verify: ${check("ok")} }), await agent("bad", { verify: ${check("ok")} })]`,
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toEqual(["ok", null]);
        expect(ended.agents.map((agent) => agent.verification?.outcome)).toEqual([
          "passed",
          "failed",
        ]);
        expect(ended.agents[1]).toMatchObject({
          status: "failed",
          outcomeCategory: "check_failed",
          verification: { attempts: 3 },
        });
        expect(ended.agents[1]?.verification?.detail).toContain("exit code 3");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "does not run a process check once the calling thread left full access after the worker finished",
    () =>
      withScratchDir((dir) =>
        Effect.gen(function* () {
          yield* startParent;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const marker = NodePath.join(dir, "check-ran.txt");
          const lowered = new Set<string>();
          // The user lowers the thread's mode while the worker finishes, after workflow_start's
          // own check but before the runner starts the process check.
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: 0,
              eventType: "subagent.updated",
            })
            .pipe(
              Stream.runForEach((stored) =>
                Effect.gen(function* () {
                  if (stored.event.type !== "subagent.updated") return;
                  const task = stored.event.payload;
                  if (
                    task.childThreadId === null ||
                    task.status !== "running" ||
                    lowered.has(task.id) ||
                    !String(task.parentNodeId).startsWith("workflow:")
                  )
                    return;
                  lowered.add(task.id);
                  yield* orchestrator.dispatch({
                    type: "thread.runtime-mode.set",
                    commandId: CommandId.make(`command:lower-mode:${task.id}`),
                    threadId: parentThreadId,
                    runtimeMode: "approval-required",
                  });
                  yield* completeChild(task.childThreadId, "ok", { status: "completed" });
                }),
              ),
              Effect.forkChild,
            );
          const check = JSON.stringify({
            type: "process",
            argv: [
              process.execPath,
              "-e",
              "require('fs').writeFileSync(process.argv[1], 'ran')",
              marker,
            ],
          });
          const started = yield* startWorkflow(`return await agent("work", { verify: ${check} })`);
          const ended = yield* awaitWorkflowEnd(started.workflowId);
          expect(NodeFS.existsSync(marker)).toBe(false);
          expect(JSON.parse(ended.result!)).toBeNull();
          expect(ended.agents[0]).toMatchObject({
            status: "failed",
            verification: { type: "process", outcome: "error", attempts: 1 },
          });
          expect(ended.agents[0]?.verification?.detail).toContain("approval-required");
        }).pipe(Effect.provide(layerTest)),
      ),
  );

  it.effect("has a separate agent judge the result against a rubric", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) => {
        if (!prompt.includes("independent checker"))
          return retried(prompt) ? "a haiku" : "a limerick";
        const passed = prompt.includes('<t3-result v="1">\na haiku\n</t3-result>');
        return `Checked.\n\`\`\`json\n${JSON.stringify({ outcome: passed ? "passed" : "failed", reasons: passed ? "It is a haiku." : "It is not a haiku." })}\n\`\`\``;
      }, 400);
      const started = yield* startWorkflow(
        'return await agent("write a poem", { label: "poem", verify: { type: "judgment", rubric: ["The poem is a haiku."] } })',
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toBe("a haiku");
      expect(ended.usage).toMatchObject({
        status: "complete",
        inputTokens: 1600,
        cachedInputTokens: 800,
        uncachedInputTokens: 800,
        outputTokens: 0,
        totalTokens: 1600,
      });
      expect(ended.agents.map((agent) => agent.usage.totalTokens)).toEqual([800, 400, 400]);
      expect(ended.agents.map((agent) => agent.label)).toEqual([
        "poem",
        "check poem",
        "check poem",
      ]);
      expect(ended.agents[0]?.verification).toMatchObject({
        type: "judgment",
        outcome: "passed",
        attempts: 2,
        detail: "It is a haiku.",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("never runs two agents that write the same files at once", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await parallel([() => agent("one", { scopes: { write: ["src"] } }), () => agent("two", { scopes: { write: ["./src/a.ts"] } })])',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      expect(first.prompt).toContain("Change files only within: src");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const running = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
        (task) => task.parentNodeId === started.workflowId,
      );
      expect(running).toHaveLength(1);
      yield* completeChild(first.childThreadId!, "1");
      const second = yield* awaitMember(started.workflowId, 2);
      expect(second.prompt).toContain("Change files only within: src/a.ts");
      yield* completeChild(second.childThreadId!, "2");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toEqual(["1", "2"]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "checks declared outputs, retries an agent that did not write them, and returns their hashes",
    () =>
      withScratchDir((dir) =>
        Effect.gen(function* () {
          yield* startParent;
          NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
          const inputSha = NodeCrypto.createHash("sha256").update("source").digest("hex");
          const outputPath = NodePath.join(dir, "out.txt");
          yield* answerWorkflowAgents((prompt) => {
            if (!retried(prompt)) return "skipped";
            NodeFS.writeFileSync(outputPath, "hello");
            return "wrote it";
          });
          const options = JSON.stringify({
            inputs: [{ id: "source", path: `${dir}/in.txt`, sha256: inputSha }],
            outputs: [{ id: "report", path: `${dir}/out.txt`, maxBytes: 100 }],
            verify: {
              type: "process",
              argv: [
                process.execPath,
                "-e",
                "process.exit(require('fs').readFileSync(process.argv[1], 'utf8') === 'hello' ? 0 : 3)",
                "{{output:report}}",
              ],
            },
          });
          const started = yield* startWorkflow(`return await agent("summarize", ${options})`);
          const ended = yield* awaitWorkflowEnd(started.workflowId);
          expect(JSON.parse(ended.result!)).toEqual({
            result: "wrote it",
            outputs: {
              report: {
                path: `${dir}/out.txt`,
                sha256: NodeCrypto.createHash("sha256").update("hello").digest("hex"),
                sizeBytes: 5,
              },
            },
          });
          expect(ended.agents[0]?.verification).toMatchObject({
            type: "process",
            outcome: "passed",
            attempts: 2,
          });
          const first = yield* awaitMember(started.workflowId, 1);
          expect(first.prompt).toContain(
            `<input id="source" path="${dir}/in.txt" sha256="${inputSha}" maxBytes="262144" />`,
          );
          expect(first.prompt).toContain(`- report: ${dir}/out.txt (at most 100 bytes)`);
          const retry = yield* awaitMember(started.workflowId, 2);
          expect(retry.prompt).toContain("did not pass its outputs check");
          expect(retry.prompt).toContain("was not written");
        }).pipe(Effect.provide(layerTest)),
      ),
  );

  it.effect(
    "fails an agent whose pinned input changed, and one given declared files in a worktree",
    () =>
      withScratchDir((dir) =>
        Effect.gen(function* () {
          yield* startParent;
          NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "edited");
          const pinned = JSON.stringify({
            inputs: [{ id: "source", path: `${dir}/in.txt`, sha256: "0".repeat(64) }],
          });
          const isolated = JSON.stringify({
            outputs: [{ id: "report", path: `${dir}/out.txt` }],
            isolation: "worktree",
          });
          const started = yield* startWorkflow(
            `return [await agent("a", ${pinned}), await agent("b", ${isolated})]`,
          );
          const ended = yield* awaitWorkflowEnd(started.workflowId);
          expect(JSON.parse(ended.result!)).toEqual([null, null]);
          expect(ended.agents[0]).toMatchObject({ status: "failed", taskId: null });
          expect(ended.agents[0]?.result).toContain(`changed: expected sha256 ${"0".repeat(64)}`);
          expect(ended.agents[1]).toMatchObject({ status: "failed", taskId: null });
          expect(ended.agents[1]?.result).toContain("need the shared checkout");
        }).pipe(Effect.provide(layerTest)),
      ),
  );

  it.effect(
    "moves on once a member's turn completes, without waiting for its checkpoint capture",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const started = yield* startWorkflow('return await agent("summarize the notes")');
        const member = yield* awaitMember(started.workflowId, 1);
        // "waiting" is how a completed turn persists until its checkpoint capture lands.
        yield* completeChild(member.childThreadId!, "the notes say hello", { status: "waiting" });
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(ended.status).toBe("completed");
        expect(JSON.parse(ended.result!)).toBe("the notes say hello");
        expect(ended.agents[0]).toMatchObject({ status: "completed" });
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const child = yield* orchestrator.getThreadProjection(member.childThreadId!);
        expect(child.runs.at(-1)?.status).toBe("waiting");

        // An ordinary delegated task still reports running until its capture lands.
        const delegated = yield* decodeStarted(
          (yield* invoke("delegate_tasks", { tasks: [{ task: "Count the files." }] }))
            .structuredContent,
        );
        yield* completeChild(delegated.tasks[0]!.childThreadId, "3 files", { status: "waiting" });
        const status = (yield* invoke("task_status", { taskId: delegated.tasks[0]!.taskId }))
          .structuredContent as { readonly status: string };
        expect(status.status).toBe("running");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects a malformed check before starting the agent", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("x", { verify: { type: "process", argv: ["node"], cwd: "../outside" } })',
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.agents[0]).toMatchObject({ status: "failed", taskId: null });
      expect(ended.agents[0]?.result).toContain("must stay inside the workspace");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops an attempt past attemptTimeoutMs and starts it again", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("slow", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000 })',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      yield* TestClock.adjust("2 minutes");
      const second = yield* awaitMember(started.workflowId, 2);
      expect(second.prompt).toContain("passed its time budget of 60000 ms");
      yield* completeChild(second.childThreadId!, "in time");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toBe("in time");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      expect(
        (yield* orchestrator.getThreadProjection(first.childThreadId!)).runs.at(-1)?.status,
      ).toBe("interrupted");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops an attempt past its deadline although its stop command id was rejected", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("slow", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000 })',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      // A failed decide under this id stored a rejection, which would answer every later stop.
      yield* spendCommandId(`command:workflow-stall:${first.id}`);
      yield* TestClock.adjust("2 minutes");
      const second = yield* awaitMember(started.workflowId, 2);
      expect(second.prompt).toContain("passed its time budget of 60000 ms");
      yield* completeChild(second.childThreadId!, "in time");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toBe("in time");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      expect(
        (yield* orchestrator.getThreadProjection(first.childThreadId!)).runs.at(-1)?.status,
      ).toBe("interrupted");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("records a finished script's completion although its command id was rejected", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('return await agent("work")');
      // As after a restart: an earlier process stored a rejection under the completion's id.
      yield* spendCommandId(`command:workflow-complete:${started.workflowId}`);
      const member = yield* awaitMember(started.workflowId, 1);
      yield* completeChild(member.childThreadId!, "done");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("completed");
      expect(JSON.parse(ended.result!)).toBe("done");
    }).pipe(Effect.provide(layerTest)),
  );
});

/**
 * Stores a rejection under `commandId` the way a failed decide does: a stop for a thread that does
 * not exist fails while deciding, and the dispatcher keeps that refusal for the id from then on.
 */
const spendCommandId = (commandId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const command = {
      type: "thread.stop" as const,
      commandId: CommandId.make(commandId),
      threadId: ThreadId.make("thread:spent-command-id"),
    };
    yield* Effect.flip(orchestrator.dispatch(command));
    const again = yield* Effect.flip(orchestrator.dispatch(command));
    expect(again._tag).toBe("OrchestratorCommandPreviouslyRejectedError");
  });

const decodeReview = Schema.decodeUnknownEffect(OrchestratorMcpGraphReviewResult);
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const reviewGraph = (graph: unknown) =>
  Effect.gen(function* () {
    const result = yield* invoke("graph_review", { graph });
    expect(result.isError).not.toBe(true);
    return yield* decodeReview(result.structuredContent);
  });

/** A producer that writes a JSON output from a pinned input, and a consumer of that output. */
const serialGraph = (dir: string) => ({
  schemaVersion: 1,
  name: "Serial",
  nodes: {
    produce: {
      subject: "Produce",
      description: "produce the total",
      dependsOn: [],
      inputs: [{ id: "source", kind: "workspace_snapshot", path: `${dir}/in.txt` }],
      outputs: [{ id: "total", path: `${dir}/total.json`, maxBytes: 100 }],
      verify: { type: "structured", outputId: "total", requiredPointers: ["/total"] },
    },
    consume: {
      subject: "Consume",
      description: "consume the total",
      dependsOn: ["produce"],
      inputs: [{ id: "upstream", kind: "task_output", nodeId: "produce", outputId: "total" }],
    },
  },
});

describe("graphs", () => {
  it.effect(
    "C4 expands preset graphs before digest and starts the approved graph after edits and restart",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const settings = yield* ServerSettings.ServerSettingsService;
        const target = { providerInstanceId: claudeInstanceId, model: claudeModel, options: [] };
        yield* settings.updateSettings({
          workflowPresets: {
            presets: [{ id: "reviewer", name: "Reviewer", target }],
            defaultPresetId: "reviewer",
          },
        });
        const node = { subject: "worker", description: "work", dependsOn: [], preset: "reviewer" };
        const graph = { schemaVersion: 1, nodes: { a: node } };
        const reviewed = yield* withServerProcess((service) =>
          service.graphReview(invocation, { graph }),
        );
        expect(reviewed.ready).toBe(true);
        expect(reviewed.targets).toMatchObject([{ source: "preset", target }]);
        expect(reviewed.expandedGraph).toMatchObject({ nodes: { a: { target } } });
        expect(JSON.stringify(reviewed.expandedGraph)).not.toContain('"preset"');
        yield* settings.updateSettings({
          workflowPresets: {
            presets: [
              {
                id: "reviewer",
                name: "Changed",
                target: { providerInstanceId: instanceId, model },
              },
            ],
            defaultPresetId: "reviewer",
          },
        });
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            const equivalent = yield* service.graphReview(invocation, {
              graph: reviewed.expandedGraph,
            });
            expect(equivalent.digest).toBe(reviewed.digest);
            const stale = yield* service
              .graphStart(invocation, { graph, acceptedDigest: reviewed.digest! })
              .pipe(Effect.flip);
            expect(stale.message).toContain("graph");
            yield* settings.updateSettings({
              workflowPresets: { presets: [], defaultPresetId: null },
            });
            const started = yield* service.graphStart(invocation, {
              graph: reviewed.expandedGraph,
              acceptedDigest: reviewed.digest!,
            });
            const worker = yield* awaitMember(started.workflowId, 1);
            expect(worker).toMatchObject({
              providerInstanceId: claudeInstanceId,
              model: claudeModel,
            });
            yield* completeChild(worker.childThreadId!, "done");
            expect((yield* awaitWorkflowEnd(started.workflowId)).status).toBe("completed");
          }),
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("C4 applies every precedence branch and refuses missing graph presets", () =>
    Effect.gen(function* () {
      yield* startParent;
      const settings = yield* ServerSettings.ServerSettingsService;
      const presetTarget = {
        providerInstanceId: claudeInstanceId,
        model: claudeModel,
        options: [],
      };
      yield* settings.updateSettings({
        workflowPresets: {
          presets: [{ id: "worker", name: "Worker", target: presetTarget }],
          defaultPresetId: "worker",
        },
      });
      const node = { subject: "worker", description: "work", dependsOn: [] };
      for (const [own, workerTarget, source, expectedProvider] of [
        [{ target: {}, preset: "missing" }, presetTarget, "target", instanceId],
        [{ model, preset: "missing" }, presetTarget, "model", instanceId],
        [{ preset: "worker" }, { model }, "preset", claudeInstanceId],
        [{}, { model }, "workerTarget", instanceId],
        [{}, undefined, "defaultPreset", claudeInstanceId],
      ] as const) {
        const reviewed = yield* decodeReview(
          (yield* invoke("graph_review", {
            graph: { schemaVersion: 1, nodes: { a: { ...node, ...own } } },
            ...(workerTarget === undefined ? {} : { workerTarget }),
          })).structuredContent,
        );
        expect(reviewed.ready).toBe(true);
        expect(reviewed.targets[0]).toMatchObject({
          source,
          target: { providerInstanceId: expectedProvider },
        });
      }
      const missing = yield* reviewGraph({
        schemaVersion: 1,
        nodes: { a: { ...node, preset: "missing" } },
      });
      expect(missing).toMatchObject({ ready: false, digest: null, expandedGraph: null });
      expect(missing.blockers).toContain("a: Workflow preset missing was not found.");
      yield* settings.updateSettings({ workflowPresets: { presets: [], defaultPresetId: null } });
      expect(
        (yield* reviewGraph({ schemaVersion: 1, nodes: { a: node } })).targets[0],
      ).toMatchObject({ source: "caller", target: { providerInstanceId: instanceId, model } });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("C3 refuses an inherited model absent from an empty provider catalog", () =>
    Effect.gen(function* () {
      yield* startParent;
      const reviewed = yield* reviewGraph({
        schemaVersion: 1,
        nodes: {
          a: { subject: "worker", description: "work", dependsOn: [] },
        },
      });
      expect(reviewed.ready).toBe(false);
      expect(reviewed.blockers).toEqual([
        `a: Model ${model} is not advertised by provider ${instanceId}.`,
      ]);
      expect(yield* childTasks).toEqual([]);
    }).pipe(Effect.provide(makeLayerTest(undefined, [{ ...provider, models: [] }]))),
  );

  it.effect("C3 keeps exact reviewed options after caller changes and graph restart", () =>
    Effect.gen(function* () {
      yield* startParentWithSelection({
        ...modelSelection,
        options: [{ id: "serviceTier", value: "priority" }],
      });
      const graph = {
        schemaVersion: 1,
        nodes: {
          a: { subject: "first", description: "first", dependsOn: [] },
          b: {
            subject: "second",
            description: "second",
            dependsOn: ["a"],
            verify: { type: "judgment", rubric: ["correct"] },
          },
        },
      };
      const workerTarget = { options: [{ id: "reasoningEffort", value: "high" }] };
      const expected = {
        ...modelSelection,
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "serviceTier", value: "priority" },
        ],
      };
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const reviewed = yield* service.graphReview(invocation, { graph, workerTarget });
          expect(reviewed.targets[1]?.judgmentTarget).toEqual({
            providerInstanceId: instanceId,
            model,
            options: expected.options,
            inheritOptions: false,
          });
          const explicit = yield* service.graphReview(invocation, {
            graph: {
              ...graph,
              nodes: Object.fromEntries(
                Object.entries(graph.nodes).map(([key, node]) => [
                  key,
                  {
                    ...node,
                    target: reviewed.targets.find((entry) => entry.nodeId === key)!.target,
                    ...("verify" in node
                      ? {
                          verify: {
                            ...node.verify,
                            target: reviewed.targets.find((entry) => entry.nodeId === key)!
                              .judgmentTarget,
                          },
                        }
                      : {}),
                  },
                ]),
              ),
            },
          });
          expect(explicit.digest).toBe(reviewed.digest);
          const started = yield* service.graphStart(invocation, {
            graph,
            workerTarget,
            acceptedDigest: reviewed.digest!,
          });
          const first = yield* awaitMember(started.workflowId, 1);
          yield* orchestrator.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("command:change-graph-caller"),
            threadId: parentThreadId,
            modelSelection: { ...modelSelection, options: [{ id: "new-option", value: true }] },
          });
          yield* completeChild(first.childThreadId!, "first done");
          const second = yield* awaitMember(started.workflowId, 2);
          const selection = (yield* orchestrator.getThreadProjection(second.childThreadId!)).thread
            .modelSelection;
          expect({
            ...selection,
            options: [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
          }).toEqual(expected);
          return started.workflowId;
        }),
      );
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          const second = yield* awaitMember(workflowId, 2);
          yield* completeChild(second.childThreadId!, "second done");
          const judge = yield* awaitMember(workflowId, 3);
          const selection = (yield* orchestrator.getThreadProjection(judge.childThreadId!)).thread
            .modelSelection;
          expect({
            ...selection,
            options: [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
          }).toEqual(expected);
          yield* completeChild(
            judge.childThreadId!,
            '```json\n{"outcome":"passed","reasons":"correct"}\n```',
          );
          expect((yield* awaitWorkflowEnd(workflowId)).status).toBe("completed");
        }),
      );
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("starts the approved expanded graph after the caller's options change", () =>
    Effect.gen(function* () {
      yield* startParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const setCallerOptions = (
        id: string,
        options: ReadonlyArray<{ id: string; value: string }>,
      ) =>
        orchestrator.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(id),
          threadId: parentThreadId,
          modelSelection: { ...modelSelection, options },
        });
      yield* setCallerOptions("command:caller-before-review", [
        { id: "serviceTier", value: "priority" },
      ]);
      // The node names the caller's provider and model, so review inherits the caller's options.
      const graph = {
        schemaVersion: 1,
        nodes: {
          a: {
            subject: "worker",
            description: "work",
            dependsOn: [],
            target: { providerInstanceId: instanceId, model },
          },
        },
      };
      const reviewed = yield* reviewGraph(graph);
      expect(reviewed.ready).toBe(true);
      const frozen = { serviceTier: "priority" };
      expect(reviewed.expandedGraph).toMatchObject({
        nodes: { a: { target: { options: [{ id: "serviceTier", value: frozen.serviceTier }] } } },
      });
      yield* setCallerOptions("command:caller-after-review", [
        { id: "serviceTier", value: "priority" },
        { id: "reasoningEffort", value: "high" },
      ]);
      const started = yield* decodeWorkflow(
        (yield* invoke("graph_start", {
          graph: reviewed.expandedGraph,
          acceptedDigest: reviewed.digest,
        })).structuredContent,
      );
      const worker = yield* awaitMember(started.workflowId, 1);
      expect(
        (yield* orchestrator.getThreadProjection(worker.childThreadId!)).thread.modelSelection,
      ).toEqual({ ...modelSelection, options: [{ id: "serviceTier", value: "priority" }] });
      yield* completeChild(worker.childThreadId!, "done");
      expect((yield* awaitWorkflowEnd(started.workflowId)).status).toBe("completed");
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "graph_review reports a fan-out advisory that never blocks, gates or changes the digest",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const workerTarget = { providerInstanceId: claudeInstanceId, model: claudeModel };
        const task = (dependsOn: ReadonlyArray<string> = []) => ({
          subject: "worker",
          description: "work",
          dependsOn,
        });
        const review = (nodes: Record<string, unknown>) =>
          Effect.gen(function* () {
            const result = yield* invoke("graph_review", {
              graph: { schemaVersion: 1, nodes },
              workerTarget,
            });
            return yield* decodeReview(result.structuredContent);
          });
        const chain = yield* review({ a: task(), b: task(["a"]), c: task(["b"]) });
        // A chain is advised against, yet it is ready, has a digest and needs no approval of its own.
        expect(chain).toMatchObject({
          ready: true,
          blockers: [],
          approvalRequired: false,
          advisory: { fanOut: "consider_single", nodeCount: 3, widestWave: 1, depth: 3 },
        });
        expect(chain.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        const fan = yield* review({
          a: task(),
          b: task(),
          c: task(),
          combine: task(["a", "b", "c"]),
        });
        // A Codex coordinator with Claude members: the coordinator is priced from the Codex
        // measurement, the members from the earlier 37k-96k estimate.
        expect(fan).toMatchObject({
          ready: true,
          blockers: [],
          advisory: {
            fanOut: "ok",
            widestWave: 3,
            estimatedModelCalls: { low: 11, high: 16 },
            estimatedTokens: { coordinator: { low: 288_000, high: 424_000 } },
          },
        });
        expect(fan.advisory?.suggestedBudgetTokens).toBe(1_612_800);
        // The advisory is not part of what the user approves: an identical review gives an identical digest.
        const again = yield* review({
          a: task(),
          b: task(),
          c: task(),
          combine: task(["a", "b", "c"]),
        });
        expect(again.digest).toBe(fan.digest);
        // A graph that does not parse has no advisory.
        const broken = yield* decodeReview(
          (yield* invoke("graph_review", { graph: { schemaVersion: 1, nodes: {} } }))
            .structuredContent,
        );
        expect(broken.advisory).toBeUndefined();
        expect(broken.ready).toBe(false);
        // The same graph on Codex members is priced from the Codex measurement.
        const codexFan = yield* decodeReview(
          (yield* invoke("graph_review", {
            graph: {
              schemaVersion: 1,
              nodes: {
                a: task(),
                b: task(),
                c: task(),
                combine: task(["a", "b", "c"]),
              },
            },
            workerTarget: { providerInstanceId: instanceId, model },
          })).structuredContent,
        );
        expect(codexFan.advisory?.suggestedBudgetTokens).toBe(436_800);
        expect(codexFan.advisory?.overshootBoundTokens).toBe(234_000);
        expect(codexFan.digest).not.toBe(fan.digest);
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "graph_review prices a Claude coordinator and Claude members from the earlier estimate",
    () =>
      Effect.gen(function* () {
        yield* startParentWithSelection({ instanceId: claudeInstanceId, model: claudeModel });
        const task = (dependsOn: ReadonlyArray<string> = []) => ({
          subject: "worker",
          description: "work",
          dependsOn,
        });
        const result = yield* invoke("graph_review", {
          graph: {
            schemaVersion: 1,
            nodes: { a: task(), b: task(), c: task(), combine: task(["a", "b", "c"]) },
          },
        });
        const review = yield* decodeReview(result.structuredContent);
        expect(review).toMatchObject({
          ready: true,
          advisory: {
            estimatedModelCalls: { low: 11, high: 16 },
            estimatedTokens: {
              low: 407_000,
              high: 1_536_000,
              coordinator: { low: 111_000, high: 384_000 },
            },
            overshootBoundTokens: 864_000,
          },
        });
        expect(review.advisory?.suggestedBudgetTokens).toBe(1_612_800);
        expect(review.advisory?.estimatedTokens.basis).toContain("Other drivers are not measured");
      }).pipe(Effect.provide(layerTest)),
  );
  it.effect("C3 expands defaults before hashing and reports target provenance", () =>
    Effect.gen(function* () {
      yield* startParent;
      const node = { subject: "worker", description: "work", dependsOn: [] };
      const workerTarget = { providerInstanceId: claudeInstanceId, model: claudeModel };
      const graph = { schemaVersion: 1, nodes: { a: node } };
      const defaults = yield* decodeReview(
        (yield* invoke("graph_review", { graph, workerTarget })).structuredContent,
      );
      const explicit = yield* decodeReview(
        (yield* invoke("graph_review", {
          graph: { ...graph, nodes: { a: { ...node, target: workerTarget } } },
        })).structuredContent,
      );
      expect(defaults.ready).toBe(true);
      expect(defaults.digest).toBe(explicit.digest);
      expect(defaults).toMatchObject({
        targets: [
          {
            nodeId: "a",
            source: "workerTarget",
            target: { ...workerTarget, options: [] },
          },
        ],
      });
      expect(explicit).toMatchObject({ targets: [{ nodeId: "a", source: "target" }] });
      const inherited = yield* decodeReview(
        (yield* invoke("graph_review", { graph })).structuredContent,
      );
      expect(inherited).toMatchObject({
        targets: [{ source: "caller", target: { providerInstanceId: instanceId, model } }],
      });
      for (const own of [{ target: { model } }, { model }, { target: {} }]) {
        const reviewed = yield* decodeReview(
          (yield* invoke("graph_review", {
            graph: { ...graph, nodes: { a: { ...node, ...own } } },
            workerTarget,
          })).structuredContent,
        );
        expect(reviewed.ready).toBe(true);
        expect(reviewed.digest).toBe(inherited.digest);
        expect(reviewed).toMatchObject({
          targets: [{ source: "model" in own ? "model" : "target" }],
        });
      }
      // A different concrete assignment cannot use the approved digest.
      const refused = yield* invoke("graph_start", { graph, acceptedDigest: defaults.digest });
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toContain("digest mismatch");
      yield* answerWorkflowAgents(() => "done");
      const started = yield* decodeWorkflow(
        (yield* invoke("graph_start", {
          graph,
          workerTarget,
          acceptedDigest: defaults.digest,
        })).structuredContent,
      );
      yield* awaitWorkflowEnd(started.workflowId);
      expect(yield* awaitMember(started.workflowId, 1)).toMatchObject({
        providerInstanceId: claudeInstanceId,
        model: claudeModel,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(refusedTargets)(
    "C3 refuses an unavailable judgment $name at review",
    ({ target, reason }) =>
      Effect.gen(function* () {
        yield* startParent;
        const graph = {
          schemaVersion: 1,
          nodes: {
            a: {
              subject: "worker",
              description: "work",
              dependsOn: [],
              verify: { type: "judgment", rubric: ["check"], target },
            },
          },
        };
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.ready).toBe(false);
        expect(reviewed.blockers.join(" ")).toContain(reason);
        expect(yield* childTasks).toEqual([]);
      }).pipe(Effect.provide(layerRefusedTargets)),
  );
  it.effect.each(refusedTargets)(
    "C3 refuses a graph targeting $name at review and start",
    ({ target, reason }) =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents(() => "unexpected dispatch");
        const graph = {
          schemaVersion: 1,
          name: "Refused target",
          nodes: {
            worker: { subject: "Worker", description: "refused worker", dependsOn: [], target },
            downstream: {
              subject: "Downstream",
              description: "must not run",
              dependsOn: ["worker"],
            },
          },
        };
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.ready).toBe(false);
        expect(reviewed.blockers.join(" ")).toContain(reason);
        const result = yield* invoke("graph_start", {
          graph,
          acceptedDigest: reviewed.digest ?? `sha256:${"0".repeat(64)}`,
        });
        expect(result.isError).toBe(true);
        expect(errorText(result)).toContain(reason);
        expect(yield* childTasks).toEqual([]);
      }).pipe(Effect.provide(layerRefusedTargets)),
  );

  /** A 150-node, ten-wave review of read-only nodes, as a coordinator would send it. */
  const wideReviewGraph = (descriptionLength: number) => {
    const label = (index: number) => `n${String(index + 1).padStart(3, "0")}`;
    return {
      schemaVersion: 1,
      name: "Wide review",
      nodes: Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [
          label(index),
          {
            subject: `Check area ${index + 1}`,
            description: `Read only: report one finding for area ${index + 1}. `
              .repeat(Math.ceil(descriptionLength / 50))
              .slice(0, descriptionLength),
            dependsOn: index < 15 ? [] : [label(index - 15)],
            scopes: { read: ["."] },
          },
        ]),
      ),
    };
  };

  /**
   * Stores graph_review's real service result as two SYNTHETIC tool items and returns what a
   * client receives (snapshot item, live event, getTurnItem). No provider ran: "claude" is a
   * duplicated `{ content, structuredContent }` envelope, "codex" is `structuredContent` as the
   * output. The labels name shapes, not observed large-output behavior of either provider.
   */
  const clientViewOfReview = (result: McpSchema.CallToolResult) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const run = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
      const now = yield* DateTime.now;
      const outputs = {
        claude: {
          toolName: "mcp__t3-code__graph_review",
          output: { content: errorText(result), structuredContent: result.structuredContent },
        },
        codex: { toolName: "t3-code.graph_review", output: result.structuredContent },
      };
      const events = Object.entries(outputs).map(([driver, { toolName, output }], index) => ({
        id: EventId.make(`event:review-item:${driver}`),
        type: "turn-item.updated" as const,
        threadId: parentThreadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`turn-item:review:${driver}`),
          type: "dynamic_tool" as const,
          threadId: parentThreadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100 + index,
          status: "completed" as const,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          toolName,
          input: { graph: "(the graph the coordinator sent)" },
          output,
        },
      }));
      yield* sink.commitCommand({
        commandId: CommandId.make("command:review-items"),
        threadId: parentThreadId,
        commandType: "test.review-items",
        acceptedAt: now,
        effects: [],
        events,
      });
      const snapshot = projectThreadProjectionForWire(
        yield* orchestrator.getThreadProjection(parentThreadId),
      );
      return yield* Effect.forEach(events, (event) =>
        Effect.gen(function* () {
          const itemId = event.payload.id;
          const detail = (yield* threads.getTurnItem({ threadId: parentThreadId, itemId })).item;
          return {
            driver: itemId.replace("turn-item:review:", ""),
            snapshot: snapshot.turnItems.find((item) => item.id === itemId),
            live: projectDomainEventForWire(event).payload,
            detail,
          };
        }),
      );
    });

  it.effect("graph_review at 150 nodes reaches clients only through getTurnItem", () =>
    Effect.gen(function* () {
      yield* startParent;
      const result = yield* invoke("graph_review", { graph: wideReviewGraph(50) });
      const review = yield* decodeReview(result.structuredContent);
      expect(review).toMatchObject({ ready: true, blockers: [] });
      expect(review.targets).toHaveLength(150);
      expect(review.layers).toHaveLength(10);
      expect(review.expandedGraph).toMatchObject({ nodes: expect.any(Object) });
      // The text block and structuredContent come from the same value, so the duplicated envelope
      // below holds one review twice. This checks the MCP service result only; it does not say
      // what either provider shows its model, which at 150 nodes may be a cut or a notice.
      expect(JSON.parse(errorText(result))).toEqual(result.structuredContent);

      const views = yield* clientViewOfReview(result);
      expect(views.map((view) => view.driver)).toEqual(["claude", "codex"]);
      for (const { driver, snapshot, live, detail } of views) {
        // Neither the snapshot nor the live event carries a single review field.
        for (const item of [snapshot, live]) {
          expect(item, driver).toMatchObject({ type: "dynamic_tool", outputOmitted: true });
          expect(item, driver).not.toHaveProperty("output");
          expect(JSON.stringify(item).length, driver).toBeLessThan(2_000);
        }
        const fetched = detail?.type === "dynamic_tool" ? detail.output : undefined;
        const structured =
          driver === "claude"
            ? (fetched as { readonly structuredContent?: unknown } | undefined)?.structuredContent
            : fetched;
        expect(structured, driver).toEqual(result.structuredContent);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("getTurnItem truncates an explicitly duplicated review envelope past 256 KiB", () =>
    Effect.gen(function* () {
      yield* startParent;
      // 600-character descriptions are ordinary for a coordinator planning real work.
      const result = yield* invoke("graph_review", { graph: wideReviewGraph(600) });
      expect(result.isError).not.toBe(true);
      const bytes = JSON.stringify(result.structuredContent).length;
      // getTurnItem returns at most 256 KiB of output as data, whatever the provider. This checks
      // that boundary. The "claude" item is a SYNTHETIC envelope that duplicates the review (text
      // plus structuredContent) so that one copy fits and two do not. It is not a claim that
      // Claude Code stores two copies of a large result; a live over-limit run stored a notice.
      expect(bytes).toBeLessThan(256 * 1024);
      expect(bytes * 2).toBeGreaterThan(256 * 1024);

      const [duplicatedEnvelope, structuredOnly] = yield* clientViewOfReview(result);
      const output = (view: typeof duplicatedEnvelope) =>
        view?.detail?.type === "dynamic_tool" ? view.detail.output : undefined;
      expect(output(structuredOnly)).toEqual(result.structuredContent);
      expect(output(duplicatedEnvelope)).toEqual(
        expect.stringContaining("output truncated for transport"),
      );
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("graph_review binds inputs, reports a missing one, and records nothing", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const before = yield* threads.getThreadEventSequence(parentThreadId);
        const graph = serialGraph(dir);
        graph.nodes.produce.inputs.push({
          id: "gone",
          kind: "workspace_snapshot",
          path: `${dir}/missing.txt`,
        });
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.ready).toBe(false);
        expect(reviewed.layers).toEqual([["produce"], ["consume"]]);
        expect(reviewed.inputs).toEqual([
          { path: `${dir}/in.txt`, status: "found", sha256: sha256("source"), sizeBytes: 6 },
          { path: `${dir}/missing.txt`, status: "missing", sha256: null, sizeBytes: null },
        ]);
        expect(reviewed.blockers).toEqual([`produce: input gone (${dir}/missing.txt) is missing.`]);
        expect(yield* threads.getThreadEventSequence(parentThreadId)).toBe(before);
        const refused = yield* invoke("graph_start", {
          graph,
          acceptedDigest: reviewed.digest,
        });
        expect(refused.isError).toBe(true);
        expect(errorText(refused)).toContain("The graph has blockers");
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("graph_start refuses a wrong digest and an input changed since review", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        const graph = serialGraph(dir);
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.ready).toBe(true);
        const wrong = yield* invoke("graph_start", {
          graph,
          acceptedDigest: `sha256:${"0".repeat(64)}`,
        });
        expect(errorText(wrong)).toContain("Review not found");
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "edited");
        const stale = yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest });
        expect(stale.isError).toBe(true);
        expect(errorText(stale)).toContain(`Input files changed since review: ${dir}/in.txt.`);
        const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        );
        expect(parent.subagents).toEqual([]);
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect(
    "runs a reviewed graph as one workflow and returns a compact record of each node, waking once",
    () =>
      withScratchDir((dir) =>
        Effect.gen(function* () {
          yield* startParent;
          NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
          yield* answerWorkflowAgents((prompt) => {
            if (!prompt.startsWith("produce")) return "used it";
            NodeFS.writeFileSync(NodePath.join(dir, "total.json"), '{"total":6}');
            return "made it";
          });
          const graph = serialGraph(dir);
          const reviewed = yield* reviewGraph(graph);
          const result = yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest });
          const started = yield* decodeWorkflow(result.structuredContent);
          const ended = yield* awaitWorkflowEnd(started.workflowId);
          expect(ended.status).toBe("completed");
          expect(ended.name).toBe("Serial");
          const totalSha = sha256('{"total":6}');
          // The wake carries statuses and paths; digests are not in it, and it says where they are.
          expect(JSON.parse(ended.result!)).toEqual({
            ok: true,
            nodes: {
              produce: {
                status: "passed",
                attempts: 1,
                outputs: { total: { path: `${dir}/total.json`, sizeBytes: 11 } },
              },
              consume: { status: "passed", attempts: 1 },
            },
            omitted: `input and output sha256 and any cut detail: workflow_status workflowId=${started.workflowId}, field nodes`,
          });
          // That is the place: workflow_status returns every node's input digests and output
          // path, size and sha256, so they can still be checked after the run.
          expect(ended.nodes).toEqual({
            produce: {
              status: "passed",
              attempts: 1,
              inputs: { source: sha256("source") },
              outputs: { total: { path: `${dir}/total.json`, sha256: totalSha, sizeBytes: 11 } },
            },
            consume: { status: "passed", attempts: 1, inputs: { upstream: totalSha } },
          });
          const consumer = yield* awaitMember(started.workflowId, 2);
          // The consumer gets the producer's summary and the file path, not a replay of its thread.
          expect(consumer.prompt).toContain(
            `<input id="upstream" from="produce" path="${dir}/total.json" sha256="${totalSha}" maxBytes="100">\nmade it\n</input>`,
          );
          expect(consumer.prompt.match(/<t3-handoff v="1">/g)).toHaveLength(1);
          const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
            parentThreadId,
          );
          expect(
            parent.runs.flatMap((run) => run.delegatedCompletion?.delivery?.taskIds ?? []),
          ).toEqual([started.workflowId]);
        }).pipe(Effect.provide(layerTest)),
      ),
  );

  it.effect("fails the graph and skips dependents when a node does not pass", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        // The producer never writes its output, so every attempt fails its outputs check.
        yield* answerWorkflowAgents(() => "did nothing");
        const graph = serialGraph(dir);
        const reviewed = yield* reviewGraph(graph);
        const started = yield* decodeWorkflow(
          (yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest }))
            .structuredContent,
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(ended.status).toBe("failed");
        const reason = `Its outputs check failed: output total (${dir}/total.json) was not written.`;
        expect(ended.result).toContain(
          `The workflow failed: Graph failed: 1 node failed, 1 skipped. Produce: ${reason}`,
        );
        expect(ended.agents).toHaveLength(1);
        expect(ended.agents[0]?.verification).toMatchObject({ type: "outputs", attempts: 3 });
        // The row itself records both nodes, including the one that never started an agent.
        const row = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        )).subagents.find((task) => task.id === started.workflowId);
        expect(row?.workflow?.agents.map((agent) => agent.graphNodeKey)).toEqual(["produce"]);
        const attempts = row?.workflow?.agents[0]?.attemptHistory;
        expect(attempts).toHaveLength(3);
        expect(new Set(attempts?.map((attempt) => attempt.taskId)).size).toBe(3);
        expect(attempts?.map((attempt) => attempt.attempt)).toEqual([0, 1, 2]);
        expect(
          attempts?.every(
            (attempt) => attempt.state === "completed" && attempt.childThreadId.length > 0,
          ),
        ).toBe(true);
        const recorded = {
          produce: {
            status: "failed",
            attempts: 3,
            reason,
            inputs: { source: sha256("source") },
          },
          consume: { status: "skipped", attempts: 0, reason: "Predecessor produce did not pass." },
        };
        expect(row?.workflow?.nodeOutcomes).toEqual(recorded);
        // A failed graph keeps its provenance too, and workflow_status returns it.
        expect(ended.nodes).toEqual(recorded);
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("graph_start says the review is gone when a restart dropped it", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        const graph = serialGraph(dir);
        const reviewed = yield* withServerProcess((service) =>
          service.graphReview(invocation, { graph }),
        );
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "edited");
        const refused = yield* withServerProcess((service) =>
          Effect.flip(service.graphStart(invocation, { graph, acceptedDigest: reviewed.digest! })),
        );
        expect(refused.message).toContain("Review not found");
        expect(refused.message).toContain("Run graph_review again.");
        expect(refused.message).not.toContain("digest mismatch");
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("fails a resumed workflow whose stored plan is unreadable", () =>
    Effect.gen(function* () {
      yield* startParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const workflowId = NodeId.make("workflow:bad-plan");
      yield* orchestrator.dispatch({
        type: "workflow.start",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:workflow-start:bad-plan"),
        threadId: parentThreadId,
        runId: parent.runs.at(-1)!.id,
        workflowId,
        title: "Bad plan",
        script: storedWorkflowScript("return 1", { plan: { nodes: "not a list" } }),
      });
      yield* withServerProcess((service) => service.resumeWorkflows);
      const ended = yield* awaitWorkflowEnd(workflowId);
      expect(ended.status).toBe("failed");
      expect(ended.result).toContain("its stored arguments are unreadable");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails a resumed workflow with unreadable arguments although its id was rejected", () =>
    Effect.gen(function* () {
      yield* startParent;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const parent = yield* orchestrator.getThreadProjection(parentThreadId);
      const workflowId = NodeId.make("workflow:bad-plan-rejected");
      yield* orchestrator.dispatch({
        type: "workflow.start",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("command:workflow-start:bad-plan-rejected"),
        threadId: parentThreadId,
        runId: parent.runs.at(-1)!.id,
        workflowId,
        title: "Bad plan",
        script: storedWorkflowScript("return 1", { plan: { nodes: "not a list" } }),
      });
      yield* spendCommandId(`command:workflow-complete:${workflowId}`);
      yield* withServerProcess((service) => service.resumeWorkflows);
      const ended = yield* awaitWorkflowEnd(workflowId);
      expect(ended.status).toBe("failed");
      expect(ended.result).toContain("its stored arguments are unreadable");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resumes a graph after a restart without starting a node twice", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        const graph = serialGraph(dir);
        const workflowId = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            const reviewed = yield* service.graphReview(invocation, { graph });
            const started = yield* service.graphStart(invocation, {
              graph,
              acceptedDigest: reviewed.digest!,
            });
            const producer = yield* awaitMember(started.workflowId, 1);
            NodeFS.writeFileSync(NodePath.join(dir, "total.json"), '{"total":6}');
            yield* completeChild(producer.childThreadId!, "made it");
            yield* awaitMember(started.workflowId, 2);
            return started.workflowId;
          }),
        );
        const consumer = yield* awaitMember(workflowId, 2);
        const resumed = yield* withServerProcess((service) =>
          Effect.gen(function* () {
            expect(yield* service.resumeWorkflows).toBe(1);
            yield* completeChild(consumer.childThreadId!, "used it");
            return yield* awaitWorkflowEnd(workflowId);
          }),
        );
        expect(resumed.status).toBe("completed");
        expect(JSON.parse(resumed.result!)).toMatchObject({
          ok: true,
          nodes: { produce: { status: "passed" }, consume: { status: "passed" } },
        });
        const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        );
        expect(parent.subagents.filter((task) => task.parentNodeId === workflowId)).toHaveLength(2);
        // The plan comes back from the stored settings, so the resumed row still shows the graph.
        const row = parent.subagents.find((task) => task.id === workflowId);
        expect(row?.workflow?.agents.map((agent) => agent.attemptHistory?.length)).toEqual([1, 1]);
        expect(row?.workflow?.agents[0]?.attemptHistory?.[0]?.childThreadId).toBe(
          parent.subagents.find((task) => task.id === row?.workflow?.agents[0]?.agentId)
            ?.childThreadId,
        );
        expect(
          row?.workflow?.plan?.nodes.map((node) => [node.key, node.wave, node.dependsOn]),
        ).toEqual([
          ["produce", 0, []],
          ["consume", 1, ["produce"]],
        ]);
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("fails the nodes a spent token budget refuses to start", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        const graph = serialGraph(dir);
        const reviewed = yield* reviewGraph(graph);
        const started = yield* decodeWorkflow(
          (yield* invoke("graph_start", {
            graph,
            acceptedDigest: reviewed.digest,
            budgetTokens: 1000,
          })).structuredContent,
        );
        const producer = yield* awaitMember(started.workflowId, 1);
        NodeFS.writeFileSync(NodePath.join(dir, "total.json"), '{"total":6}');
        yield* completeChild(producer.childThreadId!, "made it", { status: "completed" }, 1500);
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(ended.status).toBe("failed");
        expect(ended.tokensUsed).toBe(1500);
        const reason =
          "Error: The workflow's budget of 1000 tokens is spent (1500 recorded). New agents will not start; already-running agents may exceed this budget.";
        expect(ended.result).toContain(
          `The workflow failed: Graph failed: 1 node failed. Consume: ${reason}`,
        );
        const row = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        )).subagents.find((task) => task.id === started.workflowId);
        // The producer's provenance survives the failed graph, and the consumer's pinned input.
        const totalSha = sha256('{"total":6}');
        expect(row?.workflow?.nodeOutcomes).toEqual({
          produce: {
            status: "passed",
            attempts: 1,
            inputs: { source: sha256("source") },
            outputs: {
              total: {
                path: expect.stringMatching(/total\.json$/),
                sha256: totalSha,
                sizeBytes: 11,
              },
            },
          },
          consume: { status: "failed", attempts: 0, reason, inputs: { upstream: totalSha } },
        });
        expect(ended.nodes).toEqual(row?.workflow?.nodeOutcomes);
        expect(row?.workflow?.budget).toEqual({ limit: 1000, exhausted: true });
      }).pipe(Effect.provide(layerTest)),
    ),
  );

  it.effect("stops a graph with workflow_stop like any workflow", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        NodeFS.writeFileSync(NodePath.join(dir, "in.txt"), "source");
        const graph = serialGraph(dir);
        const reviewed = yield* reviewGraph(graph);
        const started = yield* decodeWorkflow(
          (yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest }))
            .structuredContent,
        );
        const first = yield* awaitMember(started.workflowId, 1);
        yield* invoke("workflow_stop", { workflowId: started.workflowId });
        const ended = yield* decodeWorkflow(
          (yield* invoke("workflow_status", { workflowId: started.workflowId })).structuredContent,
        );
        expect(ended.status).toBe("cancelled");
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        expect(
          (yield* orchestrator.getThreadProjection(first.childThreadId!)).runs.at(-1)?.status,
        ).toBe("interrupted");
      }).pipe(Effect.provide(layerTest)),
    ),
  );
});

describe("profile model preference", () => {
  const effortModel = (slug: string, efforts: ReadonlyArray<string> = ["low", "high"]) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select" as const,
          options: efforts.map((id) => ({ id, label: id })),
        },
      ],
    },
  });
  const codexWithEffort: ServerProvider = { ...provider, models: [effortModel(model)] };
  const claudeOffline: ServerProvider = { ...claudeProvider, enabled: false };
  const node = { subject: "worker", description: "work", dependsOn: [], preset: "worker" };
  const graph = { schemaVersion: 1, nodes: { a: node } };
  const claudeEntry = { providerInstanceId: claudeInstanceId, model: claudeModel };
  const codexEntry = { providerInstanceId: instanceId, model };
  const saveProfile = (
    target: {
      providerInstanceId: ProviderInstanceId;
      model: string;
      options?: ReadonlyArray<{ id: string; value: string }>;
    },
    fallbacks?: ReadonlyArray<{
      providerInstanceId: ProviderInstanceId;
      model: string;
      options?: ReadonlyArray<{ id: string; value: string }>;
    }>,
  ) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        workflowPresets: {
          presets: [
            {
              id: "worker",
              name: "Worker",
              target,
              ...(fallbacks === undefined ? {} : { fallbacks }),
            },
          ],
          defaultPresetId: null,
        },
      });
    });

  it.effect(
    "graph review picks the first entry that is enabled, serves the model and supports the options, and reports what it skipped",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* saveProfile(claudeEntry, [
          { providerInstanceId: instanceId, model: "missing-model" },
          { ...codexEntry, options: [{ id: "turbo", value: "x" }] },
          { ...codexEntry, options: [{ id: "effort", value: "high" }] },
        ]);
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.ready).toBe(true);
        const chosen = {
          providerInstanceId: instanceId,
          model,
          options: [{ id: "effort", value: "high" }],
          inheritOptions: false,
        };
        expect(reviewed.targets).toHaveLength(1);
        expect(reviewed.targets[0]).toMatchObject({
          source: "preset",
          target: chosen,
          presetId: "worker",
        });
        // The profile's choice is listed once, not repeated on the node.
        expect(reviewed.targets[0]).not.toHaveProperty("preference");
        expect(reviewed.profiles).toHaveLength(1);
        expect(reviewed.profiles?.[0]).toMatchObject({
          presetId: "worker",
          presetName: "Worker",
          chosenIndex: 3,
        });
        const skipped = reviewed.profiles![0]!.skipped;
        expect(
          skipped.map((entry) => [entry.index, entry.providerInstanceId, entry.model]),
        ).toEqual([
          [0, claudeInstanceId, claudeModel],
          [1, instanceId, "missing-model"],
          [2, instanceId, model],
        ]);
        expect(skipped[0]!.reason).toContain("disabled");
        expect(skipped[1]!.reason).toContain("not advertised");
        expect(skipped[2]!.reason).toContain("rejected options");
        expect(reviewed.expandedGraph).toMatchObject({ nodes: { a: { target: chosen } } });
      }).pipe(Effect.provide(makeLayerTest(undefined, [codexWithEffort, claudeOffline]))),
  );

  it.effect("graph review lists the profiles the user saved and leaves the digest alone", () =>
    Effect.gen(function* () {
      yield* startParent;
      const unassigned = {
        schemaVersion: 1,
        nodes: { a: { subject: "worker", description: "work", dependsOn: [] } },
      };
      const none = yield* reviewGraph(unassigned);
      expect(none.availableProfiles).toBeUndefined();
      yield* saveProfile(codexEntry);
      const listed = yield* reviewGraph(unassigned);
      expect(listed.availableProfiles).toEqual([{ presetId: "worker", presetName: "Worker" }]);
      expect(listed.digest).toBe(none.digest);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "graph review blocks a profile with no usable entry and never inherits the caller",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* saveProfile(claudeEntry, [
          { providerInstanceId: instanceId, model: "missing-model" },
        ]);
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed).toMatchObject({
          ready: false,
          digest: null,
          expandedGraph: null,
          targets: [],
        });
        expect(reviewed.blockers).toHaveLength(1);
        expect(reviewed.blockers[0]).toContain('a: Profile "Worker" has no available model.');
        expect(reviewed.blockers[0]).toContain(`1. ${claudeInstanceId} / ${claudeModel}:`);
        expect(reviewed.blockers[0]).toContain("disabled");
        expect(reviewed.blockers[0]).toContain(`2. ${instanceId} / missing-model:`);
        expect(reviewed.blockers[0]).toContain("not advertised");
      }).pipe(Effect.provide(makeLayerTest(undefined, [provider, claudeOffline]))),
  );
  it.effect(
    "graph start keeps the reviewed fallback while it is served, even after the preferred model returns",
    () => {
      const providers: ServerProvider[] = [provider, claudeProvider];
      return Effect.gen(function* () {
        yield* startParent;
        yield* saveProfile(claudeEntry, [codexEntry]);
        providers[1] = claudeOffline;
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.targets[0]).toMatchObject({
          target: { providerInstanceId: instanceId, model },
          presetId: "worker",
        });
        expect(reviewed.profiles).toMatchObject([
          {
            presetId: "worker",
            chosenIndex: 1,
            skipped: [{ index: 0, providerInstanceId: claudeInstanceId }],
          },
        ]);
        providers[1] = claudeProvider;
        const fresh = yield* reviewGraph(graph);
        expect(fresh.targets[0]?.target.providerInstanceId).toBe(claudeInstanceId);
        expect(fresh.digest).not.toBe(reviewed.digest);
        const started = yield* decodeWorkflow(
          (yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest }))
            .structuredContent,
        );
        expect(yield* awaitMember(started.workflowId, 1)).toMatchObject({
          providerInstanceId: instanceId,
          model,
        });
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );

  it.effect(
    "graph start refuses when the reviewed model is gone instead of moving to the next entry",
    () => {
      const providers: ServerProvider[] = [provider, claudeProvider];
      return Effect.gen(function* () {
        yield* startParent;
        yield* saveProfile(claudeEntry, [codexEntry]);
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.targets[0]).toMatchObject({
          target: { providerInstanceId: claudeInstanceId },
          presetId: "worker",
        });
        expect(reviewed.profiles).toMatchObject([{ chosenIndex: 0, skipped: [] }]);
        providers[1] = claudeOffline;
        const refused = yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest });
        expect(refused.isError).toBe(true);
        expect(errorText(refused)).toContain("no longer available");
        expect(errorText(refused)).toContain("does not switch to another model");
        expect(errorText(refused)).toContain("Review the graph again");
        expect(yield* childTasks).toEqual([]);
        // A server restart forgets the review; the order alone must still not start the fallback.
        const afterRestart = yield* withServerProcess((service) =>
          service
            .graphStart(invocation, { graph, acceptedDigest: reviewed.digest! })
            .pipe(Effect.flip),
        );
        expect(afterRestart.message).toContain("Review not found");
        expect(yield* childTasks).toEqual([]);
        const again = yield* reviewGraph(graph);
        expect(again.profiles?.[0]).toMatchObject({ chosenIndex: 1 });
        expect(again.digest).not.toBe(reviewed.digest);
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );

  // One model listed more than once, told apart by options: the shape of a profile that
  // asks for "this model with turbo, else with high effort, else plain".
  const turboEntry = { ...codexEntry, options: [{ id: "turbo", value: "x" }] };
  const highEntry = { ...codexEntry, options: [{ id: "effort", value: "high" }] };
  const highSelection = { instanceId, model, options: [{ id: "effort", value: "high" }] };

  it.effect(
    "graph start runs the reviewed entry when the profile lists one model more than once",
    () => {
      const providers: ServerProvider[] = [codexWithEffort, claudeOffline];
      return Effect.gen(function* () {
        yield* startParent;
        yield* saveProfile(claudeEntry, [
          { providerInstanceId: instanceId, model: "missing-model" },
          turboEntry,
          highEntry,
        ]);
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.profiles?.[0]).toMatchObject({ chosenIndex: 3 });
        // The preferred provider returns after review; a fresh review would move to it.
        providers[1] = claudeProvider;
        const started = yield* decodeWorkflow(
          (yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest }))
            .structuredContent,
        );
        const member = yield* awaitMember(started.workflowId, 1);
        expect(member).toMatchObject({ providerInstanceId: instanceId, model });
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        expect(
          (yield* orchestrator.getThreadProjection(member.childThreadId!)).thread.modelSelection,
        ).toEqual(highSelection);
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );

  it.effect(
    "graph start refuses when the reviewed entry lost its option and does not take a later entry",
    () => {
      const providers: ServerProvider[] = [codexWithEffort];
      return Effect.gen(function* () {
        yield* startParent;
        yield* saveProfile(turboEntry, [highEntry, codexEntry]);
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.profiles?.[0]).toMatchObject({ chosenIndex: 1 });
        // The catalog stops offering "high"; the plain entry after it is still servable.
        providers[0] = { ...provider, models: [effortModel(model, ["low"])] };
        const refused = yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest });
        expect(refused.isError).toBe(true);
        expect(errorText(refused)).toContain("no longer available");
        expect(errorText(refused)).toContain("does not switch to another model");
        expect(yield* childTasks).toEqual([]);
        // Review again and the profile moves on openly, with a different digest.
        const again = yield* reviewGraph(graph);
        expect(again.profiles?.[0]).toMatchObject({ chosenIndex: 2 });
        expect(again.digest).not.toBe(reviewed.digest);
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );

  it.effect("graph start keeps the reviewed entry when the profile is reordered", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* saveProfile(turboEntry, [highEntry]);
      const reviewed = yield* reviewGraph(graph);
      expect(reviewed.profiles?.[0]).toMatchObject({ chosenIndex: 1 });
      yield* saveProfile(highEntry, [turboEntry]);
      const started = yield* decodeWorkflow(
        (yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest }))
          .structuredContent,
      );
      const member = yield* awaitMember(started.workflowId, 1);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      expect(
        (yield* orchestrator.getThreadProjection(member.childThreadId!)).thread.modelSelection,
      ).toEqual(highSelection);
    }).pipe(Effect.provide(makeLayerTest(undefined, [codexWithEffort]))),
  );

  it.effect("graph start refuses when the profile no longer lists the reviewed entry", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* saveProfile(turboEntry, [highEntry]);
      const reviewed = yield* reviewGraph(graph);
      // Same model, different options: not the entry that was reviewed.
      yield* saveProfile(turboEntry, [
        { ...codexEntry, options: [{ id: "effort", value: "low" }] },
      ]);
      const refused = yield* invoke("graph_start", { graph, acceptedDigest: reviewed.digest });
      expect(refused.isError).toBe(true);
      expect(errorText(refused)).toContain("no longer lists the model that was reviewed");
      expect(errorText(refused)).toContain("Review the graph again");
      expect(yield* childTasks).toEqual([]);
      const again = yield* reviewGraph(graph);
      expect(again.profiles?.[0]).toMatchObject({ chosenIndex: 1 });
      expect(again.digest).not.toBe(reviewed.digest);
    }).pipe(Effect.provide(makeLayerTest(undefined, [codexWithEffort]))),
  );

  it.effect("graph review lists a profile once however many nodes use it", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* saveProfile(claudeEntry, [
        { providerInstanceId: instanceId, model: "missing-model" },
        turboEntry,
        highEntry,
      ]);
      const nodes = Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [`n${index}`, node] as const),
      );
      const reviewed = yield* reviewGraph({ schemaVersion: 1, nodes });
      expect(reviewed.ready).toBe(true);
      expect(reviewed.targets).toHaveLength(150);
      expect(reviewed.targets.every((entry) => entry.presetId === "worker")).toBe(true);
      expect(reviewed.profiles).toHaveLength(1);
      expect(reviewed.profiles![0]!.skipped).toHaveLength(3);
      // The reasons are text, so they appear once in the whole result, not once per node.
      const text = JSON.stringify(reviewed);
      expect(text.split("rejected options").length - 1).toBe(1);
      expect(text.split("not advertised").length - 1).toBe(1);
      expect(text.split("disabled").length - 1).toBe(1);
    }).pipe(Effect.provide(makeLayerTest(undefined, [codexWithEffort, claudeOffline]))),
  );

  it.effect("workflow_start resolves a profile once and a resumed script keeps that choice", () => {
    const providers: ServerProvider[] = [provider, claudeProvider];
    return Effect.gen(function* () {
      yield* startParent;
      yield* saveProfile(claudeEntry, [codexEntry]);
      providers[1] = claudeOffline;
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, {
            script:
              'await agent("first", { preset: "worker" }); await agent("second", { preset: "worker" }); return await agent("third", { preset: "worker" })',
          });
          const first = yield* awaitMember(started.workflowId, 1);
          expect(first).toMatchObject({ providerInstanceId: instanceId, model });
          yield* completeChild(first.childThreadId!, "one");
          expect(yield* awaitMember(started.workflowId, 2)).toMatchObject({
            providerInstanceId: instanceId,
            model,
          });
          return started.workflowId;
        }),
      );
      // A fresh resolution would now pick the preferred model, and the profile lost its fallbacks.
      providers[1] = claudeProvider;
      yield* saveProfile(claudeEntry);
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          yield* answerWorkflowAgents((prompt) => (prompt === "first" ? "one" : undefined));
          const second = yield* awaitMember(workflowId, 2);
          yield* completeChild(second.childThreadId!, "two");
          yield* answerWorkflowAgents((prompt) => (prompt === "third" ? "three" : undefined));
          const ended = yield* awaitWorkflowEnd(workflowId);
          expect(yield* awaitMember(workflowId, 3)).toMatchObject({
            providerInstanceId: instanceId,
            model,
          });
          expect(ended.status).toBe("completed");
        }),
      );
    }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
  });

  it.effect("a script with no usable profile entry fails its agent with every reason", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* saveProfile(claudeEntry, [{ providerInstanceId: instanceId, model: "missing-model" }]);
      const started = yield* decodeWorkflow(
        (yield* invoke("workflow_start", {
          workerTarget: { providerInstanceId: instanceId, model },
          script: 'return await agent("only", { preset: "worker" })',
        })).structuredContent,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.agents[0]?.result).toContain('Profile "Worker" has no available model.');
      expect(ended.agents[0]?.result).toContain("not advertised");
      expect(
        (yield* childTasks).filter((task) => task.parentNodeId === started.workflowId),
      ).toEqual([]);
    }).pipe(Effect.provide(makeLayerTest(undefined, [provider, claudeOffline]))),
  );

  it.effect(
    "a script stored before profiles still resumes, with duplicate and 400-character names",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const parent = yield* orchestrator.getThreadProjection(parentThreadId);
        const frozen = (entry: typeof claudeEntry) => ({
          target: { ...entry, options: [], inheritOptions: false },
        });
        const workflowPresets = {
          presets: [
            { id: "a", name: "Same", target: codexEntry },
            { id: "b", name: "Same", target: claudeEntry },
            { id: "c", name: "N".repeat(400), target: codexEntry },
          ],
          defaultPresetId: null,
        };
        const source = 'return await agent("legacy", { preset: "b" })';
        for (const [index, settings] of [
          { workflowPresets },
          {
            workflowPresets,
            presetTargets: { a: frozen(codexEntry), b: frozen(claudeEntry), c: frozen(codexEntry) },
          },
        ].entries()) {
          const workflowId = NodeId.make(`workflow:before-profiles-${index}`);
          yield* orchestrator.dispatch({
            type: "workflow.start",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`command:before-profiles-${index}`),
            threadId: parentThreadId,
            runId: parent.runs.at(-1)!.id,
            workflowId,
            title: "Before profiles",
            script: storedWorkflowScript(source, settings),
          });
          yield* withServerProcess((service) =>
            Effect.gen(function* () {
              expect(yield* service.resumeWorkflows).toBe(1);
              const member = yield* awaitMember(workflowId, 1);
              expect(member).toMatchObject({
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              });
              yield* completeChild(member.childThreadId!, "done");
              expect((yield* awaitWorkflowEnd(workflowId)).status).toBe("completed");
            }),
          );
        }
      }).pipe(Effect.provide(layerTest)),
  );
});

describe("workflow approval", () => {
  const requestText = "Plan this as a workflow";
  const startMessageId = MessageId.make("message:delegate-tasks:start");
  const oneNode = {
    schemaVersion: 1,
    nodes: { a: { subject: "worker", description: "work", dependsOn: [] } },
  };
  const twoNodes = {
    schemaVersion: 1,
    nodes: {
      a: { subject: "worker", description: "work", dependsOn: [] },
      b: { subject: "second", description: "more work", dependsOn: ["a"] },
    },
  };

  /** What run start tells the gate about a message the person typed in a client. */
  const personTurn = (typedText: string, messageId: MessageId = startMessageId) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      return {
        threadId: parentThreadId,
        messageId,
        typedText,
        workflowTriggers: (yield* settings.getSettings).workflowTriggers,
        createdBy: "user",
        creationSource: "web",
        delegatedThread: false,
        resumesEarlierTurn: false,
      } as const;
    });

  /** The person asks for a workflow: their message is stored, then run start sees it. */
  const askForWorkflow = Effect.gen(function* () {
    yield* startParentWithSelection(modelSelection, requestText);
    const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
    expect(yield* gate.observeTurn(yield* personTurn(requestText))).toBe("requested");
  });

  const refusal = (result: McpSchema.CallToolResult) => {
    expect(result.isError).toBe(true);
    return JSON.parse(errorText(result)) as { readonly code: string; readonly message: string };
  };

  const decide = (
    reviewed: OrchestratorMcpGraphReviewResult,
    overrides: Record<string, unknown> = {},
  ) => ({
    environmentId: invocation.environmentId,
    threadId: parentThreadId,
    reviewId: reviewed.reviewId,
    digest: reviewed.digest!,
    ...overrides,
  });

  const parentProjection = Effect.gen(function* () {
    return yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(parentThreadId);
  });

  /** The messages the server sent the agent for the user's decisions. */
  const cannedMessages = Effect.gen(function* () {
    return (yield* parentProjection).messages.filter(
      (message) => message.createdBy === "user" && message.creationSource === "server",
    );
  });

  const startGraph = (
    graph: unknown,
    reviewed: OrchestratorMcpGraphReviewResult,
    extra: Record<string, unknown> = {},
  ) => invoke("graph_start", { graph, acceptedDigest: reviewed.digest, ...extra });

  const workflowRows = Effect.gen(function* () {
    return (yield* parentProjection).subagents.filter((task) => task.workflow !== undefined);
  });

  /** The same tool call as another provider session of the thread would make it. */
  const otherSession: McpInvocationContext.McpInvocationScope = {
    ...invocation,
    requestNamespace: "provider-session:other",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:other",
      providerInstanceId: instanceId,
    },
  };
  const invokeAs = (
    scope: McpInvocationContext.McpInvocationScope,
    name: string,
    args: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });

  /**
   * Makes the thread reads graph_review and graph_start do on the parent thread misbehave once,
   * at the first matching read that `matches` accepts, after the real read. The read signals
   * `reached`, then does `how`: it fails, never returns, or waits and then returns what it read.
   * Restores itself when the test's scope ends.
   */
  const interceptParentRead = (
    matches: (records: { readonly subagents: ReadonlyArray<OrchestrationV2Subagent> }) => boolean,
    how: Effect.Effect<unknown, string>,
    skip = 0,
  ) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const real = threads.getThreadRecords;
      const reached = yield* Deferred.make<void>();
      let toSkip = skip;
      let spent = false;
      const spy = vi.spyOn(threads, "getThreadRecords").mockImplementation(((
        threadId: ThreadId,
        fields: ReadonlyArray<string>,
        filter: never,
      ) =>
        real(threadId, fields as never, filter).pipe(
          Effect.flatMap((records) => {
            if (
              spent ||
              threadId !== parentThreadId ||
              !fields.includes("contextTransfers") ||
              !matches(records as never)
            ) {
              return Effect.succeed(records);
            }
            if (toSkip > 0) {
              toSkip -= 1;
              return Effect.succeed(records);
            }
            spent = true;
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(how),
              Effect.as(records),
            );
          }),
        )) as never);
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      return { reached, restore: Effect.sync(() => spy.mockRestore()) };
    });

  /** Makes the first approval or dismissal message the server sends fail to send. */
  const failFirstCannedSend = (how: "not sent" | "sent, but reported as failed") =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const real = threads.dispatch;
      let pendingFailures = 1;
      const spy = vi.spyOn(threads, "dispatch").mockImplementation(((command: {
        readonly type: string;
        readonly creationSource?: string;
      }) => {
        if (
          pendingFailures > 0 &&
          command.type === "message.dispatch" &&
          command.creationSource === "server"
        ) {
          pendingFailures -= 1;
          return how === "not sent"
            ? Effect.fail("the send failed")
            : real(command as never).pipe(Effect.andThen(Effect.fail("the reply was lost")));
        }
        return real(command as never);
      }) as never);
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      return spy;
    });
  it.effect(
    "refuses graph_start and workflow_start while the user's request waits, and starts no agent",
    () =>
      Effect.gen(function* () {
        yield* askForWorkflow;
        const reviewed = yield* reviewGraph(oneNode);
        expect(reviewed).toMatchObject({ ready: true, approvalRequired: true });
        expect(reviewed.reviewId).not.toBe("");
        for (const graph of [oneNode, reviewed.expandedGraph]) {
          expect(refusal(yield* startGraph(graph, reviewed))).toMatchObject({
            code: "approval_required",
          });
        }
        const script = refusal(yield* invoke("workflow_start", { script: "return 1" }));
        expect(script).toMatchObject({ code: "approval_required" });
        expect(script.message).toContain("graph_review");
        // The agent's own digest, even one that matches its graph, is not an approval.
        expect(reviewed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect((yield* parentProjection).subagents).toEqual([]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("starts the approved digest under the approval's key, and that start settles", () =>
    Effect.gen(function* () {
      yield* askForWorkflow;
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      const reviewed = yield* reviewGraph(oneNode);
      const other = yield* reviewGraph(twoNodes);
      // A double click, a retry and two clicks at once are one decision.
      yield* approvals.approve(decide(reviewed));
      yield* approvals.approve(decide(reviewed));
      yield* Effect.all(
        [approvals.approve(decide(reviewed)), approvals.approve(decide(reviewed))],
        {
          concurrency: 2,
        },
      );
      const canned = yield* cannedMessages;
      expect(canned).toHaveLength(1);
      const [message] = canned;
      expect(message).toMatchObject({ createdBy: "user", creationSource: "server" });
      expect(message?.scheduledTaskId).toBeUndefined();
      expect(message?.senderThreadId).toBeUndefined();
      expect(message?.text).toContain(reviewed.digest);
      expect(message?.text).toContain("graph_start");
      // What was stored is what the next run start reads: it is not a typed request.
      expect(
        yield* gate.observeTurn({
          ...(yield* personTurn(message!.text, message!.id)),
          createdBy: message!.createdBy,
          creationSource: message!.creationSource,
          scheduledTaskId: message!.scheduledTaskId,
          senderThreadId: message!.senderThreadId,
        }),
      ).toBe("ignored");
      // Until the approved digest starts, only that digest may: not another graph, not a script.
      expect(refusal(yield* startGraph(twoNodes, other))).toMatchObject({
        code: "approval_required",
      });
      expect(refusal(yield* invoke("workflow_start", { script: "return 1" }))).toMatchObject({
        code: "approval_required",
      });
      expect(yield* workflowRows).toEqual([]);

      const started = yield* decodeWorkflow(
        (yield* startGraph(oneNode, reviewed, { clientRequestId: "start-1" })).structuredContent,
      );
      const member = yield* awaitMember(started.workflowId, 1);
      // The approval's key replaced the agent's, so the same start again, with another key or
      // none, from this session or another, is a retry of it and starts nothing new.
      for (const retry of [
        yield* startGraph(oneNode, reviewed, { clientRequestId: "start-2" }),
        yield* startGraph(oneNode, reviewed),
        yield* invokeAs(otherSession, "graph_start", {
          graph: oneNode,
          acceptedDigest: reviewed.digest,
        }),
      ]) {
        expect((yield* decodeWorkflow(retry.structuredContent)).workflowId).toBe(
          started.workflowId,
        );
      }
      expect(yield* workflowRows).toHaveLength(1);
      // The approved start settled the request: later starts follow the ordinary rules.
      yield* approvals.approve(decide(reviewed));
      expect(yield* cannedMessages).toHaveLength(1);
      const second = yield* decodeWorkflow(
        (yield* startGraph(twoNodes, other, { clientRequestId: "other-graph" })).structuredContent,
      );
      expect(second.workflowId).not.toBe(started.workflowId);
      const script = yield* decodeWorkflow(
        (yield* invoke("workflow_start", { script: "return 1" })).structuredContent,
      );
      expect(script.workflowId).not.toBe(started.workflowId);
      expect(yield* workflowRows).toHaveLength(3);
      yield* completeChild(member.childThreadId!, "done");
      expect((yield* awaitWorkflowEnd(started.workflowId)).status).toBe("completed");
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("binds a decision to this environment, thread, review and digest", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* askForWorkflow;
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const reviewed = yield* reviewGraph(oneNode);
        const blocked = yield* reviewGraph({
          schemaVersion: 1,
          nodes: {
            a: {
              subject: "worker",
              description: "work",
              dependsOn: [],
              inputs: [{ id: "gone", kind: "workspace_snapshot", path: `${dir}/missing.txt` }],
            },
          },
        });
        expect(blocked.ready).toBe(false);
        expect(blocked.digest).not.toBeNull();
        const reason = (input: Record<string, unknown>, review = reviewed) =>
          approvals.approve(decide(review, input)).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );
        expect(yield* reason({ environmentId: EnvironmentId.make("environment:elsewhere") })).toBe(
          "environment-mismatch",
        );
        expect(yield* reason({ threadId: ThreadId.make("thread:somewhere-else") })).toBe(
          "no-pending-request",
        );
        expect(yield* reason({ digest: `sha256:${"0".repeat(64)}` })).toBe("review-not-found");
        expect(yield* reason({ reviewId: "review:never-made" })).toBe("review-not-found");
        // A review with blockers can be dismissed, never approved.
        expect(yield* reason({}, blocked)).toBe("review-blocked");
        expect(yield* cannedMessages).toEqual([]);
        expect(refusal(yield* startGraph(oneNode, reviewed))).toMatchObject({
          code: "approval_required",
        });
        expect((yield* parentProjection).subagents).toEqual([]);
      }).pipe(Effect.provide(layerTest)),
    ),
  );
  it.effect("dismissing settles the request at once and tells the agent once", () =>
    Effect.gen(function* () {
      yield* askForWorkflow;
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      const reviewed = yield* reviewGraph(oneNode);
      const other = yield* reviewGraph(twoNodes);
      expect(refusal(yield* startGraph(oneNode, reviewed))).toMatchObject({
        code: "approval_required",
      });
      // Dismissing any review of the request, as often as the person clicks, is one word.
      yield* approvals.dismiss(decide(reviewed));
      yield* approvals.dismiss(decide(reviewed));
      yield* approvals.dismiss(decide(other));
      const canned = yield* cannedMessages;
      expect(canned).toHaveLength(1);
      expect(canned[0]?.text).toContain("Do not start a workflow for this request.");
      expect(canned[0]?.text).not.toContain("another graph");
      // The card for it is expired, not a fifth state.
      for (const review of [reviewed, other]) {
        expect(
          yield* approvals.approve(decide(review)).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        ).toBe("no-pending-request");
      }
      expect(yield* cannedMessages).toHaveLength(1);
      // The request is settled, so the gate no longer refuses: telling the agent is the instruction.
      const afterwards = yield* decodeWorkflow(
        (yield* startGraph(twoNodes, other)).structuredContent,
      );
      expect(afterwards.status).toBe("running");
      expect(
        (yield* decodeWorkflow(
          (yield* invoke("workflow_start", { script: "return 1" })).structuredContent,
        )).workflowId,
      ).toBeDefined();
      // The person's next message that asks for a workflow arms it again.
      expect(
        yield* gate.observeTurn(
          yield* personTurn("Now run a different workflow", MessageId.make("message:again")),
        ),
      ).toBe("requested");
      expect(refusal(yield* invoke("workflow_start", { script: "return 2" }))).toMatchObject({
        code: "approval_required",
      });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("drops what a newer request makes stale, and wants a review of it", () =>
    Effect.gen(function* () {
      yield* askForWorkflow;
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      const first = yield* reviewGraph(oneNode);
      yield* approvals.approve(decide(first));
      expect(
        yield* gate.observeTurn(
          yield* personTurn("Now run a different workflow", MessageId.make("message:second")),
        ),
      ).toBe("requested");
      expect(refusal(yield* startGraph(oneNode, first))).toMatchObject({
        code: "approval_required",
      });
      expect(
        yield* approvals.approve(decide(first)).pipe(
          Effect.flip,
          Effect.map((error) => error.reason),
        ),
      ).toBe("review-not-found");
      const second = yield* reviewGraph(oneNode);
      expect(second.digest).toBe(first.digest);
      expect(second.reviewId).not.toBe(first.reviewId);
      yield* approvals.approve(decide(second));
      expect(
        (yield* decodeWorkflow((yield* startGraph(oneNode, second)).structuredContent)).status,
      ).toBe("running");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "keeps refusing a reviewed target that is gone after approval, without a fallback",
    () => {
      const providers: ServerProvider[] = [
        {
          ...provider,
          models: [
            {
              slug: model,
              name: model,
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select" as const,
                    options: ["low", "high"].map((id) => ({ id, label: id })),
                  },
                ],
              },
            },
          ],
        },
      ];
      const highEntry = {
        providerInstanceId: instanceId,
        model,
        options: [{ id: "effort", value: "high" }],
      };
      return Effect.gen(function* () {
        yield* askForWorkflow;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({
          workflowPresets: {
            presets: [
              {
                id: "worker",
                name: "Worker",
                target: highEntry,
                fallbacks: [{ providerInstanceId: instanceId, model }],
              },
            ],
            defaultPresetId: null,
          },
        });
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const graph = {
          schemaVersion: 1,
          nodes: { a: { subject: "worker", description: "work", dependsOn: [], preset: "worker" } },
        };
        const reviewed = yield* reviewGraph(graph);
        expect(reviewed.profiles?.[0]).toMatchObject({ chosenIndex: 0 });
        yield* approvals.approve(decide(reviewed));
        // The catalog stops offering the reviewed option; the plain entry after it is still servable.
        providers[0] = {
          ...provider,
          models: [
            {
              slug: model,
              name: model,
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select" as const,
                    options: [{ id: "low", label: "low" }],
                  },
                ],
              },
            },
          ],
        };
        const refused = yield* startGraph(graph, reviewed);
        expect(refused.isError).toBe(true);
        expect(errorText(refused)).toContain("no longer available");
        expect(errorText(refused)).toContain("does not switch to another model");
        expect((yield* parentProjection).subagents).toEqual([]);
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );

  it.effect("keeps an approval for a start that failed, so the same digest can start later", () => {
    const providers: ServerProvider[] = [provider];
    return Effect.gen(function* () {
      yield* askForWorkflow;
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const reviewed = yield* reviewGraph(oneNode);
      yield* approvals.approve(decide(reviewed));
      // The caller's own model leaves the catalog, so the rebuilt graph no longer matches.
      providers[0] = { ...provider, models: [] };
      expect((yield* startGraph(oneNode, reviewed)).isError).toBe(true);
      expect((yield* parentProjection).subagents).toEqual([]);
      providers[0] = provider;
      const started = yield* decodeWorkflow(
        (yield* startGraph(oneNode, reviewed)).structuredContent,
      );
      expect(started.status).toBe("running");
    }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
  });

  describe("one approval is one workflow", () => {
    it.effect.each([
      { name: "fails before it can launch", how: "fails", skip: 0 },
      { name: "is interrupted before it can launch", how: "is interrupted", skip: 0 },
      { name: "is interrupted after it launched", how: "is interrupted", skip: 1 },
    ] as const)("when a start $name after its workflow was committed", ({ how, skip }) =>
      Effect.gen(function* () {
        yield* askForWorkflow;
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const reviewed = yield* reviewGraph(oneNode);
        yield* approvals.approve(decide(reviewed));
        // The first start commits its workflow; then its next read of the thread (the one after
        // the launch, when `skip` is 1) fails or never returns.
        const read = yield* interceptParentRead(
          (records) => records.subagents.some((task) => task.workflow !== undefined),
          how === "fails" ? Effect.fail("the read failed") : Effect.never,
          skip,
        );
        const first = yield* startGraph(oneNode, reviewed, { clientRequestId: "first" }).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(read.reached);
        if (how === "is interrupted") {
          yield* Fiber.interrupt(first);
        } else {
          expect((yield* Fiber.join(first)).isError).toBe(true);
        }
        yield* read.restore;
        const [committed] = yield* workflowRows;
        expect(committed).toBeDefined();
        // Retries with another key, and with none, find that workflow and start no second one.
        const retried = yield* decodeWorkflow(
          (yield* startGraph(oneNode, reviewed, { clientRequestId: "second" })).structuredContent,
        );
        const again = yield* decodeWorkflow(
          (yield* startGraph(oneNode, reviewed)).structuredContent,
        );
        expect(retried.workflowId).toBe(committed!.id);
        expect(again.workflowId).toBe(committed!.id);
        const member = yield* awaitMember(committed!.id, 1);
        const projection = yield* parentProjection;
        expect(projection.subagents.filter((task) => task.workflow !== undefined)).toHaveLength(1);
        expect(
          projection.subagents.filter((task) => task.parentNodeId === committed!.id),
        ).toHaveLength(1);
        yield* completeChild(member.childThreadId!, "done");
        expect((yield* awaitWorkflowEnd(committed!.id)).status).toBe("completed");
      }).pipe(Effect.provide(layerTest)),
    );
  });

  describe("a review that is still running", () => {
    it.effect("is refused, and not recorded, when a newer request arrives meanwhile", () =>
      Effect.gen(function* () {
        yield* askForWorkflow;
        const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        // graph_review noted the request before it reads the thread: hold it at that read.
        const proceed = yield* Deferred.make<void>();
        const read = yield* interceptParentRead(() => true, Deferred.await(proceed));
        const slow = yield* invoke("graph_review", { graph: oneNode }).pipe(Effect.forkChild);
        yield* Deferred.await(read.reached);
        expect(
          yield* gate.observeTurn(
            yield* personTurn(
              "Plan something else as a workflow",
              MessageId.make("message:second"),
            ),
          ),
        ).toBe("requested");
        yield* Deferred.succeed(proceed, undefined);
        const stale = refusal(yield* Fiber.join(slow));
        expect(stale.code).toBe("approval_required");
        expect(stale.message).toContain("not recorded");
        // The new request has no review of the old one, and its own review works.
        const fresh = yield* reviewGraph(oneNode);
        expect(fresh.approvalRequired).toBe(true);
        yield* approvals.approve(decide(fresh));
        expect(
          (yield* decodeWorkflow((yield* startGraph(oneNode, fresh)).structuredContent)).status,
        ).toBe("running");
      }).pipe(Effect.provide(layerTest)),
    );
  });

  describe("telling the agent", () => {
    it.effect.each(["not sent", "sent, but reported as failed"] as const)(
      "repeating a decision whose message was %s sends it once",
      (how) =>
        Effect.gen(function* () {
          yield* askForWorkflow;
          const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
          const reviewed = yield* reviewGraph(oneNode);
          const send = yield* failFirstCannedSend(how);
          const reason = (error: { readonly reason: string }) => error.reason;
          // The gate recorded the approval before the send failed.
          expect(reason(yield* approvals.approve(decide(reviewed)).pipe(Effect.flip))).toBe(
            "unavailable",
          );
          expect(yield* cannedMessages).toHaveLength(how === "not sent" ? 0 : 1);
          // The repeat is the same command: it sends what is missing, or reaches the receipt.
          yield* approvals.approve(decide(reviewed));
          yield* approvals.approve(decide(reviewed));
          expect(yield* cannedMessages).toHaveLength(1);
          send.mockRestore();
          // A dismissal is delivered the same way.
          const other = yield* reviewGraph(twoNodes);
          yield* failFirstCannedSend(how);
          expect(reason(yield* approvals.dismiss(decide(other)).pipe(Effect.flip))).toBe(
            "unavailable",
          );
          yield* approvals.dismiss(decide(other));
          yield* approvals.dismiss(decide(reviewed));
          expect(yield* cannedMessages).toHaveLength(2);
        }).pipe(Effect.provide(layerTest)),
    );
  });
  it.effect("leaves a request nobody asked a workflow for as it was: starts need no approval", () =>
    Effect.gen(function* () {
      yield* startParent;
      const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
      expect(yield* gate.observeTurn(yield* personTurn("Fan out work."))).toBe("plain");
      const reviewed = yield* reviewGraph(oneNode);
      expect(reviewed.approvalRequired).toBe(false);
      const started = yield* decodeWorkflow(
        (yield* startGraph(oneNode, reviewed)).structuredContent,
      );
      expect(started.status).toBe("running");
      const script = yield* decodeWorkflow(
        (yield* invoke("workflow_start", { script: "return 1" })).structuredContent,
      );
      expect(script.workflowId).toBeDefined();
    }).pipe(Effect.provide(layerTest)),
  );

  describe("after a server restart", () => {
    /** A fresh gate and fresh services over the same stored threads, as a restart leaves them. */
    const restarted = <A, E, R>(
      use: (services: {
        readonly mcp: OrchestratorMcpService.OrchestratorMcpService["Service"];
        readonly approvals: WorkflowApprovalService.WorkflowApprovalService["Service"];
      }) => Effect.Effect<A, E, R>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const layer = Layer.mergeAll(
            OrchestratorMcpService.layer,
            WorkflowApprovalService.layer,
          ).pipe(
            Layer.provideMerge(WorkflowApprovalGate.layer),
            Layer.provide(
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThreadRecords: (threadId, fields, filter) =>
                  orchestrator
                    .getThreadRecords(threadId, fields, filter)
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProjectionStore.ProjectionStoreReadError({ threadId, cause }),
                      ),
                    ),
              }),
            ),
          );
          const context = yield* Layer.build(Layer.fresh(layer));
          return yield* use({
            mcp: Context.get(context, OrchestratorMcpService.OrchestratorMcpService),
            approvals: Context.get(context, WorkflowApprovalService.WorkflowApprovalService),
          });
        }),
      );

    it.effect(
      "wants a fresh review and approval, and the same request and graph finds its workflow",
      () =>
        Effect.gen(function* () {
          yield* askForWorkflow;
          const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
          const before = yield* reviewGraph(oneNode);
          // The coordinator ended its turn, so the canned message starts a run of its own.
          yield* completeChild(parentThreadId, "Here is the plan.");
          yield* approvals.approve(decide(before));
          // The approved start commits its workflow, and the answer to the coordinator is lost.
          const read = yield* interceptParentRead(
            (records) => records.subagents.some((task) => task.workflow !== undefined),
            Effect.fail("the read failed"),
          );
          const first = yield* startGraph(oneNode, before).pipe(Effect.forkChild);
          yield* Deferred.await(read.reached);
          expect((yield* Fiber.join(first)).isError).toBe(true);
          yield* read.restore;
          const [committed] = yield* workflowRows;
          expect(committed).toBeDefined();
          yield* restarted(({ mcp, approvals: afterRestart }) =>
            Effect.gen(function* () {
              const stale = yield* mcp
                .graphStart(invocation, {
                  graph: before.expandedGraph,
                  acceptedDigest: before.digest!,
                })
                .pipe(Effect.flip);
              expect(stale.code).toBe("approval_required");
              expect((yield* afterRestart.approve(decide(before)).pipe(Effect.flip)).reason).toBe(
                "review-not-found",
              );
              const fresh = yield* mcp.graphReview(invocation, { graph: oneNode });
              expect(fresh.approvalRequired).toBe(true);
              expect(fresh.digest).toBe(before.digest);
              expect(fresh.reviewId).not.toBe(before.reviewId);
              // The same request and digest as before the restart, a new decision: repeated and
              // concurrent clicks are still one decision.
              yield* afterRestart.approve(decide(fresh));
              yield* Effect.all(
                [afterRestart.approve(decide(fresh)), afterRestart.approve(decide(fresh))],
                { concurrency: 2 },
              );
              // The decision is new, the launch is not: the request and the digest are the same, so
              // the start finds the workflow the first approval began.
              const started = yield* mcp.graphStart(invocation, {
                graph: fresh.expandedGraph,
                acceptedDigest: fresh.digest!,
              });
              expect(started.workflowId).toBe(committed!.id);
            }),
          );
          // One message for the decision before the restart, one for the decision after it. The
          // restarted gate read past the first to the request, and was not answered from its receipt.
          const projection = yield* parentProjection;
          const stored = projection.messages.filter(
            (message) => message.createdBy === "user" && message.creationSource === "server",
          );
          expect(stored).toHaveLength(2);
          expect(stored[0]?.id).not.toBe(stored[1]?.id);
          expect(stored.map((message) => message.text)).toEqual([stored[0]?.text, stored[0]?.text]);
          // One workflow and one member, however many times the request and digest were started.
          yield* awaitMember(committed!.id, 1);
          const settled = yield* parentProjection;
          expect(settled.subagents.filter((task) => task.workflow !== undefined)).toHaveLength(1);
          expect(
            settled.subagents.filter((task) => task.parentNodeId === committed!.id),
          ).toHaveLength(1);
        }).pipe(Effect.provide(layerTest)),
    );

    it.effect("tells the agent again about a dismissal made after a restart", () =>
      Effect.gen(function* () {
        yield* askForWorkflow;
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const before = yield* reviewGraph(oneNode);
        yield* approvals.dismiss(decide(before));
        expect(yield* cannedMessages).toHaveLength(1);
        yield* restarted(({ mcp, approvals: afterRestart }) =>
          Effect.gen(function* () {
            // The request was dismissed, and a restart arms it again.
            const fresh = yield* mcp.graphReview(invocation, { graph: oneNode });
            expect(fresh.approvalRequired).toBe(true);
            yield* afterRestart.dismiss(decide(fresh));
            yield* afterRestart.dismiss(decide(fresh));
          }),
        );
        expect(yield* cannedMessages).toHaveLength(2);
      }).pipe(Effect.provide(layerTest)),
    );
    it.effect("stays open when the person's latest message asks for no workflow", () =>
      Effect.gen(function* () {
        yield* startParent;
        const before = yield* reviewGraph(oneNode);
        yield* restarted(({ mcp }) =>
          Effect.gen(function* () {
            const reviewed = yield* mcp.graphReview(invocation, { graph: oneNode });
            expect(reviewed.approvalRequired).toBe(false);
            const started = yield* mcp.graphStart(invocation, {
              graph: before.expandedGraph,
              acceptedDigest: before.digest!,
            });
            expect(started.status).toBe("running");
          }),
        );
      }).pipe(Effect.provide(layerTest)),
    );
  });

  it.effect("gives the agent no tool to approve or dismiss anything", () =>
    Effect.sync(() => {
      const names = [
        OrchestratorToolkit,
        ThreadToolkit,
        WorktreeToolkit,
        WorktreeRemovalToolkit,
        ProjectToolkit,
        EnvironmentToolkit,
        PreviewControlsToolkit,
        HtmlToolkit,
      ].flatMap((toolkit) => Object.values(toolkit.tools).map((tool) => tool.name));
      expect(names).toContain("graph_review");
      expect(names.filter((name) => /approv|dismiss/iu.test(name))).toEqual([]);
    }),
  );
});

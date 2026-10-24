// @effect-diagnostics nodeBuiltinImport:off -- tests write the declared files an agent would.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
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
  type OrchestrationV2Run,
  type ModelSelection,
  type OrchestrationV2Subagent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  type ServerProvider,
  type TurnTokenUsage,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { storedWorkflowScript } from "@t3tools/shared/storedWorkflowScript";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
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
      get: () => Effect.succeed(Option.none()),
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
    Layer.provideMerge(layerOrchestration),
    Layer.provideMerge(layerAdapters),
    Layer.provideMerge(ProviderRegistryMock.layer(providers)),
    Layer.provideMerge(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provideMerge(
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Delegate tasks",
              // A real directory, so process checks have somewhere to run.
              workspaceRoot: process.cwd(),
            } as never),
          ),
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

const startParentWithSelection = (selection: ModelSelection) =>
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
      text: "Fan out work.",
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
          payload: { ...run, status: "completed", ...runPatch, startedAt: now, completedAt: now },
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
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === workflowId &&
            stored.event.payload.status !== "running",
        ),
        Stream.runHead,
      );
    return yield* decodeWorkflow(
      (yield* invoke("workflow_status", { workflowId })).structuredContent,
    );
  });

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

  it.effect("caps a failed workflow's result like a successful one", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow('throw new Error("x".repeat(100000))');
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("failed");
      expect(ended.result!.startsWith("The workflow failed: xxx")).toBe(true);
      expect(ended.result!.length).toBe(16_000);
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
        refused: "The workflow's budget of 1500 tokens is spent (1800 used).",
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

  it.effect("has a separate agent judge the result against a rubric", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) => {
        if (!prompt.includes("independent checker"))
          return retried(prompt) ? "a haiku" : "a limerick";
        const passed = prompt.includes("Result:\na haiku");
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
          expect(first.prompt).toContain(`- source: ${dir}/in.txt (sha256 ${inputSha})`);
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
    "runs a reviewed graph as one workflow and returns each node's provenance, waking once",
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
          expect(JSON.parse(ended.result!)).toEqual({
            ok: true,
            nodes: {
              produce: {
                status: "passed",
                attempts: 1,
                inputs: { source: sha256("source") },
                outputs: { total: { path: `${dir}/total.json`, sha256: totalSha, sizeBytes: 11 } },
                verification: {
                  type: "structured",
                  outcome: "passed",
                  attempts: 1,
                  detail: "Every required value is present and equal.",
                },
              },
              consume: {
                status: "passed",
                attempts: 1,
                inputs: { upstream: totalSha },
                outputs: {},
                verification: null,
              },
            },
          });
          const consumer = yield* awaitMember(started.workflowId, 2);
          expect(consumer.prompt).toContain(`- upstream: ${dir}/total.json (sha256 ${totalSha})`);
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
        expect(ended.result).toContain("Graph failed: ");
        expect(ended.result).toContain('"consume":{"status":"skipped"');
        expect(ended.result).toContain("Predecessor produce did not pass.");
        expect(ended.agents).toHaveLength(1);
        expect(ended.agents[0]?.verification).toMatchObject({ type: "outputs", attempts: 3 });
        // The row itself records both nodes, including the one that never started an agent.
        const row = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          parentThreadId,
        )).subagents.find((task) => task.id === started.workflowId);
        expect(row?.workflow?.agents.map((agent) => agent.graphNodeKey)).toEqual(["produce"]);
        expect(row?.workflow?.nodeOutcomes).toMatchObject({
          produce: { status: "failed", attempts: 3 },
          consume: { status: "skipped", attempts: 0, reason: "Predecessor produce did not pass." },
        });
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
        expect(ended.result).toContain('"produce":{"status":"passed"');
        expect(ended.result).toContain(
          "The workflow's budget of 1000 tokens is spent (1500 used).",
        );
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

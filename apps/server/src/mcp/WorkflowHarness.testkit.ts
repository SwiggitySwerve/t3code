/**
 * The workflow harness shared by the agent fan-out and workflow scenario tests: an in-memory
 * orchestrator with stub Codex and Claude adapters, an MCP caller, and helpers that finish a
 * child as its provider would.
 */
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
// @effect-diagnostics nodeBuiltinImport:off -- tests write the declared files an agent would.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import { expect } from "@effect/vitest";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpDelegateTasksResult,
  OrchestratorMcpGraphReviewResult,
  OrchestratorMcpTaskWaitResult,
  OrchestratorMcpWorkflowResult,
  type ManagedPolicySummary,
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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
// oxlint-disable-next-line t3code/no-raw-mcp-registration -- tests call tools McpHttpServer registered.
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
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as WorkflowApprovalService from "../orchestration-v2/WorkflowApprovalService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import * as UsageServiceTestkit from "../usage/UsageService.testkit.ts";

export const instanceId = ProviderInstanceId.make("codex");

export const model = "gpt-5.4";

export const modelSelection = { instanceId, model };

export const parentThreadId = ThreadId.make("thread:delegate-tasks-parent");

export const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

export const provider: ServerProvider = {
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

export const claudeInstanceId = ProviderInstanceId.make("claude-test");

export const claudeModel = "claude-sonnet-4-6";

export const claudeAdapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  ...adapter,
  instanceId: claudeInstanceId,
  driver: CLAUDE_PROVIDER,
  getCapabilities: () => Effect.succeed(ClaudeProviderCapabilitiesV2),
};

export const claudeProvider: ServerProvider = {
  ...provider,
  instanceId: claudeInstanceId,
  driver: claudeAdapter.driver,
  models: [{ slug: claudeModel, name: claudeModel, isCustom: false, capabilities: null }],
};

export const layerDatabase = SqlitePersistence.layerMemory;

export const makeLayerTest = (
  maxRunningDelegatedTasks?: number,
  providers: ReadonlyArray<ServerProvider> = [provider, claudeProvider],
  runtime?: {
    readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
    readonly cwd: string;
  },
  // Reaches the settings the MCP service reads, not the orchestrator's: threads are created
  // before the policy applies, as threads stored before a stricter policy was set are.
  managedPolicy?: ManagedPolicySummary,
) => {
  const layerAdapters = ProviderAdapterRegistry.layerFromAdapters([
    runtime?.adapter ?? adapter,
    claudeAdapter,
  ]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "delegate-tasks" },
    layerAdapters,
    {
      databaseLayer: layerDatabase,
      runEffectWorker: runtime !== undefined,
      configureMcp: runtime !== undefined,
      serverSettings: { workflows: true },
      ...(maxRunningDelegatedTasks === undefined ? {} : { maxRunningDelegatedTasks }),
    },
  );
  const layerOrchestration = ThreadManagementService.layer.pipe(
    Layer.provideMerge(layerOrchestrator),
    Layer.provideMerge(
      ServerSettings.layerTest(
        {
          workflows: true,
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
        },
        managedPolicy,
      ),
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
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
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
            workspaceRoot: runtime?.cwd ?? process.cwd(),
          } as never),
      }),
    ),
    Layer.provideMerge(
      SecretRequests.layer.pipe(Layer.provide(layerSecretStore), Layer.provide(layerOrchestration)),
    ),
    // Where the checkers' whole-answer files go: the server's own folder, not this checkout.
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-fanout-test-" })),
    // Linked environments are not under test here.
    Layer.provideMerge(Layer.mock(PeerForwarding.PeerForwarding)({})),
    Layer.provideMerge(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
    Layer.provideMerge(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provideMerge(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer)),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(UsageServiceTestkit.layerRates()),
  );
};

export const layerTest = makeLayerTest();

export const client = McpSchema.McpServerClient.of({
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

export const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:delegate-tasks"),
  requestNamespace: "provider-session:delegate-tasks",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:delegate-tasks",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration", "workflows"]),
  issuedAt: 1,
};

/** Calls a tool as `caller`; `invoke` calls it as the test's parent thread. */
export const invokeAs = (
  caller: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

export const invoke = (name: string, args: Record<string, unknown>) =>
  invokeAs(invocation, name, args);

/** Moves the clock one stall sweep at a time, letting each sweep run before the next. */
export const adjustBySweeps = (sweeps: number) =>
  Effect.gen(function* () {
    for (let sweep = 0; sweep < sweeps; sweep++) {
      yield* TestClock.adjust("30 seconds");
      yield* Effect.yieldNow;
    }
  });

export const errorText = (result: McpSchema.CallToolResult) =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("");

export const startParentWithSelection = (
  selection: ModelSelection,
  text = "Fan out work.",
  worktreePath: string | null = null,
) =>
  Effect.gen(function* () {
    yield* (yield* McpProviderSessions.McpProviderSessions).set({
      environmentId: invocation.environmentId,
      threadId: parentThreadId,
      providerSessionId: invocation.thread!.providerSessionId,
      providerInstanceId: selection.instanceId,
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer test-parent",
      browserToolsAvailable: false,
      capabilities: invocation.capabilities,
    });
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
      worktreePath,
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

export const startParent = startParentWithSelection(modelSelection);

export const childTasks = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
    (task) => task.origin === "app_owned",
  );
});

/** Finishes a delegated child's run as if its provider replied with `text`. */
export const completeChild = (
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

export const decodeStarted = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTasksResult);

export const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpTaskWaitResult);

export const decodeWorkflow = Schema.decodeUnknownEffect(OrchestratorMcpWorkflowResult);

export const refusedTargets = [
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

export const layerRefusedTargets = makeLayerTest(undefined, [
  provider,
  { ...claudeProvider, enabled: false },
]);

export const stopChild = (childThreadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make(`command:delegate-tasks:stop:${childThreadId}`),
      threadId: childThreadId,
    });
  });

/** How a stub provider ends a workflow agent's run: its reply, run status and token usage. */
export interface WorkerReply {
  readonly text: string;
  readonly status?: "completed" | "failed";
  readonly tokens?: number;
}

/**
 * Answers every agent a workflow starts, as its provider would, with `reply(prompt)`: a reply
 * text, or a `WorkerReply` that may fail the run or report its own usage. Agents whose reply is
 * undefined are left running. `reply` runs once per answered task, in start order.
 */
export const answerWorkflowAgents = (
  reply: (prompt: string, task: OrchestrationV2Subagent) => string | WorkerReply | undefined,
  tokens?: number,
) =>
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
            const answer = reply(task.prompt, task);
            if (answer === undefined) return;
            answered.add(task.id);
            const {
              text,
              status = "completed",
              tokens: used = tokens,
            } = typeof answer === "string" ? { text: answer } : answer;
            yield* completeChild(task.childThreadId, text, { status }, used);
          }),
        ),
        Effect.forkChild,
      );
  });

export const awaitWorkflowEnd = (workflowId: string) =>
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

export const startWorkflow = (script: string, args?: unknown) =>
  Effect.gen(function* () {
    const result = yield* invoke("workflow_start", {
      script,
      title: "Test workflow",
      ...(args === undefined ? {} : { args }),
    });
    return yield* decodeWorkflow(result.structuredContent);
  });

/** Waits for the workflow's `count`-th agent task, in start order. */
export const awaitMember = (workflowId: string, count: number) =>
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

/** Waits for the workflow's `count` checker tasks, which have a thread, in start order. */
export const awaitCheckers = (workflowId: string, count: number) =>
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
          if (!task.prompt.includes("independent checker")) return false;
          if (!seen.some((known) => known.id === task.id)) seen.push(task);
          return seen.length >= count;
        }),
        Stream.runHead,
      );
    return seen.slice(0, count);
  });

/** Runs `use` against a fresh workflow service, then shuts it down as a server stop would. */
export const withServerProcess = <A, E, R>(
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

// Declared files live in the test project's checkout, the working directory, under a scratch folder.
export const withScratchDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) => {
  const dir = `.t3-workflow-files-${NodeCrypto.randomUUID()}`;
  NodeFS.mkdirSync(dir);
  return use(dir).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }))),
  );
};

export const decodeReview = Schema.decodeUnknownEffect(OrchestratorMcpGraphReviewResult);

export const reviewGraph = (graph: unknown) =>
  Effect.gen(function* () {
    const result = yield* invoke("graph_review", { graph });
    expect(result.isError).not.toBe(true);
    return yield* decodeReview(result.structuredContent);
  });

import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  OrchestratorMcpDelegateTasksResult,
  OrchestratorMcpTaskWaitResult,
  OrchestratorMcpWorkflowResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
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

/** Finishes a delegated child's run as if its provider replied with `text`. */
const completeChild = (childThreadId: ThreadId, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const child = yield* orchestrator.getThreadProjection(childThreadId);
    const run = child.runs.at(-1)!;
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
        {
          id: EventId.make(`event:test-complete:${run.id}`),
          type: "run.updated",
          threadId: childThreadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...run, status: "completed", startedAt: now, completedAt: now },
        },
      ],
    });
  });

const decodeStarted = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTasksResult);
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpTaskWaitResult);
const decodeWorkflow = Schema.decodeUnknownEffect(OrchestratorMcpWorkflowResult);

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
const answerWorkflowAgents = (reply: (prompt: string) => string | undefined) =>
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
            yield* completeChild(task.childThreadId, text);
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

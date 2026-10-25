import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { EnvironmentId, NodeId, RunAttemptId, ThreadId, TrimmedNonEmptyString } from "./index.ts";
import {
  isOrchestrationV2ActiveWorkflowMember,
  isOrchestrationV2WorkActive,
  latestProviderTurnForAttempt,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2RpcSchemas,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShellJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  OrchestrationV2WorkflowAgent,
  OrchestrationV2WorkflowApprovalError,
  OrchestrationV2WorkflowUpdateCommand,
} from "./orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");

const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeOrchestrationV2TurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2Subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const encodeOrchestrationV2SubagentJson = Schema.encodeSync(OrchestrationV2SubagentJson);
const decodeOrchestrationV2ProviderThreadJson = Schema.decodeUnknownSync(
  OrchestrationV2ProviderThreadJson,
);
const encodeOrchestrationV2ProviderThreadJson = Schema.encodeSync(
  OrchestrationV2ProviderThreadJson,
);
const decodeOrchestrationV2ProviderThread = Schema.decodeUnknownSync(OrchestrationV2ProviderThread);
const decodeOrchestrationV2ProviderCapabilities = Schema.decodeUnknownSync(
  OrchestrationV2ProviderCapabilities,
);
const workflowAgentCodec = Schema.toCodecJson(OrchestrationV2WorkflowAgent);
const decodeWorkflowAgent = Schema.decodeUnknownSync(OrchestrationV2WorkflowAgent);
const encodeWorkflowAgent = Schema.encodeSync(workflowAgentCodec);
const decodeWorkflowAgentJson = Schema.decodeUnknownSync(workflowAgentCodec);

describe("orchestration V2 contracts", () => {
  it("keeps patch identity when phases and agents also match the legacy snapshot shape", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationV2WorkflowUpdateCommand);
    const encode = Schema.encodeSync(OrchestrationV2WorkflowUpdateCommand);
    const base = {
      type: "workflow.update",
      commandId: "command",
      threadId: "thread",
      workflowId: "workflow",
    };
    const fields = {
      phases: [{ index: 0, title: "Audit" }],
      agents: [{ index: 0, label: "Worker", state: "queued" }],
    };
    const patch = { ...base, workflow: { kind: "patch", ...fields } };
    expect(encode(decode(patch))).toEqual(patch);
    const legacy = { ...base, workflow: fields };
    expect(encode(decode(legacy))).toEqual(legacy);
  });
  it("round-trips attempt history and accepts legacy workflow members without it", () => {
    const roundTrip = (value: unknown) =>
      decodeWorkflowAgentJson(encodeWorkflowAgent(decodeWorkflowAgent(value)));
    const legacy = {
      index: 0,
      label: "Worker",
      state: "completed",
      totalTokens: 55561,
      attempt: 1,
    };
    expect(roundTrip(legacy)).toEqual(legacy);
    const current = {
      ...legacy,
      attemptHistory: [
        {
          taskId: "task-1",
          childThreadId: "child-1",
          attempt: 0,
          state: "failed",
          providerInstanceId: "provider-1",
          model: "model-1",
          totalTokens: 12,
          usageStatus: "partial",
          durationMs: 2000,
          timingComplete: true,
          startedAt: 1000,
        },
      ],
      judgmentOutcome: "failed",
    };
    expect(roundTrip(current)).toEqual(current);
  });
  it("decodes thread event types from a newer server as skippable items", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const detached = (id: string, sequence: number) => ({
      kind: "event",
      sequence,
      event: {
        id,
        type: "provider-session.detached",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload: { providerSessionId: "provider-session-1", detachedAt: DateTime.formatIso(now) },
      },
    });

    const items = decodeWireItems([
      detached("event-1", 1),
      {
        kind: "event",
        sequence: 2,
        event: {
          id: "event-2",
          type: "run.from-a-future-server",
          threadId: "thread-1",
          occurredAt: DateTime.formatIso(now),
          payload: { runId: "run-1" },
        },
      },
      detached("event-3", 3),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["event", "unknown-event", "event"]);
    expect(items[1]).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "run.from-a-future-server",
    });
    expect(() =>
      decodeWireItems([
        { ...detached("event-4", 4), event: { ...detached("event-4", 4).event, payload: {} } },
      ]),
    ).toThrow();
  });

  it("skips turn item types from a newer server in snapshots and turn-item events", () => {
    const decodeWireItems = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.Array(OrchestrationV2RpcSchemas.subscribeThread.output)),
    );
    const decodeHistoryPage = Schema.decodeUnknownSync(
      Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
    );
    const item = (id: string, type: string, extra: Record<string, unknown>) => ({
      id,
      type,
      threadId: "thread-1",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.formatIso(now),
      ...extra,
    });
    const known = item("item-known", "system_notice", { message: "Hello" });
    const future = item("item-future", "hologram", { beam: "ref-1" });
    const projected = (position: number, turnItem: { readonly id: string }) => ({
      position,
      visibility: "local",
      sourceThreadId: "thread-1",
      sourceItemId: turnItem.id,
      item: turnItem,
    });
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: "thread-1",
        projectId: "project-1",
        title: "Thread",
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
        forkedFrom: null,
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
        archivedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerSessions: [],
      providerThreads: [],
      providerTurns: [],
      runtimeRequests: [],
      messages: [],
      plans: [],
      turnItems: [future, known],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      visibleTurnItems: [projected(0, future), projected(1, known)],
      updatedAt: DateTime.formatIso(now),
    };
    const turnItemEvent = (sequence: number, payload: unknown) => ({
      kind: "event",
      sequence,
      event: {
        id: `event-${sequence}`,
        type: "turn-item.updated",
        threadId: "thread-1",
        occurredAt: DateTime.formatIso(now),
        payload,
      },
    });

    const [snapshot, futureEvent, knownEvent] = decodeWireItems([
      { kind: "snapshot", snapshotSequence: 1, projection },
      turnItemEvent(2, future),
      turnItemEvent(3, known),
    ]);

    expect(snapshot).toMatchObject({ kind: "snapshot" });
    if (snapshot?.kind !== "snapshot") throw new Error("expected a snapshot");
    expect(snapshot.projection.turnItems.map((turnItem) => turnItem.id)).toEqual(["item-known"]);
    expect(snapshot.projection.visibleTurnItems.map((row) => row.item.id)).toEqual(["item-known"]);
    // The same snapshot with an ID table: refs resolve before unknown items are skipped.
    const tabled = (turnItem: { readonly id: string }, ref: number) => ({ ...turnItem, id: ref });
    const [tabledSnapshot] = decodeWireItems([
      {
        kind: "snapshot",
        snapshotSequence: 1,
        projection: {
          ...projection,
          turnItems: [tabled(future, 0), tabled(known, 1)],
          visibleTurnItems: [
            { ...projected(0, future), sourceItemId: 0, item: tabled(future, 0) },
            { ...projected(1, known), sourceItemId: 1, item: tabled(known, 1) },
          ],
        },
        ids: ["item-future", "item-known"],
      },
    ]);
    expect(tabledSnapshot).toEqual(snapshot);
    expect(futureEvent).toEqual({
      kind: "unknown-event",
      sequence: 2,
      eventType: "turn-item.updated",
    });
    expect(knownEvent).toMatchObject({
      kind: "event",
      event: { type: "turn-item.updated", payload: { id: "item-known", type: "system_notice" } },
    });
    expect(
      decodeHistoryPage({
        snapshotSequence: 1,
        items: [projected(0, future), projected(1, known)],
        nextCursor: null,
        hasMoreHistory: false,
      }).items.map((row) => row.item.id),
    ).toEqual(["item-known"]);

    const broken = item("item-broken", "system_notice", {});
    expect(() => decodeWireItems([turnItemEvent(4, broken)])).toThrow();
    expect(() =>
      decodeWireItems([
        {
          kind: "snapshot",
          snapshotSequence: 1,
          projection: { ...projection, turnItems: [broken] },
        },
      ]),
    ).toThrow();
  });

  it("decodes persisted capability snapshots that predate runtimePolicy", () => {
    const legacyCapabilities = {
      sessions: {
        supportsMultipleProviderThreadsPerSession: false,
        supportsModelSwitchInSession: false,
        supportsProviderSwitchingViaHandoff: true,
        supportsRuntimeModeSwitchInSession: false,
        pendingRequestsSurviveRestart: false,
      },
      threads: {
        canCreateEmptyThread: true,
        canReadThreadSnapshot: false,
        canRollbackThread: true,
        canForkThread: false,
        canForkFromTurn: false,
        canForkFromSubagentThread: false,
        exposesNativeThreadId: true,
      },
      turns: {
        exposesNativeTurnId: false,
        emitsTurnStarted: true,
        emitsTurnCompleted: true,
        supportsInterrupt: true,
        supportsActiveSteering: false,
        supportsSteeringByInterruptRestart: true,
        supportsQueuedMessages: true,
        terminalStatusQuality: "strong",
      },
      streaming: {
        streamsAssistantText: true,
        streamsReasoning: true,
        streamsToolOutput: true,
        streamsPlanText: false,
        emitsMessageCompleted: true,
      },
      tools: {
        exposesToolItemIds: true,
        emitsToolStarted: true,
        emitsToolCompleted: true,
        emitsToolOutput: true,
        supportsMcpTools: false,
        supportsDynamicToolCallbacks: false,
      },
      approvals: {
        supportsCommandApproval: true,
        supportsFileReadApproval: true,
        supportsFileChangeApproval: true,
        supportsApplyPatchApproval: false,
        approvalsHaveNativeRequestIds: false,
        approvalCallbacksAreLiveOnly: true,
        approvalsCanOriginateFromSubagents: false,
      },
      planning: {
        emitsPlanUpdated: true,
        emitsTodoList: true,
        emitsProposedPlan: false,
        supportsStructuredQuestions: true,
        planDeltasHaveItemIds: false,
      },
      subagents: {
        supportsSubagents: false,
        exposesSubagentThreadIds: false,
        emitsSubagentLifecycle: false,
        canWaitForSubagents: false,
        canCloseSubagents: false,
        canForkSubagentThread: false,
      },
      context: {
        acceptsSystemContext: false,
        acceptsDeveloperContext: false,
        acceptsSyntheticUserContext: true,
        canGenerateSummaries: true,
        canConsumeHandoffSummaries: true,
        supportsDeltaHandoff: true,
        supportsFullThreadHandoff: true,
        maxRecommendedHandoffChars: null,
      },
      checkpointing: {
        appCanCheckpointFilesystem: true,
        supportsNestedCheckpointScopes: true,
        providerCanRollbackConversation: true,
        providerRollbackReturnsSnapshot: true,
        providerCanReadConversationSnapshot: false,
      },
      identity: {
        nativeThreadIds: "strong",
        nativeTurnIds: "weak",
        nativeItemIds: "weak",
        nativeRequestIds: "weak",
      },
    };

    const decoded = decodeOrchestrationV2ProviderCapabilities(legacyCapabilities);
    expect(decoded.runtimePolicy).toEqual({ enforcement: "client-boundary" });

    const explicit = decodeOrchestrationV2ProviderCapabilities({
      ...legacyCapabilities,
      runtimePolicy: { enforcement: "native" },
    });
    expect(explicit.runtimePolicy).toEqual({ enforcement: "native" });
  });

  it.each(["  indented prompt\n", "\n \t\n"])(
    "preserves workflow prompt and result %j in stored and wire JSON",
    (preview) => {
      const subagent = {
        ...decodeOrchestrationV2Subagent({
          id: "workflow-coordinator",
          threadId: "thread-1",
          runId: "run-1",
          parentNodeId: "node-root-1",
          origin: "provider_native",
          createdBy: "agent",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Run workflow",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }),
        workflow: {
          phases: [],
          agents: [
            {
              index: 1,
              label: "Member",
              state: "completed" as const,
              prompt: preview,
              result: preview,
            },
          ],
        },
      };
      const { workflow, ...coordinator } = subagent;
      const incoming = { ...encodeOrchestrationV2SubagentJson(coordinator), workflow };
      for (const codec of [
        OrchestrationV2SubagentJson,
        Schema.toCodecJson(OrchestrationV2Subagent),
      ]) {
        const encode = Schema.encodeSync(codec);
        const decode = Schema.decodeUnknownSync(codec);
        const json: unknown = JSON.parse(JSON.stringify(encode(subagent)));
        expect(json).toMatchObject({
          workflow: { agents: [{ prompt: preview, result: preview }] },
        });
        expect(decode(json).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
        expect(decode(incoming).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
        });
      }
    },
  );

  describe("workflow plans", () => {
    const coordinator = () =>
      decodeOrchestrationV2Subagent({
        id: "workflow-1",
        threadId: "thread-1",
        runId: "run-1",
        parentNodeId: "node-root-1",
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: "codex",
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "graph",
        title: null,
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      });
    const planned = {
      phases: [{ index: 0, title: "Layer 1" }],
      agents: [
        { index: 0, label: "Build", state: "failed" as const, graphNodeKey: "build" },
        {
          index: 1,
          label: "Check",
          state: "completed" as const,
          judgmentFor: { agentIndex: 0, attempt: 2, graphNodeKey: "build" },
        },
      ],
      plan: {
        nodes: [
          { key: "build", label: "Build", wave: 0, dependsOn: [] },
          { key: "test", label: "Test", wave: 1, dependsOn: ["build"] },
        ],
      },
      nodeOutcomes: {
        build: { status: "failed" as const, reason: "exit code 2", attempts: 3 },
        test: { status: "skipped" as const, reason: "build did not pass" },
      },
    };

    it("round-trips a planned workflow through stored and wire JSON", () => {
      const subagent = { ...coordinator(), workflow: planned };
      for (const codec of [
        OrchestrationV2SubagentJson,
        Schema.toCodecJson(OrchestrationV2Subagent),
      ]) {
        const json: unknown = JSON.parse(JSON.stringify(Schema.encodeSync(codec)(subagent)));
        expect(Schema.decodeUnknownSync(codec)(json).workflow).toEqual(planned);
      }
    });

    it("still decodes a workflow recorded before plans existed", () => {
      const legacy = {
        ...encodeOrchestrationV2SubagentJson(coordinator()),
        workflow: { phases: [], agents: [{ index: 0, label: "Member", state: "completed" }] },
      };
      const decoded = Schema.decodeUnknownSync(OrchestrationV2SubagentJson)(legacy).workflow;
      expect(decoded?.plan).toBeUndefined();
      expect(decoded?.nodeOutcomes).toBeUndefined();
      expect(decoded?.agents[0]?.graphNodeKey).toBeUndefined();
    });

    it.each([
      ["an unknown outcome", { nodeOutcomes: { build: { status: "done" } } }],
      ["a negative wave", { plan: { nodes: [{ key: "a", label: "A", wave: -1, dependsOn: [] }] } }],
    ])("refuses %s", (_name, patch) => {
      const subagent = {
        ...encodeOrchestrationV2SubagentJson(coordinator()),
        workflow: { ...planned, ...patch },
      };
      expect(() => Schema.decodeUnknownSync(OrchestrationV2SubagentJson)(subagent)).toThrow();
    });
  });

  it("decodes historical provider-thread JSON without pendingBackgroundTasks as empty roster", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: "provider-session-1",
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: {
        driver: "claude",
        nativeId: "native-session-1",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
    });

    expect(providerThread.pendingBackgroundTasks).toEqual([]);
    expect(providerThread.contextUsage).toBeNull();
    expect(providerThread.nativeMetadata).toBeNull();

    const runtimeThread = decodeOrchestrationV2ProviderThread({
      id: "provider-thread-2",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-2",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    expect(runtimeThread.pendingBackgroundTasks).toEqual([]);
    expect(runtimeThread.contextUsage).toBeNull();
    expect(runtimeThread.nativeMetadata).toBeNull();
  });
});

describe("thread open stats", () => {
  it("reads a thread whose open stats this build cannot read, without them", () => {
    const shell = {
      id: "thread-test",
      projectId: "project-test",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: "thread-test", parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    };
    const decode = Schema.decodeUnknownSync(OrchestrationV2ThreadShellJson);
    const opens = { openedAt: 1, score: 1, picks: [{ query: "upl", at: 1 }] };
    expect(decode({ ...shell, opens }).opens).toEqual(opens);
    expect(decode({ ...shell, opens: { openedAt: "2026-10-01", score: 1 } }).opens).toBeNull();
  });
});

describe("background work kinds from older or newer servers", () => {
  const storedNotification = (source: unknown) => ({
    id: "notification",
    threadId: "parent",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-09-09T00:00:00.000Z",
    type: "notification",
    outcome: "completed",
    summary: "Background activity updated",
    source,
  });

  it("decodes notification sources stored before specific kinds existed", () => {
    const sourceOf = (source: unknown) => {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      return item.type === "notification" ? item.source : undefined;
    };
    expect(
      sourceOf({ kind: "background_task", nativeRef: { driver: "claude", nativeId: "task-1" } }),
    ).toEqual({ kind: "background_task" });
    expect(sourceOf({ kind: "background_command" })).toEqual({ kind: "command" });
    expect(sourceOf({ kind: "monitor" })).toEqual({ kind: "monitor" });
  });

  it("sends and stores sources that clients from before specific kinds still decode", () => {
    const PreSpecificKindsNotification = Schema.Struct({
      type: Schema.Literal("notification"),
      source: Schema.Union([
        Schema.Struct({ kind: Schema.Literal("delegated_task"), taskIds: Schema.Array(NodeId) }),
        Schema.Struct({
          kind: Schema.Literals(["background_task", "background_command", "monitor"]),
          nativeRef: Schema.optional(Schema.Unknown),
        }),
      ]),
      outcome: Schema.Literals(["completed", "failed", "cancelled", "updated", "unknown"]),
      summary: Schema.String,
      detail: Schema.optional(Schema.String),
    });
    const decodePreSpecificKinds = Schema.decodeUnknownSync(PreSpecificKindsNotification);
    const sendOverWire = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2TurnItem));
    const cases = [
      [{ kind: "subagent", childThreadId: "child" }, { kind: "background_task" }],
      [{ kind: "subagent" }, { kind: "background_task" }],
      [{ kind: "command" }, { kind: "background_command" }],
      [{ kind: "monitor" }, { kind: "monitor" }],
      [{ kind: "background_task" }, { kind: "background_task" }],
      [
        { kind: "delegated_task", taskIds: ["task-1"], childThreadId: "child" },
        { kind: "delegated_task", taskIds: ["task-1"] },
      ],
    ] as const;
    for (const [source, preSpecificKindsSource] of cases) {
      const item = decodeOrchestrationV2TurnItemJson(storedNotification(source));
      for (const encoded of [encodeOrchestrationV2TurnItemJson(item), sendOverWire(item)]) {
        expect(decodePreSpecificKinds(encoded).source).toEqual(preSpecificKindsSource);
        expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      }
      expect(item).toMatchObject({ source });
    }
  });

  it("decodes a notification source kind from a newer server as generic background work", () => {
    const item = decodeOrchestrationV2TurnItemJson(
      storedNotification({ kind: "workflow", workflowId: "wf-1" }),
    );
    expect(item).toMatchObject({ type: "notification", source: { kind: "background_task" } });
  });

  it("decodes rosters stored before kinds existed, and kinds from a newer server, as generic tasks", () => {
    const providerThread = decodeOrchestrationV2ProviderThreadJson({
      id: "provider-thread-1",
      driver: "claude",
      providerInstanceId: "claudeAgent",
      providerSessionId: null,
      appThreadId: "thread-1",
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      pendingBackgroundTasks: [
        { taskId: "bg-1", description: "Background sleep", taskType: "local_bash" },
        { taskId: "bg-2" },
        { taskId: "bg-3", description: "Nightly", kind: "workflow", schedule: "0 3 * * *" },
        { taskId: "bg-4", description: "npm test", kind: "command" },
        { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
        { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
      ],
    });
    expect(providerThread.pendingBackgroundTasks).toEqual([
      { taskId: "bg-1", description: "Background sleep", kind: "background_task" },
      { taskId: "bg-2", kind: "background_task" },
      { taskId: "bg-3", description: "Nightly", kind: "background_task" },
      { taskId: "bg-4", description: "npm test", kind: "command" },
      { taskId: "bg-5", kind: "subagent", childThreadId: "thread-child" },
      { taskId: "bg-6", kind: "subagent", providerInstanceId: "claudeAgent" },
    ]);
    const encoded = encodeOrchestrationV2ProviderThreadJson(providerThread).pendingBackgroundTasks;
    expect(encoded).toEqual(providerThread.pendingBackgroundTasks);
    const decodePreKindsRoster = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          taskId: TrimmedNonEmptyString,
          description: Schema.optional(TrimmedNonEmptyString),
          taskType: Schema.optional(TrimmedNonEmptyString),
        }),
      ),
    );
    expect(decodePreKindsRoster(encoded).map((task) => task.taskId)).toEqual([
      "bg-1",
      "bg-2",
      "bg-3",
      "bg-4",
      "bg-5",
      "bg-6",
    ]);
    expect(() =>
      decodeOrchestrationV2ProviderThreadJson({
        ...encodeOrchestrationV2ProviderThreadJson(providerThread),
        pendingBackgroundTasks: [{ taskId: "", kind: "command" }],
      }),
    ).toThrow();
  });
});

describe("latestProviderTurnForAttempt", () => {
  it("returns the attempt's highest-ordinal turn, as a Codex goal run spans several", () => {
    const turns = [
      { id: "first", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 3 },
      { id: "other", runAttemptId: RunAttemptId.make("other-attempt"), ordinal: 9 },
      { id: "last", runAttemptId: RunAttemptId.make("goal-attempt"), ordinal: 5 },
      { id: "subagent", runAttemptId: null, ordinal: 7 },
    ];
    expect(latestProviderTurnForAttempt(turns, RunAttemptId.make("goal-attempt"))?.id).toBe("last");
    expect(latestProviderTurnForAttempt(turns, null)).toBeUndefined();
  });
});

const decodeApprove = Schema.decodeUnknownSync(
  OrchestrationV2RpcSchemas.approveWorkflowReview.input,
);
const decodeDismiss = Schema.decodeUnknownSync(
  OrchestrationV2RpcSchemas.dismissWorkflowReview.input,
);
const workflowApprovalErrorCodec = Schema.toCodecJson(OrchestrationV2WorkflowApprovalError);
const decodeWorkflowApprovalError = Schema.decodeUnknownSync(workflowApprovalErrorCodec);
const encodeWorkflowApprovalError = Schema.encodeSync(workflowApprovalErrorCodec);

describe("workflow review decisions", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const review = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    reviewId: "review-1",
  };
  it("names the environment, thread, review and digest, and nothing about who decides", () => {
    expect(decodeApprove({ ...review, digest })).toEqual({ ...review, digest });
    // A review with blockers has no digest, and can only be dismissed.
    expect(decodeDismiss({ ...review, digest: null })).toEqual({ ...review, digest: null });
    expect(() => decodeApprove({ ...review, digest: null })).toThrow();
    expect(() => decodeApprove({ ...review, digest: "sha256:abc" })).toThrow();
    for (const missing of ["environmentId", "threadId", "reviewId"] as const) {
      const { [missing]: _removed, ...rest } = review;
      expect(() => decodeApprove({ ...rest, digest })).toThrow();
    }
    // The connection's grant says who is deciding; a claimed actor is not part of the input.
    expect(
      decodeApprove({ ...review, digest, createdBy: "agent", creationSource: "mcp" }),
    ).not.toHaveProperty("createdBy");
  });

  it("keeps its reason across the wire and says each one plainly", () => {
    const reasons = [
      "environment-mismatch",
      "no-pending-request",
      "review-not-found",
      "review-blocked",
      "unavailable",
    ] as const;
    const messages = reasons.map((reason) => {
      const error = new OrchestrationV2WorkflowApprovalError({
        threadId: review.threadId,
        reviewId: review.reviewId,
        reason,
      });
      const decoded = decodeWorkflowApprovalError(encodeWorkflowApprovalError(error));
      expect(decoded.reason).toBe(reason);
      return decoded.message;
    });
    expect(new Set(messages).size).toBe(reasons.length);
  });
});

describe("isOrchestrationV2ActiveWorkflowMember", () => {
  const workflowId = NodeId.make("node:workflow");
  const memberThread = ThreadId.make("thread:member");
  const member = (
    overrides: Partial<{
      origin: "app_owned" | "provider_native";
      parentNodeId: NodeId;
      childThreadId: ThreadId | null;
      status: OrchestrationV2Subagent["status"];
    }> = {},
  ) => ({
    origin: "app_owned" as const,
    parentNodeId: workflowId,
    childThreadId: memberThread as ThreadId | null,
    status: "running" as OrchestrationV2Subagent["status"],
    ...overrides,
  });

  it.each([
    ["idle", false],
    ["pending", true],
    ["running", true],
    ["waiting", true],
    ["completed", false],
    ["failed", false],
    ["cancelled", false],
    ["interrupted", false],
  ] as const)("treats a %s app-owned member of the workflow as active: %s", (status, active) => {
    expect(isOrchestrationV2ActiveWorkflowMember(member({ status }), workflowId)).toBe(active);
    // One rule: membership adds to the shared work-active status, never redefines it.
    expect(isOrchestrationV2WorkActive(status)).toBe(active);
  });

  it("is not a member of the workflow unless it is app-owned, parented to it, and has a thread", () => {
    expect(
      isOrchestrationV2ActiveWorkflowMember(member({ origin: "provider_native" }), workflowId),
    ).toBe(false);
    expect(
      isOrchestrationV2ActiveWorkflowMember(
        member({ parentNodeId: NodeId.make("node:other-workflow") }),
        workflowId,
      ),
    ).toBe(false);
    expect(isOrchestrationV2ActiveWorkflowMember(member({ childThreadId: null }), workflowId)).toBe(
      false,
    );
  });

  it("narrows an active member to the thread the stop must reach", () => {
    const threads = [member(), member({ childThreadId: null }), member({ status: "completed" })]
      .filter((candidate) => isOrchestrationV2ActiveWorkflowMember(candidate, workflowId))
      .map((active) => active.childThreadId);
    expect(threads).toEqual([memberThread]);
  });
});

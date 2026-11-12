import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  EventId,
  type OrchestrationV2WorkflowReviewRecord,
} from "@t3tools/contracts";
import { parseStoredWorkflowScript } from "@t3tools/shared/storedWorkflowScript";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { approvalWorkflowId } from "../orchestration-v2/workflowReviewCommands.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as WorkflowApprovalGate from "../orchestration-v2/WorkflowApprovalGate.ts";
import * as WorkflowApprovalService from "../orchestration-v2/WorkflowApprovalService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  awaitMember,
  completeChild,
  decodeReview,
  decodeWorkflow,
  errorText,
  invocation,
  invoke,
  layerTest,
  modelSelection,
  parentThreadId,
  reviewGraph,
  startParent,
  startParentWithSelection,
  stopChild,
  withServerProcess,
  makeLayerTest,
  provider,
  claudeProvider,
} from "./WorkflowHarness.testkit.ts";

const graph = {
  schemaVersion: 1,
  name: "Reviewed work",
  nodes: {
    a: { subject: "worker", description: "Return the requested result", dependsOn: [] },
  },
};
const askIn = (worktreePath: string | null = null) =>
  Effect.gen(function* () {
    const text = "Plan this as a workflow";
    yield* startParentWithSelection(modelSelection, text, worktreePath);
    yield* (yield* WorkflowApprovalGate.WorkflowApprovalGate).observeTurn({
      threadId: parentThreadId,
      messageId: MessageId.make("message:delegate-tasks:start"),
      typedText: text,
      workflows: true,
      workflowStart: "keyword",
      workflowTriggers: { extras: [] },
      createdBy: "user",
      creationSource: "web",
      delegatedThread: false,
      resumesEarlierTurn: false,
    });
  });
const ask = askIn();
const records = Effect.gen(function* () {
  return yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(parentThreadId);
});
const reviewRecord = (reviewId: string) =>
  records.pipe(
    Effect.map((projection) =>
      projection.turnItems.find(
        (item) => item.type === "workflow_review" && item.reviewId === reviewId,
      ),
    ),
  );
const decision = (review: { readonly reviewId: string; readonly digest: string | null }) => ({
  environmentId: invocation.environmentId,
  threadId: parentThreadId,
  reviewId: review.reviewId,
  digest: review.digest!,
  decisionRevision: 0,
});
const storedReview = (reviewId: string) =>
  records.pipe(
    Effect.map((projection) => {
      const item = projection.turnItems.find(
        (item) => item.type === "workflow_review" && item.reviewId === reviewId,
      );
      if (item?.type !== "workflow_review") throw new Error(`Missing review ${reviewId}`);
      return item;
    }),
  );
const latestDecision = (reviewId: string) =>
  storedReview(reviewId).pipe(
    Effect.map((item) => ({
      ...decision(item),
      decisionRevision: item.decisionRevision ?? 0,
    })),
  );
const personTurn = (messageId: MessageId, typedText: string) => ({
  threadId: parentThreadId,
  messageId,
  typedText,
  workflows: true,
  workflowStart: "keyword" as const,
  workflowTriggers: { extras: [] },
  createdBy: "user" as const,
  creationSource: "web" as const,
  delegatedThread: false,
  resumesEarlierTurn: false,
});
const newRequest = (text = "Plan another workflow", id = "message:request:second") =>
  Effect.gen(function* () {
    const before = yield* records;
    const messageId = MessageId.make(id);
    const original = before.turnItems.find((item) => item.type === "user_message");
    if (original?.type !== "user_message") throw new Error("Missing request item");
    // Persist a delivered user steer; the fake provider does not execute the delivery outbox.
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId: parentThreadId,
          runId: original.runId!,
          occurredAt: yield* DateTime.now,
          payload: {
            ...original,
            id: TurnItemId.make(`item:${id}`),
            messageId,
            text,
            inputIntent: "turn_start",
            ordinal: Math.max(...before.turnItems.map((item) => item.ordinal)) + 1,
          },
        },
      ],
    });
    yield* (yield* WorkflowApprovalGate.WorkflowApprovalGate).observeTurn(
      personTurn(messageId, text),
    );
  });
const workflows = records.pipe(
  Effect.map((projection) => projection.subagents.filter((task) => task.workflow !== undefined)),
);
const awaitDecision = (reviewId: string, state: OrchestrationV2WorkflowReviewRecord["decision"]) =>
  Effect.gen(function* () {
    yield* (yield* Orchestrator.OrchestratorV2)
      .streamStoredEventsFrom({
        threadId: parentThreadId,
        afterSequence: 0,
        eventType: "turn-item.updated",
      })
      .pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "turn-item.updated" &&
            stored.event.payload.type === "workflow_review" &&
            stored.event.payload.reviewId === reviewId &&
            stored.event.payload.decision === state,
        ),
        Stream.runHead,
      );
  });
/** Also establishes a command barrier for assertions that no workflow was launched. */
const settle = Effect.gen(function* () {
  const projection = yield* records;
  const run = projection.runs[0]!;
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "workflow.review.settle",
    commandId: CommandId.make(`test:settle:${run.id}`),
    threadId: parentThreadId,
    runId: run.id,
  });
});
const freshApprovals = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const gate = WorkflowApprovalGate.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (threadId, fields, filter) =>
            orchestrator
              .getThreadRecords(threadId, fields, filter)
              .pipe(
                Effect.mapError(
                  (cause) => new ProjectionStore.ProjectionStoreReadError({ threadId, cause }),
                ),
              ),
        }),
        // A restarted server has no coordinator session or in-memory review registry.
        Layer.mock(McpProviderSessions.McpProviderSessions)({
          read: () => Effect.undefined,
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    Layer.fresh(WorkflowApprovalService.layer.pipe(Layer.provide(gate))),
  );
  return Context.get(context, WorkflowApprovalService.WorkflowApprovalService);
});

describe("server approval launches", () => {
  it.effect.each(["approve", "dismiss"] as const)(
    "%s a persisted review after the workflow service restarts",
    (action) =>
      Effect.gen(function* () {
        yield* ask;
        const reviewed = yield* withServerProcess((service) =>
          service.graphReview(invocation, { graph }),
        );
        yield* completeChild(parentThreadId, "Ready");
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            yield* service.resumeWorkflows;
            const approvals = yield* freshApprovals;
            yield* approvals[action](decision(reviewed));
            expect(yield* storedReview(reviewed.reviewId)).toMatchObject({
              decision: action === "approve" ? "started" : "dismissed",
            });
            expect(yield* workflows).toHaveLength(action === "approve" ? 1 : 0);
            if (action === "approve") yield* awaitMember((yield* workflows)[0]!.id, 1);
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayerTest(
            undefined,
            [provider, claudeProvider],
            undefined,
            undefined,
            undefined,
            false,
          ),
        ),
      ),
  );

  it.effect("recovers consent committed before an interrupted start without another approval", () =>
    Effect.gen(function* () {
      yield* ask;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      let reviewed: Effect.Success<ReturnType<typeof reviewGraph>>;
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          reviewed = yield* service.graphReview(invocation, { graph });
          yield* completeChild(parentThreadId, "Ready");
          const reached = yield* Deferred.make<void>();
          const real = threads.dispatch;
          const spy = vi
            .spyOn(threads, "dispatch")
            .mockImplementation((command) =>
              command.type === "workflow.review.launch"
                ? Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never))
                : real(command),
            );
          const approval = yield* (yield* WorkflowApprovalService.WorkflowApprovalService)
            .approve(decision(reviewed))
            .pipe(Effect.forkChild);
          yield* Deferred.await(reached);
          yield* Fiber.interrupt(approval);
          spy.mockRestore();
        }),
      );
      expect(yield* workflows).toEqual([]);
      expect(yield* storedReview(reviewed!.reviewId)).toMatchObject({ decision: "approved" });
      yield* withServerProcess((service) =>
        Effect.gen(function* () {
          yield* service.resumeWorkflows;
          yield* (yield* WorkflowApprovalService.WorkflowApprovalService).approve(
            decision(reviewed!),
          );
          expect(yield* workflows).toHaveLength(1);
          yield* awaitMember((yield* workflows)[0]!.id, 1);
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayerTest(
          undefined,
          [provider, claudeProvider],
          undefined,
          undefined,
          undefined,
          false,
        ),
      ),
    ),
  );
  it("is shared by one thread, request and digest, and by no other", () => {
    const thread = ThreadId.make("thread:one");
    const request = MessageId.make("request:one");
    const digest = "sha256:one";
    const key = approvalWorkflowId(thread, request, digest);
    expect(approvalWorkflowId(thread, request, digest)).toBe(key);
    expect(
      new Set([
        key,
        approvalWorkflowId(ThreadId.make("thread:two"), request, digest),
        approvalWorkflowId(thread, MessageId.make("request:two"), digest),
        approvalWorkflowId(thread, request, "sha256:two"),
        approvalWorkflowId(ThreadId.make("thread"), MessageId.make("one:request:one"), digest),
      ]).size,
    ).toBe(5);
  });

  it.effect.each([
    { name: "fails before it can launch", interrupted: false, launched: false },
    { name: "is interrupted before it can launch", interrupted: true, launched: false },
    { name: "is interrupted after it launched", interrupted: true, launched: true },
  ])(
    "when a start $name after its workflow was committed, recovery replays one workflow and one member",
    (scenario) =>
      Effect.gen(function* () {
        yield* ask;
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const real = threads.dispatch;
        let reviewed: Awaited<Effect.Success<ReturnType<typeof reviewGraph>>>;
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            reviewed = yield* service.graphReview(invocation, { graph });
            yield* completeChild(parentThreadId, "Ready");
            const reached = yield* Deferred.make<void>();
            const spy = vi.spyOn(threads, "dispatch").mockImplementation((command) => {
              if (command.type !== "workflow.review.launch") return real(command);
              return real(command).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    if (scenario.launched) yield* awaitMember((yield* workflows)[0]!.id, 1);
                    yield* Deferred.succeed(reached, undefined);
                    return yield* scenario.interrupted
                      ? Effect.never
                      : Effect.fail(
                          new Orchestrator.OrchestratorDispatchError({
                            commandId: command.commandId,
                            commandType: command.type,
                            cause: "read after commit failed",
                          }),
                        );
                  }),
                ),
                Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
              );
            });
            const first = yield* approvals
              .approve(decision(reviewed))
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(reached);
            if (scenario.interrupted) yield* Fiber.interrupt(first);
            else expect((yield* Fiber.join(first))._tag).toBe("Failure");
            spy.mockRestore();
            expect(yield* workflows).toHaveLength(1);
          }),
        ).pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, {
            ...threads,
            streamWorkflowStarts: scenario.launched ? threads.streamWorkflowStarts : Stream.empty,
          }),
        );
        const workflowId = (yield* workflows)[0]!.id;
        expect(workflowId).toBe(
          approvalWorkflowId(
            parentThreadId,
            MessageId.make("message:delegate-tasks:start"),
            reviewed!.digest!,
          ),
        );
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            yield* service.resumeWorkflows;
            yield* approvals.approve(decision(reviewed!));
            yield* approvals.approve(decision(reviewed!));
            yield* awaitMember(workflowId, 1);
          }),
        );
        yield* withServerProcess((service) =>
          Effect.gen(function* () {
            yield* service.resumeWorkflows;
            const member = yield* awaitMember(workflowId, 1);
            expect(yield* workflows).toHaveLength(1);
            expect(
              (yield* records).subagents.filter((task) => task.parentNodeId === workflowId),
            ).toHaveLength(1);
            yield* completeChild(member.childThreadId!, "done");
            yield* (yield* Orchestrator.OrchestratorV2)
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
                    stored.event.payload.status === "completed",
                ),
                Stream.runHead,
              );
            expect((yield* service.workflowStatus(invocation, { workflowId })).status).toBe(
              "completed",
            );
          }),
        );
      }).pipe(
        Effect.provide(
          makeLayerTest(
            undefined,
            [provider, claudeProvider],
            undefined,
            undefined,
            undefined,
            false,
          ),
        ),
      ),
  );

  it.effect.each([false, true])(
    "rechecks every reviewed input before any node starts (held=%s)",
    (held) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const file = path.join(root, "input.txt");
        yield* fs.writeFileString(file, "reviewed input");
        yield* askIn(root);
        const reviewed = yield* reviewGraph({
          ...graph,
          nodes: {
            ...graph.nodes,
            b: { subject: "Independent", description: "Unrelated paid work", dependsOn: [] },
            c: {
              subject: "Pinned",
              description: "Read pinned input",
              dependsOn: [],
              inputs: [{ id: "source", kind: "workspace_snapshot", path: "input.txt" }],
            },
          },
        });
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        if (held) yield* approvals.approve(decision(reviewed));
        yield* fs.writeFileString(file, "changed since review");
        yield* completeChild(parentThreadId, "Ready");
        if (held) yield* settle;
        else yield* approvals.approve(decision(reviewed));
        expect(yield* workflows).toEqual([]);
        expect((yield* records).subagents).toEqual([]);
        expect(yield* storedReview(reviewed.reviewId)).toMatchObject({
          decision: "approved",
          launchError: expect.stringMatching(/changed|match/),
        });
        yield* fs.writeFileString(file, "reviewed input");
        yield* approvals.approve(yield* latestDecision(reviewed.reviewId));
        expect(yield* workflows).toHaveLength(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("revisionless approval retries cannot revive authority cleared by Stop", () =>
    Effect.gen(function* () {
      yield* ask;
      const review = yield* reviewGraph(graph);
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const { decisionRevision: _revision, ...revisionless } = decision(review);
      expect((yield* approvals.approve(revisionless).pipe(Effect.flip)).reason).toBe(
        "revision-required",
      );
      yield* approvals.approve(decision(review));
      yield* stopChild(parentThreadId);
      yield* settle;
      expect((yield* approvals.approve(revisionless).pipe(Effect.flip)).reason).toBe(
        "revision-required",
      );
      yield* approvals.approve(decision(review));
      expect(yield* workflows).toEqual([]);
      expect(yield* storedReview(review.reviewId)).toMatchObject({ decision: "awaiting" });
      yield* approvals.approve(yield* latestDecision(review.reviewId));
      expect(yield* workflows).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["thread.archive", "thread.delete"] as const)(
    "%s invalidates pending approvals before an old card can launch",
    (type) =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        yield* approvals.approve(decision(review));
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type,
          commandId: CommandId.make(`command:${type}`),
          threadId: parentThreadId,
        });
        expect(yield* storedReview(review.reviewId)).toMatchObject({ decision: "superseded" });
        expect(
          (yield* approvals.approve(yield* latestDecision(review.reviewId)).pipe(Effect.flip))
            .reason,
        ).toBe("review-superseded");
        expect(yield* workflows).toEqual([]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["dismissed", "lifted"] as const)(
    "is not recorded once the request was %s while it ran",
    (ending) =>
      Effect.gen(function* () {
        yield* ask;
        const first = yield* reviewGraph(graph);
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const reached = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const real = threads.dispatch;
        const spy = vi
          .spyOn(threads, "dispatch")
          .mockImplementation((command) =>
            command.type === "workflow.review.record"
              ? Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(proceed)),
                  Effect.andThen(real(command)),
                )
              : real(command),
          );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const slow = yield* invoke("graph_review", { graph }).pipe(Effect.forkChild);
        yield* Deferred.await(reached);
        if (ending === "dismissed")
          yield* (yield* WorkflowApprovalService.WorkflowApprovalService).dismiss(decision(first));
        else yield* newRequest("Thanks, that is enough");
        yield* Deferred.succeed(proceed, undefined);
        const result = yield* Fiber.join(slow);
        expect(result.isError).toBe(true);
        expect(
          (yield* records).turnItems.filter((item) => item.type === "workflow_review"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["approved", "dismissed"] as const)(
    "keeps a %s decision when the same message starts its run again",
    (state) =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        if (state === "approved") yield* approvals.approve(decision(review));
        else yield* approvals.dismiss(decision(review));
        const gate = yield* WorkflowApprovalGate.WorkflowApprovalGate;
        yield* gate.observeTurn(
          personTurn(MessageId.make("message:delegate-tasks:start"), "Plan this as a workflow"),
        );
        expect(yield* storedReview(review.reviewId)).toMatchObject({
          decision: state,
          decisionRevision: 1,
        });
        if (state === "approved") {
          yield* completeChild(parentThreadId, "Ready");
          yield* settle;
          expect(yield* workflows).toHaveLength(1);
        } else {
          expect(yield* gate.awaitsDecision(parentThreadId)).toBe(false);
          expect(yield* workflows).toEqual([]);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["awaiting", "approved", "dismissed"] as const)(
    "drops every old %s review and decision when a new request has an identical digest",
    (state) =>
      Effect.gen(function* () {
        yield* ask;
        const old = yield* reviewGraph(graph);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        if (state === "approved") yield* approvals.approve(decision(old));
        if (state === "dismissed") yield* approvals.dismiss(decision(old));
        yield* newRequest();
        const current = yield* reviewGraph(graph);
        expect(current.digest).toBe(old.digest);
        for (const action of ["approve", "dismiss"] as const) {
          expect(
            (yield* approvals[action](yield* latestDecision(old.reviewId)).pipe(Effect.flip))
              .reason,
          ).toBe("no-pending-request");
        }
        expect(yield* workflows).toEqual([]);
        expect(yield* storedReview(current.reviewId)).toMatchObject({
          decision: "awaiting",
          decisionRevision: 0,
        });
        // Replay the exact original commands too: cached replies must never consent to the new card.
        yield* approvals.approve(decision(old)).pipe(Effect.exit);
        yield* approvals.dismiss(decision(old)).pipe(Effect.exit);
        expect(yield* workflows).toEqual([]);
        expect(yield* storedReview(current.reviewId)).toMatchObject({
          decision: "awaiting",
          decisionRevision: 0,
        });
        yield* completeChild(parentThreadId, "Replacement ready");
        yield* settle;
        expect(yield* workflows).toEqual([]);
        yield* approvals.approve(decision(current));
        expect(yield* workflows).toHaveLength(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["model", "options"] as const)(
    "keeps refusing a reviewed %s that is gone after approval, without a fallback",
    (removed) => {
      const providers = [provider, claudeProvider];
      return Effect.gen(function* () {
        yield* ask;
        const targeted = {
          ...graph,
          nodes: {
            a: {
              ...graph.nodes.a,
              target: {
                providerInstanceId: provider.instanceId,
                model: modelSelection.model,
                ...(removed === "options" ? { options: [{ id: "effort", value: "high" }] } : {}),
              },
            },
          },
        };
        if (removed === "options")
          providers[0] = {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "effort",
                    label: "Effort",
                    type: "select" as const,
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            })),
          };
        const review = yield* reviewGraph(targeted);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        yield* approvals.approve(decision(review));
        providers[0] =
          removed === "model"
            ? { ...provider, models: [] }
            : {
                ...provider,
                models: provider.models.map((model) => ({
                  ...model,
                  capabilities: { optionDescriptors: [] },
                })),
              };
        yield* completeChild(parentThreadId, "Ready");
        yield* settle;
        expect(yield* workflows).toEqual([]);
        const failed = yield* storedReview(review.reviewId);
        expect(failed).toMatchObject({ decision: "approved", launchError: expect.any(String) });
        yield* approvals.approve(yield* latestDecision(review.reviewId));
        expect(yield* workflows).toEqual([]);
        providers[0] =
          removed === "model"
            ? provider
            : {
                ...provider,
                models: provider.models.map((model) => ({
                  ...model,
                  capabilities: {
                    optionDescriptors: [
                      {
                        id: "effort",
                        label: "Effort",
                        type: "select" as const,
                        options: [{ id: "high", label: "High" }],
                      },
                    ],
                  },
                })),
              };
        yield* approvals.approve(yield* latestDecision(review.reviewId));
        expect(yield* workflows).toHaveLength(1);
        expect((yield* workflows)[0]!.id).toContain(encodeURIComponent(review.digest!));
      }).pipe(Effect.provide(makeLayerTest(undefined, providers)));
    },
  );

  it.effect.each(["fails", "is interrupted"] as const)(
    "keeps the approval, and its one key, when a start %s",
    (how) =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        yield* completeChild(parentThreadId, "Ready");
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const real = threads.dispatch;
        const reached = yield* Deferred.make<void>();
        const spy = vi.spyOn(threads, "dispatch").mockImplementation((command) => {
          if (command.type !== "workflow.review.launch") return real(command);
          return Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(
              how === "fails"
                ? Effect.fail(
                    new Orchestrator.OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause: "start failed",
                    }),
                  )
                : Effect.never,
            ),
          );
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const first = yield* approvals
          .approve(decision(review))
          .pipe(Effect.exit, Effect.forkChild);
        yield* Deferred.await(reached);
        if (how === "is interrupted") yield* Fiber.interrupt(first);
        else expect((yield* Fiber.join(first))._tag).toBe("Failure");
        spy.mockRestore();
        expect(yield* storedReview(review.reviewId)).toMatchObject({
          decision: "approved",
          decisionRevision: 1,
        });
        yield* approvals.approve(decision(review));
        yield* approvals.approve(decision(review));
        expect(yield* workflows).toHaveLength(1);
        yield* awaitMember((yield* workflows)[0]!.id, 1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects approval of no review, blocked, approval-free, or an earlier request", () =>
    Effect.gen(function* () {
      yield* startParent;
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const free = yield* reviewGraph(graph);
      expect((yield* approvals.approve(decision(free)).pipe(Effect.flip)).reason).toBe(
        "no-pending-request",
      );
      expect(
        (yield* approvals.approve({ ...decision(free), reviewId: "missing" }).pipe(Effect.flip))
          .reason,
      ).toBe("review-not-found");
      yield* newRequest();
      const blocked = yield* reviewGraph({
        ...graph,
        nodes: { a: { ...graph.nodes.a, dependsOn: ["a"] } },
      });
      expect((yield* approvals.approve(decision(blocked)).pipe(Effect.flip)).reason).toBe(
        "review-blocked",
      );
      const old = yield* reviewGraph(graph);
      yield* newRequest("Plan a third workflow", "message:request:third");
      expect((yield* approvals.approve(decision(old)).pipe(Effect.flip)).reason).toBe(
        "no-pending-request",
      );
      expect(yield* workflows).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect(
    "binds decisions to their environment, thread, review and digest; blocked plans can still be dismissed",
    () =>
      Effect.gen(function* () {
        yield* ask;
        const reviewed = yield* reviewGraph(graph);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const wrongEnvironment = {
          ...decision(reviewed),
          environmentId: EnvironmentId.make("environment:other"),
        };
        expect((yield* approvals.approve(wrongEnvironment).pipe(Effect.flip)).reason).toBe(
          "environment-mismatch",
        );
        expect(
          (yield* approvals
            .approve({ ...decision(reviewed), threadId: ThreadId.make("thread:missing") })
            .pipe(Effect.flip)).reason,
        ).toBe("no-pending-request");
        expect(
          (yield* approvals
            .approve({ ...decision(reviewed), digest: `sha256:${"0".repeat(64)}` })
            .pipe(Effect.flip)).reason,
        ).toBe("review-not-found");
        expect(
          (yield* approvals
            .approve({ ...decision(reviewed), reviewId: "unknown" })
            .pipe(Effect.flip)).reason,
        ).toBe("review-not-found");
        const blocked = yield* reviewGraph({
          schemaVersion: 1,
          nodes: { a: { subject: "Cycle", description: "work", dependsOn: ["a"] } },
        });
        expect((yield* approvals.approve(decision(blocked)).pipe(Effect.flip)).reason).toBe(
          "review-blocked",
        );
        yield* approvals.approve(decision(reviewed));
        yield* approvals.dismiss(decision(blocked));
        expect(yield* workflows).toEqual([]);
        expect(yield* reviewRecord(reviewed.reviewId)).toMatchObject({ decision: "dismissed" });
        expect((yield* approvals.approve(decision(reviewed)).pipe(Effect.flip)).reason).toBe(
          "no-pending-request",
        );
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("an older blocked card cannot dismiss a request that already started", () =>
    Effect.gen(function* () {
      yield* ask;
      const blocked = yield* reviewGraph({
        schemaVersion: 1,
        nodes: { a: { subject: "Cycle", description: "work", dependsOn: ["a"] } },
      });
      const ready = yield* reviewGraph(graph);
      yield* completeChild(parentThreadId, "Ready");
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      yield* approvals.approve(decision(ready));
      expect(yield* workflows).toHaveLength(1);
      expect((yield* approvals.dismiss(decision(blocked)).pipe(Effect.flip)).reason).toBe(
        "no-pending-request",
      );
      expect(yield* reviewRecord(ready.reviewId)).toMatchObject({ decision: "started" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "retries an approval whose command reply was lost (committed=%s) without another launch",
    (committed) =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        yield* completeChild(parentThreadId, "Ready");
        const threads = yield* ThreadManagementService.ThreadManagementService;
        const real = threads.dispatch;
        let first = true;
        const spy = vi.spyOn(threads, "dispatch").mockImplementation((command) => {
          if (!first || command.type !== "workflow.review.decide") return real(command);
          first = false;
          const lost = Effect.fail(
            new Orchestrator.OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "lost reply",
            }),
          );
          return committed ? real(command).pipe(Effect.andThen(lost)) : lost;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        const input = { ...decision(review), decisionRevision: 0 };
        expect((yield* approvals.approve(input).pipe(Effect.flip)).reason).toBe("unavailable");
        yield* approvals.approve(input);
        yield* approvals.approve(input);
        expect(yield* workflows).toHaveLength(1);
        expect(
          (yield* records).messages.filter((message) => message.creationSource === "server"),
        ).toEqual([]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "approving after planning starts the stored graph, title and budget without another coordinator turn",
    () =>
      Effect.gen(function* () {
        yield* ask;
        const result = yield* invoke("graph_review", {
          graph,
          title: "Approved title",
          budgetTokens: 12345,
        });
        expect(result.isError, errorText(result)).not.toBe(true);
        expect(result.structuredContent, errorText(result)).toBeDefined();
        const reviewed = yield* decodeReview(result.structuredContent);
        yield* completeChild(parentThreadId, "Review this plan");
        const before = yield* records;
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        yield* approvals.approve(decision(reviewed));
        yield* approvals.approve(decision(reviewed));
        const rows = yield* workflows;
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.title).toBe("Approved title");
        const stored = parseStoredWorkflowScript(row.prompt);
        expect(stored.args).toMatchObject({ graph: reviewed.expandedGraph });
        expect(stored.budgetTokens).toBe(12345);
        expect(yield* reviewRecord(reviewed.reviewId)).toMatchObject({
          digest: reviewed.digest,
          decision: "started",
          workflowId: row.id,
        });
        expect((yield* records).runs).toHaveLength(before.runs.length);
        expect(
          (yield* records).messages.filter((message) => message.creationSource === "server"),
        ).toEqual([]);
        const member = yield* awaitMember(row.id, 1);
        yield* completeChild(member.childThreadId!, "done");
        yield* (yield* Orchestrator.OrchestratorV2)
          .streamStoredEventsFrom({ threadId: parentThreadId, afterSequence: 0 })
          .pipe(
            Stream.filter(
              (stored) =>
                (stored.event.type === "subagent.updated" ||
                  stored.event.type === "workflow.updated") &&
                stored.event.payload.id === row.id &&
                stored.event.payload.status === "completed",
            ),
            Stream.runHead,
          );
        expect((yield* workflows)[0]?.status).toBe("completed");
        const completed = yield* records;
        expect(completed.runs[0]?.delegatedCompletion?.delivery?.taskIds).toEqual([row.id]);
        expect(completed.runs[0]?.delegatedCompletion?.nextGeneration).toBe(2);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("holds approval until successful planning completion, then launches once", () =>
    Effect.gen(function* () {
      yield* ask;
      const review = yield* reviewGraph(graph);
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      yield* approvals.approve(decision(review));
      expect(yield* workflows).toEqual([]);
      expect(yield* reviewRecord(review.reviewId)).toMatchObject({ decision: "approved" });
      yield* completeChild(parentThreadId, "Plan finished");
      yield* awaitDecision(review.reviewId, "started");
      yield* approvals.approve(decision(review));
      expect(yield* workflows).toHaveLength(1);
      yield* awaitMember((yield* workflows)[0]!.id, 1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a newer ready review supersedes even an approved plan still held by planning", () =>
    Effect.gen(function* () {
      yield* ask;
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      const old = yield* reviewGraph(graph);
      yield* approvals.approve(decision(old));
      const newer = yield* reviewGraph({ ...graph, name: "Replacement" });
      expect((yield* approvals.approve(decision(old)).pipe(Effect.flip)).reason).toBe(
        "review-superseded",
      );
      yield* completeChild(parentThreadId, "Replacement ready");
      yield* settle;
      expect(yield* workflows).toEqual([]);
      expect(yield* reviewRecord(old.reviewId)).toMatchObject({ decision: "superseded" });
      yield* approvals.approve(decision(newer));
      expect(yield* workflows).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "%s planning clears held approval; one fresh click starts it",
    (status) =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        yield* approvals.approve({ ...decision(review), decisionRevision: 0 });
        expect(yield* reviewRecord(review.reviewId)).toMatchObject({ decision: "approved" });
        yield* completeChild(parentThreadId, "Planning did not complete", { status });
        yield* awaitDecision(review.reviewId, "awaiting");
        expect(yield* workflows).toEqual([]);
        expect(yield* reviewRecord(review.reviewId)).toMatchObject({
          notStartedReason: status,
          decisionRevision: 2,
        });
        // A delayed network retry of the original click cannot undo the clearing.
        yield* approvals.approve({ ...decision(review), decisionRevision: 0 });
        expect(yield* workflows).toEqual([]);
        yield* approvals.approve({ ...decision(review), decisionRevision: 2 });
        expect(yield* workflows).toHaveLength(1);
        yield* awaitMember((yield* workflows)[0]!.id, 1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "Stop clears a held approval, including when the provider reports completed afterward",
    () =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
        yield* approvals.approve(decision(review));
        expect(yield* reviewRecord(review.reviewId)).toMatchObject({ decision: "approved" });
        yield* stopChild(parentThreadId);
        yield* settle;
        expect(yield* workflows).toEqual([]);
        expect(yield* reviewRecord(review.reviewId)).toMatchObject({ decision: "awaiting" });
        yield* approvals.approve({ ...decision(review), decisionRevision: 2 });
        expect(yield* workflows).toHaveLength(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("Dismiss withdraws a held approval and prevents launch after planning succeeds", () =>
    Effect.gen(function* () {
      yield* ask;
      const review = yield* reviewGraph(graph);
      const approvals = yield* WorkflowApprovalService.WorkflowApprovalService;
      yield* approvals.approve(decision(review));
      expect(yield* reviewRecord(review.reviewId)).toMatchObject({ decision: "approved" });
      yield* approvals.dismiss({ ...decision(review), decisionRevision: 1 });
      yield* completeChild(parentThreadId, "Plan ready");
      yield* settle;
      expect(yield* workflows).toEqual([]);
      expect(yield* reviewRecord(review.reviewId)).toMatchObject({ decision: "dismissed" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["approve", "dismiss"] as const)(
    "%s a stored card through fresh services after a restart",
    (action) =>
      Effect.gen(function* () {
        yield* ask;
        const review = yield* reviewGraph(graph);
        yield* completeChild(parentThreadId, "Ready");
        const approvals = yield* freshApprovals;
        yield* approvals[action](decision(review));
        expect(yield* reviewRecord(review.reviewId)).toMatchObject({
          decision: action === "approve" ? "started" : "dismissed",
        });
        expect(yield* workflows).toHaveLength(action === "approve" ? 1 : 0);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("graph_start remains available when no approval is required", () =>
    Effect.gen(function* () {
      yield* startParent;
      const review = yield* reviewGraph(graph);
      expect(review.approvalRequired).toBe(false);
      const started = yield* decodeWorkflow(
        (yield* invoke("graph_start", {
          graph: review.expandedGraph,
          acceptedDigest: review.digest,
        })).structuredContent,
      );
      yield* awaitMember(started.workflowId, 1);
    }).pipe(Effect.provide(layerTest)),
  );
});

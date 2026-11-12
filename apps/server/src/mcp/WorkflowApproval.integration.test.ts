import { describe, expect, it, vi } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type OrchestrationV2WorkflowReviewRecord,
} from "@t3tools/contracts";
import { parseStoredWorkflowScript } from "@t3tools/shared/storedWorkflowScript";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
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
} from "./WorkflowHarness.testkit.ts";

const graph = {
  schemaVersion: 1,
  name: "Reviewed work",
  nodes: {
    a: { subject: "worker", description: "Return the requested result", dependsOn: [] },
  },
};
const ask = Effect.gen(function* () {
  const text = "Plan this as a workflow";
  yield* startParentWithSelection(modelSelection, text);
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
        yield* approvals.approve(decision(review));
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
      yield* approvals.dismiss(decision(review));
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

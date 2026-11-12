/**
 * The approval gate for workflows: graph_start and workflow_start are refused until the person
 * decides on a plan. Turn start owns the live request identity; durable review commands own
 * decisions and launch. A restart reconstructs the request and reads its stored decisions.
 */
import { type EnvironmentId, type MessageId, ThreadId } from "@t3tools/contracts";
import {
  type WorkflowRequest,
  type WorkflowRequestInput,
  workflowRequestOf,
  workflowTurnNote,
} from "@t3tools/provider-core/server/workflowTrigger";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { workflowRequestFromHistory } from "./workflowRequestHistory.ts";

export class WorkflowApprovalRequiredError extends Schema.TaggedError<WorkflowApprovalRequiredError>()(
  "WorkflowApprovalRequiredError",
  {
    threadId: ThreadId,
    reason: Schema.Literals(["needs-approval", "script-not-allowed", "stale-review", "unverified"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Read by the agent that was refused, so it says what to do next. */
  override get message(): string {
    switch (this.reason) {
      case "needs-approval":
        return "The user asked for a workflow and has not approved this graph. End your turn: the user approves the graph_review plan in T3 Code, and the server starts it after planning completes. Wait for its single completion wake.";
      case "script-not-allowed":
        return "The user asked for a workflow, which starts from a reviewed graph that the user approves in T3 Code. Call graph_review with your plan and end your turn. workflow_start is unavailable while the user's request waits for their decision.";
      case "stale-review":
        return "The user's request changed while this graph was being reviewed, so this review was not recorded and cannot be approved. Call graph_review again if the user's latest message still asks for a workflow.";
      case "unverified":
        return "T3 Code could not check whether the user has to approve this first, so it did nothing. Try again.";
    }
  }
}

const isWorkflowApprovalRequiredError = Schema.is(WorkflowApprovalRequiredError);

/**
 * Where a request stands. Only "armed" refuses starts; the other two are settled, and a settled
 * request is never armed again by the same message.
 */
type RequestStatus =
  | { readonly _tag: "armed" }
  | { readonly _tag: "dismissed"; readonly decisionId: string }
  | { readonly _tag: "started" };

/** What the person's triggering message armed. Replaced by the next triggering message. */
interface PendingRequest {
  readonly request: MessageId;
  status: RequestStatus;
}

export interface WorkflowApprovalGateTurn extends WorkflowRequestInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /**
   * The message is a steer into work already under way. It can ask for a workflow like any
   * message, but a plain steer adds to the request that waits and does not lift it.
   */
  readonly steering?: boolean;
}

/** A person's steering message, as it is about to reach a provider turn that is running. */
export interface WorkflowApprovalGateSteer {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  /** The message as stored, before provider context projection: what the person wrote. */
  readonly typedText: string;
  readonly createdBy: WorkflowRequestInput["createdBy"];
  readonly creationSource: WorkflowRequestInput["creationSource"];
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: string | undefined;
}

/**
 * Taken before graph_review does its work and handed back when it records the result, so a
 * review is attached only to the request it began under.
 */
export interface WorkflowReviewTicket {
  readonly threadId: ThreadId;
  readonly requestMessageId?: MessageId;
  /** The request that was armed when the review began, by identity; null when none was. */
  readonly armed: object | null;
}

export interface WorkflowApprovalGateReview {
  readonly environmentId: EnvironmentId;
  /** Produced with the review; the client decides about it by this id and the digest. */
  readonly reviewId: string;
  /** Null when the review could not be digested. */
  readonly digest: string | null;
  readonly ready: boolean;
}

export class WorkflowApprovalGate extends Context.Service<
  WorkflowApprovalGate,
  {
    /**
     * Turn start asks this for every message, before the provider sees it. A request arms the
     * gate, a plain person's message lifts it, and anything else (agent text, wakes, canned
     * replies, resumes) leaves it as it is. A steer arms it the same way but is never a plain
     * message that lifts it. Returns the answer so the caller does not ask the detector again.
     */
    readonly observeTurn: (input: WorkflowApprovalGateTurn) => Effect.Effect<WorkflowRequest>;
    /**
     * Delivering a steer into a running turn asks this before the provider sees it, because a
     * running turn has no turn start. Returns the plan-first note to append to the steer when a
     * person's steer asks for a workflow (and arms the gate), otherwise undefined. A failed read
     * of the thread refuses the delivery rather than guess.
     */
    readonly observeSteer: (
      input: WorkflowApprovalGateSteer,
    ) => Effect.Effect<string | undefined, WorkflowApprovalRequiredError>;
    /**
     * graph_review calls this first, before it reads or hashes anything. The ticket remembers
     * which request was armed at that moment.
     */
    readonly beginReview: (
      threadId: ThreadId,
    ) => Effect.Effect<WorkflowReviewTicket, WorkflowApprovalRequiredError>;
    /**
     * graph_review records what it produced. Returns whether the person has to approve it:
     * true only while the request it began under is still armed. When the request was replaced,
     * lifted or settled meanwhile, nothing is recorded and the review fails as stale: it must
     * not become approvable under another request.
     */
    readonly completeReview: (
      ticket: WorkflowReviewTicket,
      input: WorkflowApprovalGateReview,
    ) => Effect.Effect<{ readonly approvalRequired: boolean }, WorkflowApprovalRequiredError>;
    /** workflow_start: a script has no review the person can approve, so a request refuses it. */
    readonly requireNoRequest: (
      threadId: ThreadId,
    ) => Effect.Effect<void, WorkflowApprovalRequiredError>;
    /**
     * graph_start is available only without a pending approval request. Approval starts the
     * stored plan through the server's command path instead.
     */
    readonly guardGraphStart: <A, E, R>(
      input: { readonly threadId: ThreadId; readonly digest: string },
      start: (startKey: string | undefined) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkflowApprovalRequiredError, R>;
    /**
     * Whether the thread's armed request waits for the person to approve a ready review, with
     * none decided yet. A restart does not change the answer: it is read from the thread's stored
     * reviews and decisions as well as from this process's.
     */
    readonly awaitsDecision: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/orchestration-v2/WorkflowApprovalGate") {}

const armedOf = (request: PendingRequest | null | undefined): PendingRequest | null =>
  request?.status._tag === "armed" ? request : null;

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

  /**
   * A thread's latest request, or null once its latest message is known to ask for none. A
   * thread missing here is one this process has not seen: it is read when first needed.
   * Remembering null matters: without it, a stored message read before a newer one arrived
   * could arm the gate after turn start had already lifted it.
   */
  const pending = new Map<ThreadId, PendingRequest | null>();
  const arm = (request: MessageId): PendingRequest => ({
    request,
    status: { _tag: "armed" },
  });

  /**
   * The request a restart made the gate forget: the thread's latest person-typed message that
   * started a turn or steered one, if `workflowRequestOf` says it asked for a workflow. A plain
   * steer is skipped, as at turn start, where it leaves a waiting request armed. A request
   * dismissed or already started is reconstructed too; load reads its durable decision.
   */
  const persistedRequest = Effect.fn("WorkflowApprovalGate.persistedRequest")(function* (
    threadId: ThreadId,
  ) {
    const settings = yield* serverSettings.getSettings;
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemTypes: ["user_message"],
    });
    const mcpSession = yield* mcpSessions.read(threadId);
    if (mcpSession === undefined) {
      return yield* new WorkflowApprovalRequiredError({ threadId, reason: "unverified" });
    }
    // Without workflows every message reads as ignored; not remembering that lets a later session
    // with workflows read the thread again.
    const workflows = mcpSession.capabilities?.has("workflows") === true;
    if (!workflows) return undefined;
    const delegatedThread = records.thread.lineage.relationshipToParent === "subagent";
    // Project-scoped like at turn start, so both read one message the same way.
    const { workflowStart } = resolveProjectSettings(settings, records.thread.projectId).settings;
    return workflowRequestFromHistory(records, {
      workflows,
      workflowStart,
      workflowTriggers: settings.workflowTriggers,
      delegatedThread,
    });
  });

  /**
   * Makes sure this process knows the thread's latest request: a thread it has not seen is read
   * from its persisted messages once. Whatever turn start or another caller recorded while that
   * read ran is newer and wins. Callers then read `pending` in a synchronous step.
   */
  const loadRequest = Effect.fn("WorkflowApprovalGate.loadRequest")(function* (threadId: ThreadId) {
    if (pending.has(threadId)) return;
    const persisted = yield* persistedRequest(threadId).pipe(
      // A thread that does not exist has no request, and is not worth remembering.
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }),
      Effect.mapError((cause) =>
        isWorkflowApprovalRequiredError(cause)
          ? cause
          : new WorkflowApprovalRequiredError({ threadId, reason: "unverified", cause }),
      ),
    );
    if (persisted === undefined) return;
    yield* Effect.sync(() => {
      if (!pending.has(threadId)) pending.set(threadId, persisted === null ? null : arm(persisted));
    });
  });

  const load = Effect.fn("WorkflowApprovalGate.load")(function* (threadId: ThreadId) {
    yield* loadRequest(threadId);
    const request = pending.get(threadId);
    if (request == null) return;
    const records = yield* projections
      .getThreadRecords(threadId, ["turnItems"], { turnItemTypes: ["workflow_review"] })
      .pipe(
        Effect.mapError(
          (cause) => new WorkflowApprovalRequiredError({ threadId, reason: "unverified", cause }),
        ),
      );
    if (pending.get(threadId) !== request) return;
    for (const item of records.turnItems) {
      if (item.type !== "workflow_review" || item.approvalRequest?.messageId !== request.request)
        continue;
      if (item.decision === "started") request.status = { _tag: "started" };
      if (item.decision === "dismissed")
        request.status = { _tag: "dismissed", decisionId: item.reviewId };
    }
  });

  const observeTurn: WorkflowApprovalGate["Service"]["observeTurn"] = Effect.fn(
    "WorkflowApprovalGate.observeTurn",
  )(function* (input) {
    const request = workflowRequestOf(input);
    yield* Effect.sync(() => {
      if (request === "plain") {
        if (input.steering !== true) pending.set(input.threadId, null);
      } else if (
        request === "requested" &&
        pending.get(input.threadId)?.request !== input.messageId
      ) {
        // The same message again (a retry or a recovery of its run) keeps what the person decided.
        pending.set(input.threadId, arm(input.messageId));
      }
    });
    return request;
  });

  const observeSteer: WorkflowApprovalGate["Service"]["observeSteer"] = Effect.fn(
    "WorkflowApprovalGate.observeSteer",
  )(function* (input) {
    const unverified = (cause: unknown) =>
      new WorkflowApprovalRequiredError({ threadId: input.threadId, reason: "unverified", cause });
    const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(unverified));
    const records = yield* projections
      .getThreadRecords(input.threadId, [])
      .pipe(Effect.mapError(unverified));
    const mcpSession = yield* mcpSessions.read(input.threadId);
    const request = yield* observeTurn({
      workflows: mcpSession?.capabilities?.has("workflows") === true,
      workflowStart: resolveProjectSettings(settings, records.thread.projectId).settings
        .workflowStart,
      workflowTriggers: settings.workflowTriggers,
      typedText: input.typedText,
      createdBy: input.createdBy,
      creationSource: input.creationSource,
      scheduledTaskId: input.scheduledTaskId,
      senderThreadId: input.senderThreadId,
      delegatedThread: records.thread.lineage.relationshipToParent === "subagent",
      resumesEarlierTurn: false,
      steering: true,
      threadId: input.threadId,
      messageId: input.messageId,
    });
    return request === "requested" ? workflowTurnNote() : undefined;
  });

  const beginReview: WorkflowApprovalGate["Service"]["beginReview"] = Effect.fn(
    "WorkflowApprovalGate.beginReview",
  )(function* (threadId) {
    yield* load(threadId);
    return yield* Effect.sync(() => {
      const armed = armedOf(pending.get(threadId));
      return { threadId, armed, ...(armed === null ? {} : { requestMessageId: armed.request }) };
    });
  });

  const completeReview: WorkflowApprovalGate["Service"]["completeReview"] = (ticket, _input) =>
    Effect.suspend((): ReturnType<WorkflowApprovalGate["Service"]["completeReview"]> => {
      const armed = armedOf(pending.get(ticket.threadId));
      if (armed !== ticket.armed) {
        return Effect.fail(
          new WorkflowApprovalRequiredError({ threadId: ticket.threadId, reason: "stale-review" }),
        );
      }
      if (armed === null) return Effect.succeed({ approvalRequired: false });
      return Effect.succeed({ approvalRequired: true });
    });

  const requireNoRequest: WorkflowApprovalGate["Service"]["requireNoRequest"] = Effect.fn(
    "WorkflowApprovalGate.requireNoRequest",
  )(function* (threadId) {
    yield* load(threadId);
    const armed = yield* Effect.sync(() => armedOf(pending.get(threadId)));
    if (armed !== null) {
      return yield* new WorkflowApprovalRequiredError({ threadId, reason: "script-not-allowed" });
    }
  });

  const guardGraphStart: WorkflowApprovalGate["Service"]["guardGraphStart"] = Effect.fn(
    "WorkflowApprovalGate.guardGraphStart",
  )(function* <A, E, R>(
    input: { readonly threadId: ThreadId; readonly digest: string },
    start: (startKey: string | undefined) => Effect.Effect<A, E, R>,
  ) {
    yield* load(input.threadId);
    if (armedOf(pending.get(input.threadId)) !== null) {
      return yield* new WorkflowApprovalRequiredError({
        threadId: input.threadId,
        reason: "needs-approval",
      });
    }
    return yield* start(undefined);
  });

  const awaitsDecision: WorkflowApprovalGate["Service"]["awaitsDecision"] = Effect.fn(
    "WorkflowApprovalGate.awaitsDecision",
  )(function* (threadId) {
    return yield* Effect.gen(function* () {
      yield* load(threadId);
      const request = armedOf(pending.get(threadId));
      if (request === null) return false;
      const records = yield* projections.getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["workflow_review"],
      });
      return records.turnItems.some(
        (item) =>
          item.type === "workflow_review" &&
          item.approvalRequest?.messageId === request.request &&
          item.ready &&
          item.digest !== null &&
          (item.decision === "awaiting" || item.decision === undefined),
      );
    }).pipe(Effect.orElseSucceed(() => false));
  });

  return WorkflowApprovalGate.of({
    observeTurn,
    observeSteer,
    beginReview,
    completeReview,
    requireNoRequest,
    guardGraphStart,
    awaitsDecision,
  });
});

export const layer = Layer.effect(WorkflowApprovalGate, make);

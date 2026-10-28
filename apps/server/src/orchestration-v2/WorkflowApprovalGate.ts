/**
 * The approval gate for workflows: graph_start and workflow_start are refused until the person
 * approves the reviewed graph. State is per thread and in memory, so it cannot outlive the server
 * and nothing else can grant it; a restart re-arms from the latest person-typed request and every
 * review and approval is redone. Approved starts share one start key, so a retry finds its workflow.
 */
import {
  type EnvironmentId,
  type MessageId,
  type OrchestrationV2ApproveWorkflowReviewInput,
  type OrchestrationV2DismissWorkflowReviewInput,
  OrchestrationV2WorkflowApprovalError,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
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

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

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
        return "The user asked for a workflow and has not approved this graph. End your turn: the user reviews your graph_review result in T3 Code and approves it there, and T3 Code then sends you a message with the approved digest. Start only that digest, after that message.";
      case "script-not-allowed":
        return "The user asked for a workflow, which starts from a reviewed graph that the user approves in T3 Code. Call graph_review with your plan and end your turn. workflow_start is unavailable while the user's request waits for their decision.";
      case "stale-review":
        return "The user's request changed while this graph was being reviewed, so this review was not recorded and cannot be approved. Call graph_review again if the user's latest message still asks for a workflow.";
      case "unverified":
        return "T3 Code could not check whether the user has to approve this first, so it did nothing. Try again.";
    }
  }
}

type ApprovalRefusal = OrchestrationV2WorkflowApprovalError["reason"];

interface Review {
  readonly environmentId: EnvironmentId;
  readonly digest: string | null;
  readonly ready: boolean;
}

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
  /** Every review the agent made for this request, by review id. */
  readonly reviews: Map<string, Review>;
  /**
   * Digests the person approved, each with the id of the decision: the review whose approval
   * first covered the digest in this process. Repeated clicks, and approvals of other reviews
   * of the same digest, keep it; a fresh review after a restart brings a new one. It names the
   * message sent about the decision, not the launch (see `startKeyOf`).
   */
  readonly approvals: Map<string, string>;
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

export interface WorkflowApprovalGateDecision {
  /** The request the decision settles, for naming the message sent to the agent. */
  readonly request: MessageId;
  /**
   * Names this decision in the process: stable across repeated and concurrent calls for the
   * same approval or dismissal, new for one made after a restart.
   */
  readonly decisionId: string;
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
     * graph_start, around the whole start. `start` gets the key to use as its clientRequestId, or
     * undefined to keep the caller's. While a request is armed it runs only for an approved digest
     * and a success settles it; afterwards an approved digest keeps its key so a retry finds it.
     */
    readonly guardGraphStart: <A, E, R>(
      input: { readonly threadId: ThreadId; readonly digest: string },
      start: (startKey: string | undefined) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | WorkflowApprovalRequiredError, R>;
    /** The client approved a ready review of the request that is armed. Idempotent. */
    readonly approve: (
      input: OrchestrationV2ApproveWorkflowReviewInput,
    ) => Effect.Effect<WorkflowApprovalGateDecision, OrchestrationV2WorkflowApprovalError>;
    /** The client dismissed the request that is armed. Idempotent. */
    readonly dismiss: (
      input: OrchestrationV2DismissWorkflowReviewInput,
    ) => Effect.Effect<WorkflowApprovalGateDecision, OrchestrationV2WorkflowApprovalError>;
  }
>()("t3/orchestration-v2/WorkflowApprovalGate") {}

/**
 * The one start key of an approved digest: every start of it, in this process or after a restart,
 * uses it. Thread, request message and digest identify the launch; the decision does not.
 */
const startKeyOf = (threadId: ThreadId, request: PendingRequest, digest: string) =>
  `approval:${threadId}:${request.request}:${digest}`;

const armedOf = (request: PendingRequest | null | undefined): PendingRequest | null =>
  request?.status._tag === "armed" ? request : null;

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

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
    reviews: new Map(),
    approvals: new Map(),
  });

  /**
   * The request a restart made the gate forget: the thread's latest person-typed message that
   * started a turn or steered one, if `workflowRequestOf` says it asked for a workflow. A plain
   * steer is skipped, as at turn start, where it leaves a waiting request armed. A request
   * dismissed or already started is armed again, and reviews and approvals are redone.
   */
  const persistedRequest = Effect.fn("WorkflowApprovalGate.persistedRequest")(function* (
    threadId: ThreadId,
  ) {
    const settings = yield* serverSettings.getSettings;
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
      turnItemTypes: ["user_message"],
    });
    const delegatedThread = records.thread.lineage.relationshipToParent === "subagent";
    const runs = new Map(records.runs.map((run) => [run.id, run]));
    const runOf = (runId: RunId | null) => (runId === null ? undefined : runs.get(runId));
    const messages = records.turnItems
      .flatMap((item) => (item.type === "user_message" ? [item] : []))
      .toSorted(
        (left, right) =>
          (runOf(right.runId)?.ordinal ?? 0) - (runOf(left.runId)?.ordinal ?? 0) ||
          right.ordinal - left.ordinal,
      );
    for (const item of messages) {
      const request = workflowRequestOf({
        workflows: settings.workflows,
        workflowTriggers: settings.workflowTriggers,
        typedText: item.text,
        createdBy: item.createdBy,
        creationSource: item.creationSource,
        scheduledTaskId: item.scheduledTaskId,
        senderThreadId: item.senderThreadId,
        delegatedThread,
        resumesEarlierTurn: runOf(item.runId)?.restartContinuationOfRunId !== undefined,
      });
      const steered =
        item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer";
      if (request === "ignored" || (steered && request === "plain")) continue;
      return request === "requested" ? item.messageId : null;
    }
    return null;
  });

  /**
   * Makes sure this process knows the thread's latest request: a thread it has not seen is read
   * from its persisted messages once. Whatever turn start or another caller recorded while that
   * read ran is newer and wins. Callers then read `pending` in a synchronous step.
   */
  const load = Effect.fn("WorkflowApprovalGate.load")(function* (threadId: ThreadId) {
    if (pending.has(threadId)) return;
    const persisted = yield* persistedRequest(threadId).pipe(
      // A thread that does not exist has no request, and is not worth remembering.
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.undefined }),
      Effect.mapError(
        (cause) => new WorkflowApprovalRequiredError({ threadId, reason: "unverified", cause }),
      ),
    );
    if (persisted === undefined) return;
    yield* Effect.sync(() => {
      if (!pending.has(threadId)) pending.set(threadId, persisted === null ? null : arm(persisted));
    });
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
    const request = yield* observeTurn({
      workflows: settings.workflows,
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
    return request === "requested" ? workflowTurnNote(settings.workflowPresets) : undefined;
  });

  const beginReview: WorkflowApprovalGate["Service"]["beginReview"] = Effect.fn(
    "WorkflowApprovalGate.beginReview",
  )(function* (threadId) {
    yield* load(threadId);
    return yield* Effect.sync(() => ({ threadId, armed: armedOf(pending.get(threadId)) }));
  });

  const completeReview: WorkflowApprovalGate["Service"]["completeReview"] = (ticket, input) =>
    Effect.suspend((): ReturnType<WorkflowApprovalGate["Service"]["completeReview"]> => {
      const armed = armedOf(pending.get(ticket.threadId));
      if (armed !== ticket.armed) {
        return Effect.fail(
          new WorkflowApprovalRequiredError({ threadId: ticket.threadId, reason: "stale-review" }),
        );
      }
      if (armed === null) return Effect.succeed({ approvalRequired: false });
      armed.reviews.set(input.reviewId, {
        environmentId: input.environmentId,
        digest: input.digest,
        ready: input.ready,
      });
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
    // Read the request in the same step that decides, so turn start cannot replace it between.
    const route = yield* Effect.sync(
      ():
        | { readonly refused: "needs-approval" }
        | { readonly startKey: string | undefined; readonly settles: PendingRequest | null } => {
        const request = pending.get(input.threadId) ?? null;
        if (request === null) return { startKey: undefined, settles: null };
        const startKey = request.approvals.has(input.digest)
          ? startKeyOf(input.threadId, request, input.digest)
          : undefined;
        if (request.status._tag !== "armed") return { startKey, settles: null };
        if (startKey === undefined) return { refused: "needs-approval" };
        return { startKey, settles: request };
      },
    );
    if ("refused" in route) {
      return yield* new WorkflowApprovalRequiredError({
        threadId: input.threadId,
        reason: route.refused,
      });
    }
    return yield* start(route.startKey).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          // Only a success settles. A failure or an interruption leaves the approval and its key
          // as they were, so the retry is the same start.
          if (route.settles?.status._tag === "armed") route.settles.status = { _tag: "started" };
        }),
      ),
    );
  });

  /**
   * A decision on one review of the thread's latest request: found, checked and applied in one
   * step, so nothing can replace the request between the check and the change.
   */
  const decide = Effect.fn("WorkflowApprovalGate.decide")(function* (
    input: OrchestrationV2ApproveWorkflowReviewInput | OrchestrationV2DismissWorkflowReviewInput,
    apply: (
      request: PendingRequest,
      review: Review,
    ) => { readonly refused: ApprovalRefusal } | { readonly decisionId: string },
  ) {
    const refuse = (reason: ApprovalRefusal, cause?: unknown) =>
      new OrchestrationV2WorkflowApprovalError({
        threadId: input.threadId,
        reviewId: input.reviewId,
        reason,
        ...(cause === undefined ? {} : { cause }),
      });
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((error) => refuse("unavailable", error)),
    );
    if (!settings.workflows) return yield* refuse("no-pending-request");
    yield* load(input.threadId).pipe(Effect.mapError((error) => refuse("unavailable", error)));
    const outcome = yield* Effect.sync(
      (): { readonly refused: ApprovalRefusal } | WorkflowApprovalGateDecision => {
        const request = pending.get(input.threadId);
        if (request === undefined || request === null) return { refused: "no-pending-request" };
        const review = request.reviews.get(input.reviewId);
        if (review === undefined) return { refused: "review-not-found" };
        if (review.environmentId !== input.environmentId)
          return { refused: "environment-mismatch" };
        if (review.digest !== input.digest) return { refused: "review-not-found" };
        const applied = apply(request, review);
        return "refused" in applied ? applied : { request: request.request, ...applied };
      },
    );
    if ("refused" in outcome) return yield* refuse(outcome.refused);
    return outcome;
  });

  const approve: WorkflowApprovalGate["Service"]["approve"] = (input) =>
    decide(input, (request, review) => {
      // A dismissed request is over: the card for it is expired.
      if (request.status._tag === "dismissed") return { refused: "no-pending-request" };
      if (!review.ready || review.digest === null) return { refused: "review-blocked" };
      const approved = request.approvals.get(review.digest);
      // A second click, or another review of the same graph, is the decision already made.
      if (approved !== undefined) return { decisionId: approved };
      if (request.status._tag === "started") return { refused: "no-pending-request" };
      request.approvals.set(review.digest, input.reviewId);
      return { decisionId: input.reviewId };
    });

  const dismiss: WorkflowApprovalGate["Service"]["dismiss"] = (input) =>
    decide(input, (request) => {
      switch (request.status._tag) {
        case "dismissed":
          return { decisionId: request.status.decisionId };
        case "started":
          return { refused: "no-pending-request" };
        case "armed":
          request.status = { _tag: "dismissed", decisionId: input.reviewId };
          return { decisionId: input.reviewId };
      }
    });

  return WorkflowApprovalGate.of({
    observeTurn,
    observeSteer,
    beginReview,
    completeReview,
    requireNoRequest,
    guardGraphStart,
    approve,
    dismiss,
  });
});

export const layer = Layer.effect(WorkflowApprovalGate, make);

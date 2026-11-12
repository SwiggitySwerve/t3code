/**
 * The workflow runner's periodic sweep: it stops an attempt past its deadline, or one whose
 * thread records nothing for too long, so the runner can start it again. A thread that waits for a
 * person's answer to a pending request is not silent in this sense.
 */
import type { NodeId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { WorkflowContext, WorkflowRunnerDeps } from "./workflowRunner.ts";

export interface WaitingAgent {
  readonly childThreadId: ThreadId;
  readonly stallMs: number;
  readonly attemptTimeoutMs?: number;
  /** The thread's last recorded update, and when this runner first saw it. */
  lastUpdatedAt?: number;
  seenAt?: number;
  /** When this runner first saw the attempt, if its thread records no run start. */
  firstSeenAt?: number;
  /**
   * Its deadline passed and a stop request was accepted. A refused request leaves this unset, so
   * the next sweep asks again; the attempt counts as timed out either way (see markTimedOut).
   */
  deadlineStopAccepted?: boolean;
  /** When the runner first asked to stop it; a stop that has not ended it by STOP_GRACE_MS abandons it. */
  stopRequestedAt?: number;
  /** Ends the runner's wait for an attempt its stop could not end. */
  abandon?: () => void;
}

/** How long a stopped attempt may take to end its work before the runner gives it up. */
export const STOP_GRACE_MS = 2 * 60_000;

/** The runner state the sweep reads and marks; a mark settles once the row records it. */
export interface SweptSession {
  waitingAgents(): Iterable<readonly [string, WaitingAgent]>;
  markStalled(taskId: string): Promise<void>;
  markTimedOut(taskId: string): Promise<void>;
}

export const stopStalledAgents = Effect.fn("WorkflowRunner.stopStalledAgents")(function* (
  deps: Pick<WorkflowRunnerDeps, "threads" | "stopAgent">,
  session: SweptSession,
  workflow: WorkflowContext,
) {
  const now = yield* Clock.currentTimeMillis;
  for (const [taskId, agent] of session.waitingAgents()) {
    const shell = yield* deps.threads
      .getThreadShell(agent.childThreadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null) continue;
    // An attempt holds its node while its work runs, so one its stop cannot end would hold it
    // forever. The runner gives it up instead of starting another beside it.
    if (agent.stopRequestedAt !== undefined && now - agent.stopRequestedAt >= STOP_GRACE_MS) {
      agent.abandon?.();
      continue;
    }
    if (agent.deadlineStopAccepted === true) continue;
    // A run still preparing (queued for a running slot, or setting up its checkout) has not
    // started its work: neither its deadline nor its silence counts yet.
    if (shell.activityRunStatus === "preparing") {
      delete agent.seenAt;
      continue;
    }
    if (agent.attemptTimeoutMs !== undefined) {
      // Each attempt is its own thread, so its run's start survives a server restart.
      agent.firstSeenAt ??= now;
      // Never from the request: a run admitted from the queue starts long after it.
      const recorded =
        shell.latestRunStartedAt == null
          ? undefined
          : DateTime.toEpochMillis(shell.latestRunStartedAt);
      // A start stamped later than this runner's clock reads is not trusted.
      const start =
        recorded === undefined || recorded > now
          ? agent.firstSeenAt
          : Math.min(recorded, agent.firstSeenAt);
      if (now - start >= agent.attemptTimeoutMs) {
        // Marked before the stop: the stop can end the attempt before it returns, and the deadline
        // has passed whether or not the stop is accepted.
        yield* Effect.promise(() => session.markTimedOut(taskId));
        agent.stopRequestedAt ??= now;
        const accepted = yield* deps
          .stopAgent(workflow, taskId as NodeId, agent.childThreadId, "timed_out")
          .pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("Unable to stop a workflow agent past its deadline", {
                taskId,
                cause,
              }).pipe(Effect.as(false)),
            ),
          );
        if (accepted) agent.deadlineStopAccepted = true;
        continue;
      }
    }
    // A request waits for a person, so the thread records nothing until they answer. That silence
    // is not a stall; the clock starts again from the answer. The attempt's own deadline still holds.
    if (shell.pendingRuntimeRequest != null) {
      delete agent.seenAt;
      continue;
    }
    // Measured only on this runner's clock: the thread's stamp just has to stop moving.
    const updatedAt = DateTime.toEpochMillis(shell.updatedAt);
    if (agent.seenAt === undefined || agent.lastUpdatedAt !== updatedAt) {
      agent.lastUpdatedAt = updatedAt;
      agent.seenAt = now;
      continue;
    }
    if (now - agent.seenAt < agent.stallMs) continue;
    yield* Effect.promise(() => session.markStalled(taskId));
    agent.stopRequestedAt ??= now;
    yield* deps
      .stopAgent(workflow, taskId as NodeId, agent.childThreadId, "stalled")
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Unable to stop a stalled workflow agent", { taskId, cause }),
        ),
      );
  }
});

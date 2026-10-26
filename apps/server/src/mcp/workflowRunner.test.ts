import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- optional external payload evidence from the test harness, never application IO.
import * as NodeFS from "node:fs";
import { mergeWorkflowPatch } from "@t3tools/shared/workflowUpdate";
import {
  NodeId,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowPlan,
  type OrchestrationV2WorkflowPatch,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  makeWorkflowRunner,
  type WorkflowRunnerDeps,
  type WorkflowAgentOutcome,
} from "./workflowRunner.ts";
import { aggregateWorkflowUsage } from "./workflowUsage.ts";

const threadId = ThreadId.make("thread:workflow-runner");
const workflowId = NodeId.make("workflow:runner-test");

interface HarnessOptions {
  readonly onAwaitRelease?: () => Effect.Effect<unknown>;
  readonly finalization?: Effect.Effect<void>;
  readonly taskId?: (spawned: number) => string;
  readonly onWorkflowUpdate?: (workflow: OrchestrationV2SubagentWorkflow) => Effect.Effect<unknown>;
  readonly usage?: (spawned: number) => ReturnType<typeof aggregateWorkflowUsage>;
  readonly timing?: (spawned: number) => WorkflowAgentOutcome["timing"];
  readonly judgment?: (spawned: number) => boolean;
  readonly model?: (spawned: number) => string | null;
  /** Whether the nth agent (1-based) finishes on its own, and how; otherwise it hangs. */
  readonly finish?: (spawned: number) => "completed" | "failed" | "hang";
  /** Workspace files by path, for declared outputs. */
  readonly files?: Readonly<Record<string, string>>;
  /** What the nth agent (1-based) says last; "ok" otherwise. */
  readonly summary?: (spawned: number) => string;
  /** Why every agent's result misses its schema, when it should. */
  readonly structuredResultError?: string;
  /** Process checks, for callers allowed to run commands. */
  readonly runCommandCheck?: WorkflowRunnerDeps["runCommandCheck"];
  /** Whether the agents' runs have started, rather than waiting for a running slot. */
  readonly started?: boolean;
  /**
   * When (test clock ms) a queued run is released: before it the run is preparing, after it
   * starting, with no start stamp yet and a request stamp from the epoch.
   */
  readonly releasedAt?: number;
  /** Whether the nth stop request (1-based, counting every request) is refused. */
  readonly failStop?: (attempt: number) => boolean;
  /** Whether an accepted stop leaves the agent running, as a provider that finalizes later does. */
  readonly stopLeavesRunning?: boolean;
  /**
   * How the nth workflow.complete dispatch (1-based, counting replays of a stored rejection)
   * fails: "transient", a storage error before any receipt exists, or "decide", a failure while
   * deciding the command, which stores a rejection under its id as the dispatcher does.
   */
  readonly failCompletion?: (attempt: number) => "transient" | "decide" | undefined;
  /** Command ids the dispatcher already rejected, as after an earlier server start. */
  readonly rejectedCommandIds?: ReadonlyArray<string>;
  /** Command ids that belong to another thread's receipt. */
  readonly conflictCommandIds?: ReadonlyArray<string>;
  /** Whether the nth read of the workflow row (1-based) fails. */
  readonly failRead?: (read: number) => boolean;
  /** Settles the row without an event right after the nth completion dispatch fails. */
  readonly settleRowAfterAttempt?: number;
  /** An asynchronous step after the commit, such as the dispatcher's offer of the parent wake. */
  readonly afterCommit?: Effect.Effect<void>;
  /** The file a checker is pointed to cannot be written. */
  readonly failCheckerWrite?: boolean;
}

/** A runner whose agents finish as told, recording what it dispatches and stops. */
const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    // Like the event store: every subscription replays the log, then follows it, and honors its
    // event-type filter, so a runner listening for the wrong type misses the event as in production.
    const log: Array<OrchestrationV2StoredEvent> = [];
    const subscribers: Array<{
      readonly eventType: string | undefined;
      readonly queue: Queue.Queue<OrchestrationV2StoredEvent>;
    }> = [];
    const publish = (stored: OrchestrationV2StoredEvent) =>
      Effect.gen(function* () {
        log.push(stored);
        for (const subscriber of subscribers)
          if (subscriber.eventType === undefined || subscriber.eventType === stored.event.type)
            yield* Queue.offer(subscriber.queue, stored);
      });
    const completed = yield* Deferred.make<string>();
    const statuses = new Map<string, string>();
    const taskUpdates = new Map<string, Queue.Queue<void>>();
    const stops: Array<string> = [];
    const keys = new Map<string, string>();
    // The files the runner stored for checkers, those a checker could read when it started, and
    // those removed afterwards.
    const checkerFiles = new Map<string, string>();
    const readableByChecker: Array<ReadonlyMap<string, string>> = [];
    const removedCheckerFiles: Array<string> = [];
    const firstSpawn = yield* Deferred.make<void>();
    const firstCompletion = yield* Deferred.make<void>();
    const workflowUpdates: Array<OrchestrationV2SubagentWorkflow> = [];
    const workflowCommands: Array<unknown> = [];
    const stopRequests: Array<string> = [];
    const completions: Array<{ readonly commandId: string; readonly result: string }> = [];
    const receipts = new Map<string, "accepted" | "rejected" | "conflict">();
    for (const id of options.rejectedCommandIds ?? []) receipts.set(id, "rejected");
    for (const id of options.conflictCommandIds ?? []) receipts.set(id, "conflict");
    const acceptedCompletions: Array<string> = [];
    let rowReads = 0;
    let spawned = 0;
    const update = (id: string, status: string) => {
      statuses.set(id, status);
      return Effect.gen(function* () {
        const queue = taskUpdates.get(id);
        if (queue !== undefined) yield* Queue.offer(queue, undefined);
        return yield* publish({
          sequence: spawned,
          event: {
            type: "subagent.updated",
            payload: { id, status, result: "ok" } as unknown as OrchestrationV2Subagent,
          },
        } as unknown as OrchestrationV2StoredEvent);
      });
    };
    const threads = {
      streamStoredEventsFrom: (input?: { readonly eventType?: string }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
            for (const stored of log)
              if (input?.eventType === undefined || input.eventType === stored.event.type)
                yield* Queue.offer(queue, stored);
            subscribers.push({ eventType: input?.eventType, queue });
            return Stream.fromQueue(queue);
          }),
        ),
      dispatch: (command: {
        readonly type: string;
        readonly commandId?: string;
        readonly status?: string;
        readonly result?: string;
        readonly workflow?: OrchestrationV2SubagentWorkflow | OrchestrationV2WorkflowPatch;
      }) => {
        if (command.type === "workflow.update" && command.workflow !== undefined) {
          workflowCommands.push(command);
          const workflow =
            "kind" in command.workflow
              ? mergeWorkflowPatch(
                  workflowUpdates.at(-1) ?? { phases: [], agents: [] },
                  command.workflow,
                )
              : command.workflow;
          workflowUpdates.push(workflow);
          if (options.onWorkflowUpdate !== undefined)
            return options.onWorkflowUpdate(workflow).pipe(Effect.as({} as never));
        }
        if (command.type === "workflow.complete") {
          return Effect.gen(function* () {
            const commandId = command.commandId ?? "";
            completions.push({ commandId, result: command.result ?? "" });
            yield* Deferred.succeed(firstCompletion, undefined);
            // Like the dispatcher: a stored rejection answers its id for good, and a failure
            // while deciding a command stores one.
            const receipt = receipts.get(commandId);
            if (receipt === "rejected") {
              return yield* Effect.fail({
                _tag: "OrchestratorCommandPreviouslyRejectedError",
              } as never);
            }
            if (receipt === "conflict") {
              return yield* Effect.fail({ _tag: "OrchestratorCommandIdConflictError" } as never);
            }
            if (receipt === "accepted") return {} as never;
            const failure = options.failCompletion?.(completions.length);
            if (failure !== undefined && options.settleRowAfterAttempt === completions.length) {
              statuses.set(workflowId, "cancelled");
            }
            if (failure === "transient") {
              return yield* Effect.fail({ _tag: "OrchestratorDispatchError" } as never);
            }
            // The domain refuses a row that is no longer running, and that refusal is stored too.
            if (failure === "decide" || (statuses.get(workflowId) ?? "running") !== "running") {
              receipts.set(commandId, "rejected");
              return yield* Effect.fail({
                _tag:
                  failure === "decide"
                    ? "OrchestratorProjectionError"
                    : "OrchestratorDispatchError",
              } as never);
            }
            receipts.set(commandId, "accepted");
            acceptedCompletions.push(commandId);
            // The commit publishes the row's final status; the dispatcher then finishes its work.
            yield* update(workflowId, command.status ?? "completed");
            if (options.afterCommit !== undefined) yield* options.afterCommit;
            yield* Deferred.succeed(completed, command.result ?? "");
            return {} as never;
          });
        }
        return Effect.succeed({} as never);
      },
      getThreadRecords: () =>
        Effect.suspend(() => {
          rowReads += 1;
          if (options.failRead?.(rowReads) === true) {
            return Effect.fail({ _tag: "OrchestratorProjectionError" } as never);
          }
          return Effect.succeed({
            subagents: [{ id: workflowId, status: statuses.get(workflowId) ?? "running" }],
          } as never);
        }),
      // Every attempt's run started at the epoch, which is where the test clock starts.
      getThreadShell: () =>
        options.releasedAt !== undefined
          ? Effect.map(Clock.currentTimeMillis, (now) => ({
              updatedAt: DateTime.makeUnsafe(0),
              latestRunStartedAt: null,
              latestRunRequestedAt: DateTime.makeUnsafe(0),
              activityRunStatus: now < options.releasedAt! ? "preparing" : "starting",
            }))
          : Effect.succeed({
              updatedAt: DateTime.makeUnsafe(0),
              latestRunStartedAt: options.started === false ? null : DateTime.makeUnsafe(0),
              ...(options.started === false ? { activityRunStatus: "preparing" } : {}),
            }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const deps: WorkflowRunnerDeps = {
      threads,
      spawnAgent: (_workflow, item, requestKey) =>
        Effect.gen(function* () {
          spawned += 1;
          keys.set(item.task, requestKey);
          if (item.task.includes("independent checker"))
            readableByChecker.push(new Map(checkerFiles));
          yield* Deferred.succeed(firstSpawn, undefined);
          const taskId = NodeId.make(options.taskId?.(spawned) ?? `node:agent-${spawned}`);
          const finish = options.finish?.(spawned) ?? "completed";
          if (finish !== "hang") yield* update(taskId, finish);
          return {
            taskId,
            childThreadId: ThreadId.make(`thread:agent-${spawned}`),
            model: options.model?.(spawned) ?? null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
          };
        }),
      awaitAgent: (_workflow, taskId, onUpdate) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<void>();
          taskUpdates.set(taskId, queue);
          const read = (): WorkflowAgentOutcome => ({
            status: statuses.get(taskId) ?? "running",
            summary: options.summary?.(Number(taskId.split("-").at(-1))) ?? "ok",
            cancelledByServerRestart: false,
            outcomeCategory: statuses.get(taskId) === "completed" ? "completed" : "cancelled",
            usage: options.usage?.(Number(taskId.split("-").at(-1))) ?? aggregateWorkflowUsage([]),
            timing: options.timing?.(Number(taskId.split("-").at(-1))),
            ...(options.judgment === undefined
              ? {}
              : {
                  structuredResult: {
                    outcome: options.judgment(Number(taskId.split("-").at(-1)))
                      ? "passed"
                      : "failed",
                    reasons: "Checked the result",
                  },
                }),
            ...(options.structuredResultError === undefined
              ? {}
              : { structuredResultError: options.structuredResultError }),
          });
          const initial = read();
          onUpdate(initial);
          if (initial.status !== "running") {
            if (options.finalization !== undefined) yield* options.finalization;
            return initial;
          }
          const ended = yield* Stream.fromQueue(queue).pipe(
            Stream.map(read),
            Stream.tap((outcome) => Effect.sync(() => onUpdate(outcome))),
            Stream.filter((outcome) => outcome.status !== "running"),
            Stream.runHead,
          );
          if (ended._tag === "None") return yield* Effect.die("Missing test outcome");
          if (options.finalization !== undefined) yield* options.finalization;
          return ended.value;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              taskUpdates.delete(taskId);
              if (options.onAwaitRelease !== undefined) yield* options.onAwaitRelease();
            }),
          ),
        ),
      agentStarted: () => Effect.succeed(false),
      canRunCommands: () => Effect.succeed(options.runCommandCheck !== undefined),
      runCommandCheck: options.runCommandCheck ?? (() => Effect.die("unused")),
      readWorkspaceFile: (_workflow, path) => {
        const text = options.files?.[path];
        return Effect.succeed(
          text === undefined
            ? ({ status: "missing" } as const)
            : ({ status: "found", sha256: "0".repeat(64), sizeBytes: text.length, text } as const),
        );
      },
      writeCheckerResult: (_workflow, taskId, text) =>
        options.failCheckerWrite === true
          ? Effect.fail({ code: "orchestration_error", message: "The disk is full." } as never)
          : Effect.sync(() => {
              const path = `.t3/workflow-results/${taskId}.txt`;
              checkerFiles.set(path, text);
              return path;
            }),
      removeCheckerResult: (_workflow, path) =>
        Effect.sync(() => {
          removedCheckerFiles.push(path);
          checkerFiles.delete(path);
        }),
      stopAgent: (_workflow, taskId, _childThreadId, why) =>
        Effect.gen(function* () {
          stopRequests.push(`${taskId}:${why}`);
          if (options.failStop?.(stopRequests.length) === true) {
            return yield* Effect.fail({
              code: "orchestration_error",
              message: "The stop could not be dispatched.",
            } as never);
          }
          stops.push(`${taskId}:${why}`);
          if (options.stopLeavesRunning !== true) yield* update(taskId, "cancelled");
        }),
    };
    return {
      runner: makeWorkflowRunner(deps),
      completed,
      spawned: () => spawned,
      stops,
      /** Every stop the runner asked for, accepted or not. */
      stopRequests,
      /** Every workflow.complete the runner dispatched, accepted or not. */
      completions,
      /** The command ids of the completions the dispatcher committed. */
      acceptedCompletions,
      /** Done once the runner has dispatched its first workflow.complete. */
      firstCompletion,
      keys,
      checkerFiles,
      readableByChecker,
      removedCheckerFiles,
      firstSpawn,
      /** Every row update the runner sent, oldest first. */
      workflowUpdates,
      workflowCommands,
      /** Ends the workflow row as a stop does: a workflow patch carrying the cancelled status. */
      stopWorkflow: () =>
        Effect.sync(() => statuses.set(workflowId, "cancelled")).pipe(
          Effect.andThen(
            publish({
              sequence: spawned,
              event: {
                type: "workflow.updated",
                payload: { id: workflowId, previousRevision: 0, revision: 1, status: "cancelled" },
              },
            } as unknown as OrchestrationV2StoredEvent),
          ),
        ),
      updateAgent: update,
    };
  });

/** Moves the test clock in stall-sweep steps until the workflow completes, at most 2 hours. */
const sweepUntilDone = (completed: Deferred.Deferred<string>) =>
  Effect.gen(function* () {
    for (let step = 0; step < 240 && !(yield* Deferred.isDone(completed)); step += 1) {
      yield* TestClock.adjust("30 seconds");
    }
  });

/** Moves the test clock in steps until the condition holds, at most 240 steps. */
const sweepUntil = (
  reached: () => boolean,
  stepSize: "1 millis" | "1 second" | "30 seconds" = "30 seconds",
) =>
  Effect.gen(function* () {
    for (let step = 0; step < 240 && !reached(); step += 1) {
      yield* TestClock.adjust(stepSize);
    }
  });

const launch = (
  runner: ReturnType<typeof makeWorkflowRunner>,
  source: string,
  plan?: OrchestrationV2WorkflowPlan,
) =>
  runner.launch({
    workflowId,
    threadId,
    source,
    args: null,
    afterSequence: 0,
    ...(plan === undefined ? {} : { plan }),
  });

const twoNodePlan: OrchestrationV2WorkflowPlan = {
  nodes: [
    { key: "a", label: "Node A", wave: 0, dependsOn: [] },
    { key: "b", label: "Node B", wave: 1, dependsOn: ["a"] },
  ],
};

describe("workflow runner", () => {
  it.effect(
    "stops new starts at zero and after parallel overshoot without charging replay twice",
    () =>
      Effect.gen(function* () {
        const zero = yield* makeHarness();
        yield* zero.runner.launch({
          workflowId,
          threadId,
          source: 'return await agent("zero")',
          args: null,
          afterSequence: 0,
          budgetTokens: 0,
        });
        expect(yield* Deferred.await(zero.completed)).toContain("budget of 0 tokens is spent");
        expect(zero.spawned()).toBe(0);
        expect(zero.workflowUpdates.at(-1)?.budget).toEqual({ limit: 0, exhausted: true });
        const parallel = yield* makeHarness({
          usage: () => ({ ...aggregateWorkflowUsage([]), status: "complete", totalTokens: 60 }),
        });
        yield* parallel.runner.launch({
          workflowId,
          threadId,
          source:
            'await parallel([() => agent("a"), () => agent("b")]); return await agent("too late")',
          args: null,
          afterSequence: 0,
          budgetTokens: 100,
        });
        expect(yield* Deferred.await(parallel.completed)).toContain("120 recorded");
        expect(parallel.spawned()).toBe(2);
        expect(
          parallel.workflowUpdates
            .at(-1)
            ?.agents.slice(0, 2)
            .map((agent) => agent.totalTokens),
        ).toEqual([60, 60]);
      }),
  );
  it.effect("uses recorded budget on restart before starting new work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.runner.launch({
        workflowId,
        threadId,
        source: 'return await agent("new work")',
        args: null,
        afterSequence: 0,
        budgetTokens: 50,
        previousWorkflow: {
          phases: [],
          agents: [
            { index: 0, label: "Old", state: "completed", agentId: "old-task", totalTokens: 60 },
          ],
        },
      });
      expect(yield* Deferred.await(harness.completed)).toContain("60 recorded");
      expect(harness.spawned()).toBe(0);
    }),
  );
  it.effect("refuses the agent past the per-workflow limit of 1000", () =>
    Effect.gen(function* () {
      const { runner, completed, spawned } = yield* makeHarness();
      yield* launch(
        runner,
        "let started = 0\ntry { for (let i = 0; i < 1001; i++) { await agent('a' + i); started++ } } catch (error) { return [started, error.message] }",
      );
      const result = JSON.parse(yield* Deferred.await(completed));
      expect(result).toEqual([1000, "This workflow reached its limit of 1000 agents."]);
      expect(spawned()).toBe(1000);
    }),
  );
  it.effect(
    "refuses a process check when the caller cannot run commands, without starting the agent",
    () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness();
        yield* launch(
          runner,
          'return await agent("x", { verify: { type: "process", argv: ["node", "-v"] } })',
        );
        expect(JSON.parse(yield* Deferred.await(completed))).toBeNull();
        expect(spawned()).toBe(0);
      }),
  );

  describe("report: true", () => {
    it.effect("reports a completed agent with its outputs and check", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness({
          files: { "out/result.json": '{"ok":true,"count":2}' },
        });
        yield* launch(
          runner,
          'return await agent("x", { outputs: [{ id: "out", path: "out/result.json" }], verify: { type: "structured", outputId: "out", equals: { "/ok": true } }, report: true })',
        );
        expect(JSON.parse(yield* Deferred.await(completed))).toEqual({
          ok: true,
          result: "ok",
          attempts: 1,
          outputs: { out: { path: "out/result.json", sha256: "0".repeat(64), sizeBytes: 21 } },
          verification: {
            type: "structured",
            outcome: "passed",
            attempts: 1,
            detail: "Every required value is present and equal.",
          },
          reason: null,
        });
      }),
    );
    it.effect("reports a failed agent instead of null, after its retries", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness({ finish: () => "failed" });
        yield* launch(runner, 'return await agent("x", { report: true })');
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({ ok: false, result: null, attempts: 3, outputs: {} });
        expect(report.reason).toBe("ok");
        expect(spawned()).toBe(3);
      }),
    );
    it.effect("leaves the script's result unchanged without report", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness({ finish: () => "failed" });
        yield* launch(runner, 'return await agent("x")');
        expect(JSON.parse(yield* Deferred.await(completed))).toBeNull();
      }),
    );
  });

  describe("structured check on an output file", () => {
    it.effect("fails and retries with feedback when the output is not JSON", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness({
          files: { "out.json": "not json" },
        });
        yield* launch(
          runner,
          'return await agent("x", { outputs: [{ id: "out", path: "out.json" }], verify: { type: "structured", outputId: "out" }, report: true })',
        );
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({
          ok: false,
          attempts: 3,
          verification: { type: "structured", outcome: "failed", attempts: 3 },
        });
        expect(report.verification.detail).toContain("output out (out.json) is not JSON");
        expect(spawned()).toBe(3);
      }),
    );
    it.effect("fails a missing pointer in the output", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness({ files: { "out.json": "{}" } });
        yield* launch(
          runner,
          'return await agent("x", { outputs: [{ id: "out", path: "out.json" }], verify: { type: "structured", outputId: "out", requiredPointers: ["/total"] }, report: true })',
        );
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report.verification).toMatchObject({
          outcome: "failed",
          detail: "/total is missing",
        });
      }),
    );
    it.effect("refuses an outputId the agent does not declare, without starting it", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness();
        yield* launch(
          runner,
          'return await agent("x", { verify: { type: "structured", outputId: "out" }, report: true })',
        );
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({ ok: false, attempts: 0 });
        expect(report.reason).toContain(`verify.outputId "out" is not one of this agent's outputs`);
        expect(spawned()).toBe(0);
      }),
    );
  });

  describe("attemptTimeoutMs", () => {
    it.effect("refuses a deadline outside its range", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness();
        yield* launch(runner, 'return await agent("x", { attemptTimeoutMs: 1000, report: true })');
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report.reason).toContain("attemptTimeoutMs must be a whole number from 60000");
        expect(spawned()).toBe(0);
      }),
    );
    it.effect("stops an attempt past its deadline and starts it again", () =>
      Effect.gen(function* () {
        // The first two attempts hang; the third finishes.
        const { runner, completed, spawned, stops } = yield* makeHarness({
          finish: (n) => (n < 3 ? "hang" : "completed"),
        });
        yield* launch(
          runner,
          'return await agent("x", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        yield* sweepUntilDone(completed);
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({ ok: true, attempts: 3 });
        expect(spawned()).toBe(3);
        expect(stops).toEqual(["node:agent-1:timed_out", "node:agent-2:timed_out"]);
      }),
    );
    it.effect("asks again to stop an attempt past its deadline when the first request failed", () =>
      Effect.gen(function* () {
        // The first attempt hangs until a stop lands; the second finishes.
        const { runner, completed, spawned, stops, stopRequests } = yield* makeHarness({
          finish: (n) => (n < 2 ? "hang" : "completed"),
          failStop: (request) => request === 1,
        });
        yield* launch(
          runner,
          'return await agent("x", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        yield* sweepUntilDone(completed);
        expect(yield* Deferred.isDone(completed)).toBe(true);
        // The deadline still classifies the stopped attempt, so the script gets a second attempt.
        expect(JSON.parse(yield* Deferred.await(completed))).toMatchObject({
          ok: true,
          attempts: 2,
        });
        expect(stopRequests).toEqual(["node:agent-1:timed_out", "node:agent-1:timed_out"]);
        expect(stops).toEqual(["node:agent-1:timed_out"]);
        expect(spawned()).toBe(2);
      }),
    );
    it.effect("does not repeat an accepted deadline stop while the attempt is still ending", () =>
      Effect.gen(function* () {
        const { runner, stopRequests } = yield* makeHarness({
          finish: () => "hang",
          stopLeavesRunning: true,
        });
        yield* launch(
          runner,
          'return await agent("x", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        yield* sweepUntil(() => stopRequests.length > 0);
        yield* sweepUntil(() => false);
        expect(stopRequests).toEqual(["node:agent-1:timed_out"]);
        yield* runner.detachAll;
      }),
    );
    it.effect("fails once every attempt passes its deadline", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness({ finish: () => "hang" });
        yield* launch(
          runner,
          'return await agent("x", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        yield* sweepUntilDone(completed);
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({ ok: false, attempts: 3 });
        expect(report.reason).toBe(
          "Every attempt passed its time budget of 60000 ms and was stopped.",
        );
        expect(spawned()).toBe(3);
      }),
    );
  });

  describe("final completion", () => {
    const completionId = `command:workflow-complete:${workflowId}`;

    it.effect.each([
      { outcome: "a finished script", source: 'return await agent("work")' },
      { outcome: "a failed script", source: 'await agent("work"); throw new Error("boom")' },
    ])("keeps its runner until a failed completion is recorded, for $outcome", ({ source }) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          failCompletion: (attempt) => (attempt <= 2 ? "transient" : undefined),
        });
        yield* launch(harness.runner, source);
        yield* Deferred.await(harness.firstCompletion);
        // The row is still running, so the runner still owns finishing it.
        expect(harness.runner.isRunning(workflowId)).toBe(true);
        yield* sweepUntilDone(harness.completed);
        expect(yield* Deferred.isDone(harness.completed)).toBe(true);
        // Only the completion is retried: the script ran once, and a failure that stored no
        // rejection keeps its id, so the dispatcher records one completion and one wake.
        expect(harness.spawned()).toBe(1);
        expect(harness.completions).toHaveLength(3);
        expect(new Set(harness.completions.map((completion) => completion.commandId)).size).toBe(1);
        expect(new Set(harness.completions.map((completion) => completion.result)).size).toBe(1);
        expect(harness.completions[0]!.commandId).toBe(completionId);
      }),
    );
    it.effect("keeps its runner past twenty failed tries until the row is recorded", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          failCompletion: (attempt) => (attempt <= 30 ? "transient" : undefined),
        });
        yield* launch(harness.runner, 'return await agent("work")');
        yield* Deferred.await(harness.firstCompletion);
        yield* sweepUntil(() => harness.completions.length >= 25);
        // A bounded retry would have let go by now with the row still running.
        expect(harness.completions.length).toBeGreaterThanOrEqual(25);
        expect(harness.runner.isRunning(workflowId)).toBe(true);
        expect(yield* Deferred.isDone(harness.completed)).toBe(false);
        yield* sweepUntilDone(harness.completed);
        expect(yield* Deferred.isDone(harness.completed)).toBe(true);
        expect(harness.completions).toHaveLength(31);
        expect(harness.acceptedCompletions).toHaveLength(1);
        expect(harness.spawned()).toBe(1);
      }),
    );
    it.effect(
      "records its completion under a fresh id after a failed decide stored a rejection",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            failCompletion: (attempt) => (attempt === 1 ? "decide" : undefined),
          });
          yield* launch(harness.runner, 'return await agent("work")');
          yield* sweepUntilDone(harness.completed);
          expect(yield* Deferred.isDone(harness.completed)).toBe(true);
          yield* sweepUntil(() => !harness.runner.isRunning(workflowId), "1 millis");
          const ids = harness.completions.map((completion) => completion.commandId);
          // The first failure leaves no sign of a stored rejection; the second try finds it, and
          // only then does the runner move to a fresh id.
          expect(ids).toHaveLength(3);
          expect(ids.slice(0, 2)).toEqual([completionId, completionId]);
          expect(ids[2]!.startsWith(`${completionId}:`)).toBe(true);
          expect(harness.acceptedCompletions).toEqual([ids[2]]);
          expect(new Set(harness.completions.map((completion) => completion.result)).size).toBe(1);
          expect(harness.spawned()).toBe(1);
          expect(harness.runner.isRunning(workflowId)).toBe(false);
        }),
    );
    it.effect.each([{ kind: "rejected" as const }, { kind: "conflict" as const }])(
      "moves to a fresh id when its id was already spent before this start ($kind)",
      ({ kind }) =>
        Effect.gen(function* () {
          const harness = yield* makeHarness(
            kind === "rejected"
              ? { rejectedCommandIds: [completionId] }
              : { conflictCommandIds: [completionId] },
          );
          yield* launch(harness.runner, 'return await agent("work")');
          yield* sweepUntilDone(harness.completed);
          expect(yield* Deferred.isDone(harness.completed)).toBe(true);
          const ids = harness.completions.map((completion) => completion.commandId);
          expect(ids).toHaveLength(2);
          expect(ids[0]).toBe(completionId);
          expect(ids[1]!.startsWith(`${completionId}:`)).toBe(true);
          expect(harness.acceptedCompletions).toEqual([ids[1]]);
        }),
    );
    it.effect(
      "keeps its id while the row cannot be read, since a refusal alone proves nothing",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({
            failCompletion: (attempt) => (attempt === 1 ? "decide" : undefined),
            failRead: (read) => read <= 2,
          });
          yield* launch(harness.runner, 'return await agent("work")');
          yield* sweepUntilDone(harness.completed);
          expect(yield* Deferred.isDone(harness.completed)).toBe(true);
          const ids = harness.completions.map((completion) => completion.commandId);
          // The runner switches only after a read shows the row still running.
          expect(ids).toHaveLength(4);
          expect(ids.slice(0, 3)).toEqual([completionId, completionId, completionId]);
          expect(ids[3]!.startsWith(`${completionId}:`)).toBe(true);
          expect(harness.acceptedCompletions).toEqual([ids[3]]);
        }),
    );
    it.effect("lets go once a failed try finds the row settled by someone else", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          failCompletion: () => "transient",
          settleRowAfterAttempt: 1,
        });
        yield* launch(harness.runner, 'return await agent("work")');
        yield* Deferred.await(harness.firstCompletion);
        yield* sweepUntil(() => !harness.runner.isRunning(workflowId));
        expect(harness.runner.isRunning(workflowId)).toBe(false);
        expect(harness.completions).toHaveLength(1);
        expect(harness.acceptedCompletions).toHaveLength(0);
      }),
    );
    it.effect("stops retrying the completion when a stop settles the row", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ failCompletion: () => "transient" });
        yield* launch(harness.runner, 'return await agent("work")');
        yield* Deferred.await(harness.firstCompletion);
        yield* harness.stopWorkflow();
        // Single milliseconds: the retry pause cannot elapse, so a retry could only be a bug.
        yield* sweepUntil(() => !harness.runner.isRunning(workflowId), "1 millis");
        expect(harness.runner.isRunning(workflowId)).toBe(false);
        expect(harness.completions).toHaveLength(1);
      }),
    );
    it.effect("stops retrying the completion once the runner is detached", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          failCompletion: (attempt) => (attempt <= 2 ? "transient" : undefined),
        });
        yield* launch(harness.runner, 'return await agent("work")');
        yield* Deferred.await(harness.firstCompletion);
        // One-second steps, so the clock cannot pass the third try before the runner is detached.
        yield* sweepUntil(() => harness.completions.length >= 2, "1 second");
        yield* harness.runner.detachAll;
        yield* sweepUntil(() => false);
        // The third try would have succeeded, so a runner still retrying would have finished.
        expect(harness.completions).toHaveLength(2);
        expect(yield* Deferred.isDone(harness.completed)).toBe(false);
      }),
    );
    it.effect("lets an accepted completion finish its post-commit step despite its own event", () =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        const steps = { started: 0, finished: 0, interrupted: 0 };
        const harness = yield* makeHarness({
          afterCommit: Effect.suspend(() => {
            steps.started += 1;
            return Deferred.await(gate).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  steps.finished += 1;
                }),
              ),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  steps.interrupted += 1;
                }),
              ),
            );
          }),
        });
        yield* launch(harness.runner, 'return await agent("work")');
        yield* Deferred.await(harness.firstCompletion);
        // The commit's event reaches the runner while the post-commit step is still pending.
        yield* sweepUntil(() => false, "1 millis");
        yield* Deferred.succeed(gate, undefined);
        yield* sweepUntil(() => false, "1 millis");
        expect(steps).toEqual({ started: 1, finished: 1, interrupted: 0 });
        expect(harness.completions).toHaveLength(1);
        expect(yield* Deferred.isDone(harness.completed)).toBe(true);
      }),
    );
  });

  it.effect("keys an unlabelled agent by its content, not by when it started", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* launch(first.runner, 'return await parallel([() => agent("a"), () => agent("b")])');
      yield* Deferred.await(first.completed);
      const second = yield* makeHarness();
      yield* launch(second.runner, 'return await parallel([() => agent("b"), () => agent("a")])');
      yield* Deferred.await(second.completed);
      expect(second.keys.get("a")).toBe(first.keys.get("a"));
      expect(second.keys.get("b")).toBe(first.keys.get("b"));
    }),
  );

  it.effect("fails a result that misses its schema even when its other check passes", () =>
    Effect.gen(function* () {
      const { runner, completed, spawned } = yield* makeHarness({
        structuredResultError: "The final message has no json block.",
        runCommandCheck: () => Effect.succeed({ outcome: "passed", detail: "exit code 0" }),
      });
      yield* launch(
        runner,
        'return await agent("x", { schema: { type: "object" }, verify: { type: "process", argv: ["node"] }, report: true })',
      );
      const report = JSON.parse(yield* Deferred.await(completed));
      expect(report).toMatchObject({ ok: false, attempts: 3 });
      expect(report.verification).toMatchObject({ type: "structured", outcome: "failed" });
      expect(spawned()).toBe(3);
    }),
  );

  it.effect("interrupts a running process check when the workflow stops", () =>
    Effect.gen(function* () {
      const interrupted = yield* Deferred.make<void>();
      const checkStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        runCommandCheck: () =>
          Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
      });
      yield* launch(
        harness.runner,
        'return await agent("x", { verify: { type: "process", argv: ["node"] } })',
      );
      yield* Deferred.await(checkStarted);
      yield* harness.stopWorkflow();
      yield* Deferred.await(interrupted);
    }),
  );

  it.effect("does not time out an agent still waiting for a running slot", () =>
    Effect.gen(function* () {
      const { runner, completed, stops } = yield* makeHarness({
        started: false,
        finish: () => "hang",
      });
      yield* launch(runner, 'return await agent("x", { attemptTimeoutMs: 60000, report: true })');
      for (let step = 0; step < 120; step += 1) yield* TestClock.adjust("30 seconds");
      expect(yield* Deferred.isDone(completed)).toBe(false);
      expect(stops).toEqual([]);
    }),
  );

  it.effect("keys a judge by what it judges, not by its worker's generated label", () =>
    Effect.gen(function* () {
      const judged = (order: string) =>
        `return await parallel([${order}].map((p) => () => agent(p, { verify: { type: "judgment", rubric: ["It is right."] } })))`;
      const first = yield* makeHarness();
      yield* launch(first.runner, judged('"a", "b"'));
      yield* Deferred.await(first.completed);
      const second = yield* makeHarness();
      yield* launch(second.runner, judged('"b", "a"'));
      yield* Deferred.await(second.completed);
      const judges = [...first.keys.keys()].filter((task) => task.includes("independent checker"));
      expect(judges.length).toBeGreaterThan(0);
      for (const task of judges) expect(second.keys.get(task)).toBe(first.keys.get(task));
    }),
  );

  it.effect(
    "starts an admitted agent's deadline when it leaves the queue, not at its request",
    () =>
      Effect.gen(function* () {
        const { runner, stops, firstSpawn } = yield* makeHarness({
          releasedAt: 10 * 60_000,
          finish: () => "hang",
        });
        yield* launch(runner, 'return await agent("x", { attemptTimeoutMs: 60000, report: true })');
        yield* Deferred.await(firstSpawn);
        // Ten minutes queued, then the first sweep that sees it starting.
        for (let step = 0; step < 21; step += 1) yield* TestClock.adjust("30 seconds");
        expect(stops).toEqual([]);
        for (let step = 0; step < 20 && stops.length === 0; step += 1) {
          yield* TestClock.adjust("30 seconds");
        }
        expect(stops[0]).toBe("node:agent-1:timed_out");
      }),
  );

  describe("graph plan", () => {
    it.effect("deduplicates a reattached task's history and cumulative tokens", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness({
          taskId: () => "node:agent-1",
          finish: (spawned) => (spawned === 1 ? "failed" : "completed"),
          usage: () => ({ ...aggregateWorkflowUsage([]), status: "complete", totalTokens: 10 }),
        });
        yield* launch(runner, 'await agent("reattach"); return budget.spent');
        expect(JSON.parse(yield* Deferred.await(completed))).toBe(10);
        const worker = workflowUpdates.at(-1)?.agents[0];
        expect(worker?.totalTokens).toBe(10);
        expect(worker?.attemptTaskIds).toEqual(["node:agent-1"]);
        expect(worker?.attemptHistory).toHaveLength(1);
      }),
    );
    it.effect("does not apply execution deadlines while terminal facts are finalizing", () =>
      Effect.gen(function* () {
        const finalization = yield* Deferred.make<void>();
        const observed = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          finish: () => "hang",
          finalization: Deferred.await(finalization),
          onWorkflowUpdate: (workflow) =>
            workflow.agents[0]?.attemptHistory?.[0]?.state === "completed"
              ? Deferred.succeed(observed, undefined)
              : Effect.void,
        });
        yield* launch(harness.runner, 'return await agent("active", { attemptTimeoutMs: 60000 })');
        yield* Deferred.await(harness.firstSpawn);
        yield* harness.updateAgent("node:agent-1", "completed");
        yield* Deferred.await(observed);
        yield* TestClock.adjust("2 minutes");
        expect(harness.stops).toEqual([]);
        yield* Deferred.succeed(finalization, undefined);
        yield* Deferred.await(harness.completed);
      }),
    );
    it.effect.each(["stop", "detach"] as const)(
      "releases an active settlement subscription on %s",
      (reason) =>
        Effect.gen(function* () {
          const observed = yield* Deferred.make<void>();
          const released = yield* Deferred.make<void>();
          const harness = yield* makeHarness({
            finish: () => "hang",
            onWorkflowUpdate: (workflow) =>
              workflow.agents[0]?.attemptHistory?.length
                ? Deferred.succeed(observed, undefined)
                : Effect.void,
            onAwaitRelease: () => Deferred.succeed(released, undefined),
          });
          yield* launch(harness.runner, 'return await agent("active")');
          yield* Deferred.await(observed);
          if (reason === "stop") yield* harness.stopWorkflow();
          else yield* harness.runner.detachAll;
          yield* Deferred.await(released);
          expect(yield* Deferred.isDone(harness.completed)).toBe(false);
        }),
    );
    it.effect("refreshes running attempt timing on child updates without a timer", () =>
      Effect.gen(function* () {
        const initial = yield* Deferred.make<void>();
        const refreshed = yield* Deferred.make<void>();
        let durationMs = 100;
        const harness = yield* makeHarness({
          finish: () => "hang",
          timing: () => ({ startedAt: 0, durationMs, timingComplete: false }),
          onWorkflowUpdate: (workflow) => {
            const duration = workflow.agents[0]?.attemptHistory?.[0]?.durationMs;
            return duration === 100
              ? Deferred.succeed(initial, undefined)
              : duration !== undefined && duration !== 100
                ? Deferred.succeed(refreshed, undefined)
                : Effect.void;
          },
        });
        yield* launch(harness.runner, 'return await agent("running")');
        yield* Deferred.await(initial);
        durationMs = 500;
        yield* harness.updateAgent("node:agent-1", "running");
        yield* Deferred.await(refreshed);
        expect(harness.workflowUpdates.at(-1)?.agents[0]?.attemptHistory?.[0]?.durationMs).toBe(
          500,
        );
        yield* harness.updateAgent("node:agent-1", "completed");
        yield* Deferred.await(harness.completed);
        expect(harness.workflowUpdates.at(-1)?.agents[0]?.attemptHistory?.[0]?.durationMs).toBe(
          500,
        );
      }),
    );
    it.effect(
      "persists each attempt's usage, timing and identity without charging checkers twice",
      () =>
        Effect.gen(function* () {
          const { runner, completed, workflowUpdates } = yield* makeHarness({
            judgment: (spawned) => spawned !== 2,
            model: (spawned) => `model-${spawned}`,
            usage: (spawned) => ({
              ...aggregateWorkflowUsage([]),
              status: "complete",
              totalTokens: spawned * 10,
            }),
            timing: (spawned) => ({
              startedAt: spawned * 10000,
              durationMs: spawned * 1000,
              timingComplete: true,
            }),
          });
          yield* launch(
            runner,
            'return await agent("x", { node: "a", verify: { type: "judgment", rubric: ["Correct"] } })',
            twoNodePlan,
          );
          yield* Deferred.await(completed);
          const [worker, firstJudge, secondJudge] = workflowUpdates.at(-1)!.agents;
          expect(worker?.totalTokens).toBe(40);
          expect(worker?.attemptTaskIds).toEqual(["node:agent-1", "node:agent-3"]);
          expect(worker?.attemptHistory).toEqual([
            {
              taskId: "node:agent-1",
              childThreadId: "thread:agent-1",
              attempt: 0,
              providerInstanceId: "codex",
              model: "model-1",
              state: "completed",
              usageStatus: "complete",
              totalTokens: 10,
              startedAt: 10000,
              durationMs: 1000,
              timingComplete: true,
            },
            {
              taskId: "node:agent-3",
              childThreadId: "thread:agent-3",
              attempt: 1,
              providerInstanceId: "codex",
              model: "model-3",
              state: "completed",
              usageStatus: "complete",
              totalTokens: 30,
              startedAt: 30000,
              durationMs: 3000,
              timingComplete: true,
            },
          ]);
          expect([firstJudge?.judgmentOutcome, secondJudge?.judgmentOutcome]).toEqual([
            "failed",
            "passed",
          ]);
          expect([firstJudge?.totalTokens, secondJudge?.totalTokens]).toEqual([20, 40]);
          // Earlier in-flight snapshots must not acquire later attempts by shared-array mutation.
          const first = workflowUpdates.find(
            (update) => update.agents[0]?.attemptHistory?.length === 1,
          );
          expect(first?.agents[0]?.attemptHistory).toHaveLength(1);
        }),
    );
    it.effect(
      "records the started model and clears a previous model when a retry reports none",
      () =>
        Effect.gen(function* () {
          const { runner, completed, workflowUpdates } = yield* makeHarness({
            finish: (spawned) => (spawned === 1 ? "failed" : "completed"),
            model: (spawned) => (spawned === 1 ? "actual-first-model" : null),
          });
          yield* launch(
            runner,
            'return await agent("x", { node: "a", target: { model: "planned-model" } })',
            twoNodePlan,
          );
          yield* Deferred.await(completed);
          expect(workflowUpdates.at(-1)?.agents[0]?.attemptHistory?.[0]?.model).toBe(
            "actual-first-model",
          );
          expect(workflowUpdates.at(-1)?.agents[0]).toMatchObject({
            childThreadId: "thread:agent-2",
            providerInstanceId: "codex",
          });
          expect(workflowUpdates.at(-1)?.agents[0]?.model).toBeUndefined();
        }),
    );
    it.effect("sends the plan from the first update, then node outcomes and node keys", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness();
        yield* launch(
          runner,
          'node("a", { status: "skipped", reason: "Predecessor x did not pass." }); return await agent("b", { node: "b" })',
          twoNodePlan,
        );
        yield* Deferred.await(completed);
        expect(workflowUpdates[0]?.plan).toEqual(twoNodePlan);
        const last = workflowUpdates.at(-1)!;
        expect(last.nodeOutcomes).toEqual({
          a: { status: "skipped", reason: "Predecessor x did not pass." },
        });
        expect(last.agents.map((agent) => agent.graphNodeKey)).toEqual(["b"]);
      }),
    );

    it.effect("gives a plain script no node() and refuses agent({ node })", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned, workflowUpdates } = yield* makeHarness();
        yield* launch(
          runner,
          'const kind = typeof node; try { await agent("x", { node: "a" }) } catch (error) { return [kind, error.message] }',
        );
        expect(JSON.parse(yield* Deferred.await(completed))).toEqual([
          "undefined",
          "agent() takes a graph node only in a workflow started from a reviewed graph.",
        ]);
        expect(spawned()).toBe(0);
        expect(workflowUpdates.every((update) => update.plan === undefined)).toBe(true);
      }),
    );

    it.effect(
      "keeps the digests of a node's inputs and the path, size and sha256 of its outputs",
      () =>
        Effect.gen(function* () {
          const { runner, completed, workflowUpdates } = yield* makeHarness();
          const inputs = { source: "a".repeat(64) };
          const outputs = { out: { path: "out/a.md", sha256: "b".repeat(64), sizeBytes: 42 } };
          yield* launch(
            runner,
            `node("a", { status: "passed", attempts: 1, inputs: ${JSON.stringify(inputs)}, outputs: ${JSON.stringify(outputs)} }); return 1`,
            twoNodePlan,
          );
          yield* Deferred.await(completed);
          expect(workflowUpdates.at(-1)!.nodeOutcomes).toEqual({
            a: { status: "passed", attempts: 1, inputs, outputs },
          });
        }),
    );

    it.effect("refuses an output without a sha256 or with a negative size", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness();
        yield* launch(
          runner,
          `const errors = [];
for (const outputs of [{ out: { path: "p", sizeBytes: 1 } }, { out: { path: "p", sha256: "x", sizeBytes: -1 } }]) {
  try { node("a", { status: "passed", outputs }); errors.push(null) } catch (error) { errors.push(error.message) }
}
return errors`,
          twoNodePlan,
        );
        expect(JSON.parse(yield* Deferred.await(completed))).toEqual([
          "node() needs an outcome with status passed, failed or skipped.",
          "node() needs an outcome with status passed, failed or skipped.",
        ]);
      }),
    );

    it.effect("refuses a node outside the plan and an invalid outcome", () =>
      Effect.gen(function* () {
        const { runner, completed, spawned } = yield* makeHarness();
        yield* launch(
          runner,
          `const errors = [];
for (const call of [
  () => node("zz", { status: "passed" }),
  () => node("a", { status: "done" }),
]) { try { call(); errors.push(null) } catch (error) { errors.push(error.message) } }
try { await agent("x", { node: "zz" }) } catch (error) { errors.push(error.message) }
return errors`,
          twoNodePlan,
        );
        expect(JSON.parse(yield* Deferred.await(completed))).toEqual([
          'node() got node "zz", which is not in this graph.',
          "node() needs an outcome with status passed, failed or skipped.",
          'agent() got node "zz", which is not in this graph.',
        ]);
        expect(spawned()).toBe(0);
      }),
    );

    it.effect("caps a node's reason and lets a later record replace it", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness();
        yield* launch(
          runner,
          'node("a", { status: "failed", reason: "x".repeat(5000) }); node("b", { status: "failed", reason: "first" }); node("b", { status: "passed", attempts: 1 }); return 1',
          twoNodePlan,
        );
        yield* Deferred.await(completed);
        const outcomes = workflowUpdates.at(-1)!.nodeOutcomes!;
        expect(outcomes.a?.reason?.length).toBeLessThanOrEqual(500);
        expect(outcomes.b).toEqual({ status: "passed", attempts: 1 });
      }),
    );

    it.effect("tags the worker and checker with explicit node and attempt identity", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness();
        yield* launch(
          runner,
          'return await agent("x", { node: "a", verify: { type: "judgment", rubric: ["It is right."] }, report: true })',
          twoNodePlan,
        );
        yield* Deferred.await(completed);
        const agents = workflowUpdates.at(-1)!.agents;
        expect(agents.length).toBeGreaterThan(1);
        expect(agents.map((agent) => agent.graphNodeKey ?? null)).toEqual([
          "a",
          ...agents.slice(1).map(() => null),
        ]);
        expect(agents.slice(1).map((agent) => agent.judgmentFor)).toEqual(
          agents.slice(1).map((_, attempt) => ({ agentIndex: 0, attempt, graphNodeKey: "a" })),
        );
      }),
    );

    it.effect(
      "gives a node that is never judged good one worker row and a judge row per attempt",
      () =>
        Effect.gen(function* () {
          const { runner, completed, workflowUpdates, spawned } = yield* makeHarness({
            judgment: () => false,
          });
          yield* launch(
            runner,
            'return await agent("x", { node: "a", verify: { type: "judgment", rubric: ["Correct"] } })',
            twoNodePlan,
          );
          yield* Deferred.await(completed);
          // Graph review budgets this worst case against the workflow's agent capacity.
          const agents = workflowUpdates.at(-1)!.agents;
          expect(agents.map((agent) => agent.judgmentFor?.attempt ?? "worker")).toEqual([
            "worker",
            0,
            1,
            2,
          ]);
          expect(spawned()).toBe(6);
        }),
    );
    it.effect(
      "keeps checker associations through a judgment retry and duplicate worker labels",
      () =>
        Effect.gen(function* () {
          const { runner, completed, workflowUpdates } = yield* makeHarness({
            judgment: (spawned) => spawned !== 2,
          });
          yield* launch(
            runner,
            `
          await agent("first", { node: "a", label: "same", verify: { type: "judgment", rubric: ["Correct"] } });
          return await agent("second", { node: "b", label: "same", verify: { type: "judgment", rubric: ["Correct"] } });
        `,
            twoNodePlan,
          );
          yield* Deferred.await(completed);
          const agents = workflowUpdates.at(-1)!.agents;
          expect(agents.map((agent) => [agent.graphNodeKey, agent.judgmentFor])).toEqual([
            ["a", undefined],
            [undefined, { agentIndex: 0, attempt: 0, graphNodeKey: "a" }],
            [undefined, { agentIndex: 0, attempt: 1, graphNodeKey: "a" }],
            ["b", undefined],
            [undefined, { agentIndex: 3, attempt: 0, graphNodeKey: "b" }],
          ]);
          expect(agents.map((agent) => agent.childThreadId)).toEqual([
            "thread:agent-3",
            "thread:agent-2",
            "thread:agent-4",
            "thread:agent-5",
            "thread:agent-6",
          ]);
        }),
    );

    it.effect("measures a realistic 150-node UTF-8 workflow", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          finish: (n) => (n % 3 === 0 ? "failed" : "completed"),
          usage: () => ({ ...aggregateWorkflowUsage([]), status: "complete", totalTokens: 12345 }),
          timing: () => ({ durationMs: 3210, timingComplete: true }),
          model: () => "gpt-6.1-sol",
        });
        const plan = {
          nodes: Array.from({ length: 150 }, (_, index) => ({
            key: `node-${index}`,
            label: `Audit ${index}: données 日本語 🧪`,
            wave: Math.floor(index / 10),
            dependsOn: index < 10 ? [] : [`node-${index - 10}`],
          })),
        };
        const source = `await parallel(${JSON.stringify(plan.nodes.map((node) => node.key))}.map((key) => async () => {
          await agent(key + " données 日本語 🧪".repeat(100), { node: key, label: key });
          node(key, { status: "failed", reason: "raison 日本語 🧪".repeat(100), attempts: 3 });
        }))`;
        yield* launch(harness.runner, source, plan);
        yield* Deferred.await(harness.completed);
        const commands = harness.workflowCommands;
        const sizes = commands.map((command) => Buffer.byteLength(JSON.stringify(command), "utf8"));
        if (process.env.C7_PAYLOAD_ARTIFACT) {
          NodeFS.writeFileSync(
            process.env.C7_PAYLOAD_ARTIFACT,
            JSON.stringify(
              {
                boundary: "actual workflow runner dispatch commands",
                sizes,
                maxBytes: Math.max(...sizes),
                source,
                plan,
                commands,
              },
              null,
              2,
            ),
          );
        }
        expect(harness.workflowUpdates.at(-1)?.agents).toHaveLength(150);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
      }),
    );
  });

  describe("bounded handoff", () => {
    const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

    const graphLookalike = `const nodes = {};
           for (let index = 0; index < 40; index += 1) {
             const key = "node-" + String(index).padStart(2, "0");
             nodes[key] = {
               status: "passed", attempts: 1, inputs: { in: "a".repeat(64) },
               outputs: { out: { path: "out/" + key + ".md", sha256: "b".repeat(64), sizeBytes: 10 } },
               verification: { type: "judgment", outcome: "passed", attempts: 1, detail: "d".repeat(2000) },
             };
           }
           return { ok: true, nodes };`;

    it.effect(
      "keeps the full record of a graph resumed under an older driver, which stores no per-node provenance",
      () =>
        Effect.gen(function* () {
          const { runner, completed } = yield* makeHarness();
          // A plan with a driver other than the current one: a graph started before this change.
          yield* launch(runner, graphLookalike, twoNodePlan);
          const text = yield* Deferred.await(completed);
          expect(byteLength(text)).toBeLessThanOrEqual(16_000);
          expect(text).toContain("sha256");
          expect(text).not.toContain(`workflow_status workflowId=${workflowId}`);
        }),
    );
    it.effect("keeps every field of a plain script's result that looks like a graph record", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness();
        yield* launch(
          runner,
          'return { ok: true, nodes: { a: { status: "passed", attempts: 1, data: { keep: "me" } } }, notes: "mine" }',
        );
        // No plan: this is a script, so the result is its own JSON, whatever its shape.
        expect(JSON.parse(yield* Deferred.await(completed))).toEqual({
          ok: true,
          nodes: { a: { status: "passed", attempts: 1, data: { keep: "me" } } },
          notes: "mine",
        });
      }),
    );
    it.effect(
      "keeps a large graph-looking script result as a script result, cut at 16,000 bytes",
      () =>
        Effect.gen(function* () {
          const { runner, completed } = yield* makeHarness();
          yield* launch(runner, graphLookalike);
          const text = yield* Deferred.await(completed);
          expect(byteLength(text)).toBeLessThanOrEqual(16_000);
          expect(text).toContain("sha256");
          expect(text).toContain("return a file path for large results");
        }),
    );
    it.effect("cuts a 20 KB script failure to 4,096 bytes, marker included", () =>
      Effect.gen(function* () {
        const { runner, completed, completions } = yield* makeHarness();
        yield* launch(runner, 'throw new Error("e".repeat(20000))');
        const text = yield* Deferred.await(completed);
        expect(completions[0]?.result).toBe(text);
        expect(byteLength(text)).toBeLessThanOrEqual(4_096);
        expect(text.startsWith("The workflow failed: eee")).toBe(true);
        expect(text).toMatch(/\.\.\.truncated \(\d+ of \d+ bytes\)$/);
      }),
    );
    it.effect("tells a script to return a file path when its result is cut at 16,000 bytes", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness();
        yield* launch(runner, 'return "x".repeat(40000)');
        const text = yield* Deferred.await(completed);
        expect(byteLength(text)).toBeLessThanOrEqual(16_000);
        expect(text).toContain("return a file path for large results");
      }),
    );
    it.effect.each([
      { name: "ASCII", summary: "s".repeat(10_000) },
      { name: "four-byte code points", summary: "😀".repeat(3_000) },
    ])("stores an agent's result in at most 2,048 bytes with a marker, for $name", ({ summary }) =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness({
          summary: () => summary,
          taskId: () => "node:agent-1",
        });
        yield* launch(runner, 'return (await agent("work")).length');
        // The script still receives the agent's whole answer.
        expect(JSON.parse(yield* Deferred.await(completed))).toBe(summary.length);
        const stored = workflowUpdates.at(-1)?.agents[0]?.result ?? "";
        expect(byteLength(stored)).toBeLessThanOrEqual(2_048);
        expect(stored).not.toContain("\uFFFD");
        expect(stored).toMatch(
          /\.\.\.truncated \(\d+ of \d+ bytes\), full output at task_status taskId=node:agent-1$/,
        );
      }),
    );
    it.effect.each([
      { name: "ASCII", answer: "a".repeat(130_000) },
      { name: "four-byte code points", answer: "😀".repeat(40_000) },
    ])("gives a checker a cut, delimited result when the answer is long, for $name", ({ answer }) =>
      Effect.gen(function* () {
        const { runner, completed, keys, workflowUpdates, readableByChecker, removedCheckerFiles } =
          yield* makeHarness({
            judgment: () => true,
            summary: (spawned) => (spawned === 1 ? answer : "ok"),
            taskId: (spawned) => `node:agent-${spawned}`,
          });
        yield* launch(
          runner,
          'return (await agent("work", { verify: { type: "judgment", rubric: ["It is right."] } }))?.length ?? null',
        );
        // The script still receives the agent's whole answer.
        expect(JSON.parse(yield* Deferred.await(completed))).toBe(answer.length);
        const judge = [...keys.keys()].find((task) => task.includes("independent checker"));
        expect(judge).toBeDefined();
        // The checker's task has a 120,000 character limit.
        expect(judge!.length).toBeLessThan(120_000);
        const block = judge!.slice(judge!.indexOf('<t3-result v="1">'));
        const body = block.slice(block.indexOf("\n") + 1, block.indexOf("\n</t3-result>"));
        expect(byteLength(body)).toBeLessThanOrEqual(24_000);
        expect(body).not.toContain("\uFFFD");
        // A checker cannot read the answer's task, so the marker names a file it can read.
        const pointer = ".t3/workflow-results/node:agent-1.txt";
        expect(body).toMatch(
          /\.\.\.truncated \(\d+ of \d+ bytes\), full output at \.t3\/workflow-results\/node:agent-1\.txt$/,
        );
        expect(body).not.toContain("task_status");
        // The file existed, holding the answer (within the file bound), when the checker started,
        // and is gone once the check is over.
        expect(readableByChecker).toHaveLength(1);
        const stored = readableByChecker[0]!.get(pointer)!;
        expect(stored.startsWith(answer.slice(0, 1_000))).toBe(true);
        expect(removedCheckerFiles).toEqual([pointer]);
        expect(workflowUpdates.at(-1)?.agents[0]?.verification).toMatchObject({
          type: "judgment",
          outcome: "passed",
        });
      }),
    );
    it.effect("stores no file for a checker when the whole answer fits in its prompt", () =>
      Effect.gen(function* () {
        const { runner, completed, keys, readableByChecker, removedCheckerFiles } =
          yield* makeHarness({ judgment: () => true, summary: () => "a haiku" });
        yield* launch(
          runner,
          'await agent("work", { verify: { type: "judgment", rubric: ["It is right."] } })',
        );
        yield* Deferred.await(completed);
        const judge = [...keys.keys()].find((task) => task.includes("independent checker"))!;
        expect(judge).toContain('<t3-result v="1">\na haiku\n</t3-result>');
        expect(judge).not.toContain("workflow-results");
        expect(readableByChecker).toEqual([new Map()]);
        expect(removedCheckerFiles).toEqual([]);
      }),
    );
    it.effect(
      "bounds the checker's file by the declared-file bound and says where the rest is",
      () =>
        Effect.gen(function* () {
          const answer = "a".repeat(300_000);
          const { runner, completed, readableByChecker } = yield* makeHarness({
            judgment: () => true,
            summary: (spawned) => (spawned === 1 ? answer : "ok"),
          });
          yield* launch(
            runner,
            'await agent("work", { verify: { type: "judgment", rubric: ["It is right."] } })',
          );
          yield* Deferred.await(completed);
          const stored = readableByChecker[0]!.get(".t3/workflow-results/node:agent-1.txt")!;
          expect(byteLength(stored)).toBeLessThanOrEqual(256 * 1024);
          expect(stored).toMatch(
            /\.\.\.truncated \(\d+ of 300000 bytes\), full output at task_status taskId=node:agent-1$/,
          );
        }),
    );
    it.effect(
      "still judges a long answer, cut and unpointed, when the file cannot be written",
      () =>
        Effect.gen(function* () {
          const { runner, completed, keys, workflowUpdates, removedCheckerFiles } =
            yield* makeHarness({
              judgment: () => true,
              summary: (spawned) => (spawned === 1 ? "a".repeat(130_000) : "ok"),
              failCheckerWrite: true,
            });
          yield* launch(
            runner,
            'await agent("work", { verify: { type: "judgment", rubric: ["It is right."] } })',
          );
          yield* Deferred.await(completed);
          const judge = [...keys.keys()].find((task) => task.includes("independent checker"))!;
          const block = judge.slice(judge.indexOf('<t3-result v="1">'));
          const body = block.slice(block.indexOf("\n") + 1, block.indexOf("\n</t3-result>"));
          expect(body).toMatch(/\.\.\.truncated \(\d+ of 130000 bytes\)$/);
          expect(judge).not.toContain("read that file");
          expect(removedCheckerFiles).toEqual([]);
          expect(workflowUpdates.at(-1)?.agents[0]?.verification).toMatchObject({
            outcome: "passed",
          });
        }),
    );
    it.effect("keeps a short agent result as it is", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness({
          summary: () => "Wrote out/a.md; nothing blocked.",
        });
        yield* launch(runner, 'return await agent("work")');
        yield* Deferred.await(completed);
        expect(workflowUpdates.at(-1)?.agents[0]?.result).toBe("Wrote out/a.md; nothing blocked.");
      }),
    );
    it.effect("bounds a failed check's recorded detail by bytes and says it was cut", () =>
      Effect.gen(function* () {
        const { runner, completed } = yield* makeHarness({
          structuredResultError: "é".repeat(5_000),
        });
        yield* launch(
          runner,
          'return await agent("x", { schema: { type: "object" }, report: true })',
        );
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(byteLength(report.verification.detail)).toBeLessThanOrEqual(2_048);
        expect(report.verification.detail).toMatch(/\.\.\.truncated \(\d+ of 10000 bytes\)$/);
      }),
    );
  });

  describe("declared-input handoff", () => {
    const byteLength = (text: string) => Buffer.byteLength(text, "utf8");
    const threeNodePlan: OrchestrationV2WorkflowPlan = {
      nodes: [
        { key: "a", label: "Node A", wave: 0, dependsOn: [] },
        { key: "b", label: "Node B", wave: 1, dependsOn: ["a"] },
        { key: "c", label: "Node C", wave: 1, dependsOn: ["a"] },
      ],
    };
    const source = (inputExtras: string) => `
      await agent("write notes", { node: "a", outputs: [{ id: "notes", path: "out/a.md" }] });
      await agent("read notes", { node: "b", inputs: [{ id: "notes", path: "out/a.md"${inputExtras} }] });
      await agent("unrelated", { node: "c" });
      return null;`;
    const run = (script: string) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          files: { "out/a.md": "notes" },
          summary: (spawned) => (spawned === 1 ? `A-SUMMARY-${"s".repeat(10_000)}` : "ok"),
        });
        yield* launch(harness.runner, script, threeNodePlan);
        yield* Deferred.await(harness.completed);
        const tasks = [...harness.keys.entries()];
        const find = (prompt: string) => tasks.find(([task]) => task.startsWith(prompt));
        return {
          tasks,
          task: (prompt: string) => find(prompt)?.[0] ?? "",
          key: (prompt: string) => find(prompt)?.[1],
        };
      });

    it.effect(
      "gives an agent its declared input as one block with the producer's capped summary",
      () =>
        Effect.gen(function* () {
          const { task } = yield* run(source(', from: "a"'));
          const text = task("read notes");
          expect(text.match(/<t3-handoff v="1">/g)).toHaveLength(1);
          expect(text.match(/<\/t3-handoff>/g)).toHaveLength(1);
          const opening = '<input id="notes" from="a" path="out/a.md" maxBytes="262144">\n';
          const body = text.slice(
            text.indexOf(opening) + opening.length,
            text.indexOf("\n</input>"),
          );
          expect(text).toContain(opening);
          expect(body.startsWith("A-SUMMARY-ssss")).toBe(true);
          expect(byteLength(body)).toBeLessThanOrEqual(2_048);
          expect(body).toMatch(
            /\.\.\.truncated \(\d+ of \d+ bytes\), full output at task_status taskId=node:agent-1$/,
          );
        }),
    );
    it.effect("gives an agent nothing from a predecessor it did not declare", () =>
      Effect.gen(function* () {
        const { task } = yield* run(source(', from: "a"'));
        expect(task("unrelated")).not.toContain("<t3-handoff");
        expect(task("unrelated")).not.toContain("A-SUMMARY");
      }),
    );
    it.effect("names the file without a summary when the input has no producing node", () =>
      Effect.gen(function* () {
        const { task } = yield* run(source(""));
        const text = task("read notes");
        expect(text).toContain('<input id="notes" path="out/a.md" maxBytes="262144" />');
        expect(text).not.toContain("A-SUMMARY");
      }),
    );
    it.effect("keeps an agent's retry key the same with or without its producing node", () =>
      Effect.gen(function* () {
        const withProducer = yield* run(source(', from: "a"'));
        const without = yield* run(source(""));
        expect(withProducer.key("read notes")).toBeDefined();
        expect(withProducer.key("read notes")).toBe(without.key("read notes"));
      }),
    );
    it.effect("asks graph nodes for a short summary and leaves plain script agents alone", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ files: { "out/a.md": "notes" } });
        yield* launch(
          harness.runner,
          `await agent("write notes", { node: "a", outputs: [{ id: "notes", path: "out/a.md" }] });
           await agent("read notes", { node: "b" });
           await agent("count", { node: "c", schema: { type: "object" } });
           await agent("plain");
           return null;`,
          threeNodePlan,
        );
        yield* Deferred.await(harness.completed);
        const tasks = [...harness.keys.keys()];
        const task = (prompt: string) => tasks.find((text) => text.startsWith(prompt)) ?? "";
        expect(task("write notes")).toContain("at most about 1,500 characters");
        expect(task("write notes")).toContain("Put longer material in your output files.");
        expect(task("read notes")).toContain("at most about 1,500 characters");
        expect(task("read notes")).not.toContain("output files");
        expect(task("count")).toContain("Keep the text before the JSON block short.");
        expect(task("plain")).toBe("plain");
      }),
    );
  });
});

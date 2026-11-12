import { describe, expect, it } from "@effect/vitest";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- optional external payload evidence from the test harness, never application IO.
import * as NodeFS from "node:fs";
import { mergeWorkflowPatch } from "@t3tools/shared/workflowUpdate";
import {
  projectedSubagentsToRuntime,
  deriveWorkflowGroups,
  deriveWorkflowProgress,
} from "../../../../packages/client-runtime/src/state/subagentRuntime.ts";
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
  type WorkflowAgentStart,
} from "./workflowRunner.ts";
import { NO_DEFAULT_JUDGE_NOTE } from "./workflowDefaults.ts";
import { aggregateWorkflowUsage } from "./workflowUsage.ts";
import { agentRequestKey } from "./workflowAgentAttempts.ts";

const threadId = ThreadId.make("thread:workflow-runner");
const workflowId = NodeId.make("workflow:runner-test");
/** Where the fake host keeps a checker's file: an absolute path, as the real one is. */
const CHECKER_FOLDER = "/server-state/workflow-results";

function clientCounts(workflow: OrchestrationV2SubagentWorkflow) {
  const instant = DateTime.makeUnsafe(0);
  const runtime = projectedSubagentsToRuntime([
    {
      id: workflowId,
      title: "Identity replay",
      prompt: "Identity replay",
      model: null,
      status: "running",
      result: null,
      startedAt: instant,
      completedAt: null,
      updatedAt: instant,
      workflow,
    },
  ]);
  return deriveWorkflowProgress(deriveWorkflowGroups(runtime)[0]!).phases[0]!.counts;
}

/** The model a target that names none inherits from the caller. */
const CALLER_MODEL = "gpt-5.4";

interface HarnessOptions {
  readonly beforeSpawn?: Effect.Effect<void>;
  readonly previousWorkflow?: OrchestrationV2SubagentWorkflow;
  readonly beforeAwait?: (taskId: NodeId) => Effect.Effect<void>;
  readonly onAwaitRelease?: () => Effect.Effect<unknown>;
  readonly finalization?: Effect.Effect<void>;
  readonly taskId?: (spawned: number, prompt: string) => string;
  readonly taskIds?: Map<string, NodeId>;
  readonly agentTaskId?: WorkflowRunnerDeps["agentTaskId"];
  readonly failSpawn?: boolean;
  readonly fileHash?: string;
  readonly onWorkflowUpdate?: (workflow: OrchestrationV2SubagentWorkflow) => Effect.Effect<unknown>;
  readonly usage?: (spawned: number) => ReturnType<typeof aggregateWorkflowUsage>;
  readonly timing?: (spawned: number) => WorkflowAgentOutcome["timing"];
  readonly judgment?: (spawned: number) => boolean;
  readonly model?: (spawned: number) => string | null;
  readonly startOptions?: (spawned: number) => WorkflowAgentStart["options"];
  /** Whether the nth agent (1-based) finishes on its own, and how; otherwise it hangs. */
  readonly finish?: (spawned: number) => "completed" | "failed" | "cancelled" | "hang";
  /** Whether a retry key was started already, by this run or an earlier one. */
  readonly agentStarted?: (requestKey: string) => boolean;
  /** How a target resolves; by default its own model, else the caller's, CALLER_MODEL. */
  readonly resolveTarget?: WorkflowRunnerDeps["resolveTarget"];
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
  /** Until when (test clock ms) every agent's thread has a pending request that waits for a person. */
  readonly pendingRequestUntil?: number;
  /** Whether the nth stop request (1-based, counting every request) is refused. */
  readonly failStop?: (attempt: number) => boolean;
  /** Whether an accepted stop leaves the agent running, as a provider that finalizes later does. */
  readonly stopLeavesRunning?: boolean;
  /** Whether the attempt's thread still runs work after its task reads as settled. */
  readonly workLive?: boolean;
  /** Whether ending an attempt's work before a retry succeeds; true unless it says otherwise. */
  readonly endAttemptWork?: (taskId: string) => boolean;
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
    const taskIds = options.taskIds ?? new Map<string, NodeId>();
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
    const spawns: Array<{
      readonly task: string;
      readonly requestKey: string;
      readonly target: unknown;
    }> = [];
    const rowsAtStop: Array<OrchestrationV2SubagentWorkflow | undefined> = [];
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
    const endedAttempts: Array<string> = [];
    const rowsAtEnd: Array<OrchestrationV2SubagentWorkflow | undefined> = [];
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
                  workflowUpdates.at(-1) ?? options.previousWorkflow ?? { phases: [], agents: [] },
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
          : Effect.map(Clock.currentTimeMillis, (now) => ({
              updatedAt: DateTime.makeUnsafe(0),
              latestRunStartedAt: options.started === false ? null : DateTime.makeUnsafe(0),
              ...(options.started === false ? { activityRunStatus: "preparing" } : {}),
              ...(options.pendingRequestUntil !== undefined && now < options.pendingRequestUntil
                ? { pendingRuntimeRequest: { requestId: "request:1", kind: "command" } }
                : {}),
            })),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const deps: WorkflowRunnerDeps = {
      threads,
      spawnAgent: (_workflow, item, requestKey) =>
        Effect.gen(function* () {
          if (options.beforeSpawn !== undefined) yield* options.beforeSpawn;
          spawned += 1;
          keys.set(item.task, requestKey);
          spawns.push({ task: item.task, requestKey, target: item.target });
          if (options.failSpawn)
            return yield* Effect.fail({
              code: "orchestration_error",
              message: "Synthetic reattach failure",
            } as never);
          if (item.task.includes("independent checker"))
            readableByChecker.push(new Map(checkerFiles));
          yield* Deferred.succeed(firstSpawn, undefined);
          const taskId = NodeId.make(
            taskIds.get(requestKey) ??
              options.taskId?.(spawned, item.task) ??
              `node:agent-${spawned}`,
          );
          taskIds.set(requestKey, taskId);
          const finish = options.finish?.(spawned) ?? "completed";
          if (finish !== "hang") yield* update(taskId, finish);
          return {
            taskId,
            childThreadId: ThreadId.make(`thread:agent-${spawned}`),
            model: options.model?.(spawned) ?? null,
            ...(options.startOptions === undefined
              ? {}
              : { options: options.startOptions(spawned) }),
            providerInstanceId: ProviderInstanceId.make("codex"),
            driver: ProviderDriverKind.make("codex"),
          };
        }),
      awaitAgent: (_workflow, taskId, onUpdate) =>
        Effect.gen(function* () {
          if (options.beforeAwait !== undefined) yield* options.beforeAwait(taskId);
          const queue = yield* Queue.unbounded<void>();
          taskUpdates.set(taskId, queue);
          const read = (): WorkflowAgentOutcome => ({
            status: statuses.get(taskId) ?? "running",
            summary: options.summary?.(Number(taskId.split("-").at(-1))) ?? "ok",
            ...(options.workLive === undefined ? {} : { workLive: options.workLive }),
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
      resolveTarget:
        options.resolveTarget ??
        ((_workflow, target) => {
          const model = (target as { readonly model?: unknown } | undefined)?.model;
          return Effect.succeed({ model: typeof model === "string" ? model : CALLER_MODEL });
        }),
      agentStarted: (_workflow, requestKey) =>
        Effect.succeed(options.agentStarted?.(requestKey) ?? false),
      agentTaskId:
        options.agentTaskId ?? ((_workflow, key) => taskIds.get(key) ?? NodeId.make(`task:${key}`)),
      agentRequestKey: (_workflow, id) => {
        const key = [...taskIds].find(([, taskId]) => taskId === id)?.[0];
        return key === undefined ? undefined : agentRequestKey(key);
      },
      canRunCommands: () => Effect.succeed(options.runCommandCheck !== undefined),
      runCommandCheck: options.runCommandCheck ?? (() => Effect.die("unused")),
      readWorkspaceFile: (_workflow, path) => {
        const text = options.files?.[path];
        return Effect.succeed(
          text === undefined
            ? ({ status: "missing" } as const)
            : ({
                status: "found",
                sha256: options.fileHash ?? "0".repeat(64),
                sizeBytes: text.length,
                text,
              } as const),
        );
      },
      writeCheckerResult: (_workflow, taskId, text) =>
        options.failCheckerWrite === true
          ? Effect.fail({ code: "orchestration_error", message: "The disk is full." } as never)
          : Effect.sync(() => {
              const path = `${CHECKER_FOLDER}/checker-${taskId}.txt`;
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
          rowsAtStop.push(workflowUpdates.at(-1));
          if (options.failStop?.(stopRequests.length) === true) {
            return yield* Effect.fail({
              code: "orchestration_error",
              message: "The stop could not be dispatched.",
            } as never);
          }
          stops.push(`${taskId}:${why}`);
          if (options.stopLeavesRunning !== true) yield* update(taskId, "cancelled");
        }),
      endAttemptWork: (_workflow, taskId) =>
        Effect.sync(() => {
          endedAttempts.push(taskId);
          rowsAtEnd.push(workflowUpdates.at(-1));
          return options.endAttemptWork?.(taskId) ?? true;
        }),
    };
    return {
      runner: makeWorkflowRunner(deps),
      taskIds,
      completed,
      spawned: () => spawned,
      stops,
      /** Every stop the runner asked for, accepted or not. */
      stopRequests,
      /** Attempts whose work the runner ended before starting another, in order. */
      endedAttempts,
      /** The last row update the runner sent before each of those ends. */
      rowsAtEnd,
      /** Every workflow.complete the runner dispatched, accepted or not. */
      completions,
      /** The command ids of the completions the dispatcher committed. */
      acceptedCompletions,
      /** Done once the runner has dispatched its first workflow.complete. */
      firstCompletion,
      keys,
      /** Every spawn in order, so attempts with the same prompt stay apart. */
      spawns,
      /** The last row update the runner sent before each stop request. */
      rowsAtStop,
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
  it.effect.each(["target", "model", "preset", "none"] as const)(
    "projects the requested %s identity while queued and preserves it after spawn",
    (choice) =>
      Effect.gen(function* () {
        const primary = {
          providerInstanceId: ProviderInstanceId.make("primary"),
          model: "gpt-6.1-sol",
        };
        const fallback = {
          providerInstanceId: ProviderInstanceId.make("fallback"),
          model: "gpt-6-luna",
        };
        const queued = yield* Deferred.make<OrchestrationV2SubagentWorkflow>();
        const release = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          beforeSpawn: Deferred.await(release),
          model: () => "actual-model",
          onWorkflowUpdate: (workflow) =>
            workflow.agents[0]?.state === "queued"
              ? Deferred.succeed(queued, workflow)
              : Effect.void,
        });
        const request =
          choice === "target"
            ? { target: primary }
            : choice === "preset"
              ? { preset: "review" }
              : choice === "model"
                ? { model: primary.model }
                : {};
        yield* h.runner.launch({
          workflowId,
          threadId,
          afterSequence: 0,
          args: null,
          source: `return agent("work", ${JSON.stringify(request)})`,
          // A workflow started before presets were removed resolves its frozen choice.
          legacyPresets: { defaultPresetId: null, targets: { review: { target: fallback } } },
        });
        const projection = (yield* Deferred.await(queued)).agents[0]!;
        expect(projection.plannedIdentity).toEqual(
          choice === "none"
            ? undefined
            : choice === "model"
              ? { model: primary.model }
              : choice === "preset"
                ? fallback
                : primary,
        );
        expect(projection.providerInstanceId).toBeUndefined();
        expect(projection.model).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(h.completed);
        expect(h.workflowUpdates.at(-1)?.agents[0]).toMatchObject({
          model: "actual-model",
          providerInstanceId: "codex",
        });
        expect(h.workflowUpdates.at(-1)?.agents[0]?.plannedIdentity).toEqual(
          projection.plannedIdentity,
        );
      }),
  );
  it.effect.each([
    [
      'phase("Audit"); await agent("old"); return progress.phase("Audit", { total: 0 }, () => {});',
      "must start before its agents",
    ],
    [
      'return progress.phase("Audit", { total: 1 }, () => agent("unbound", { phase: "Audit" }));',
      "Use bar.agent()",
    ],
    [
      'progress.phase("Audit", { total: 1 }, (bar) => bar.agent("forgotten")); return 42;',
      "Await every progress.phase()",
    ],
  ] as const)("refuses ambiguous or unawaited phase work: %s", ([source, message]) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* launch(h.runner, source);
      expect(yield* Deferred.await(h.completed)).toContain(message);
      expect(h.workflowUpdates.at(-1)?.phases[0]?.progress?.state).toBe(
        message === "must start before its agents" ? undefined : "failed",
      );
    }),
  );
  it.effect.each([1, 12])(
    "keeps planned totals through retries and sizes only the next phase to %i",
    (nextTotal) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ finish: (n) => (n === 1 ? "failed" : "completed") });
        yield* launch(
          h.runner,
          `
        export const meta = { phases: [{ title: "Audit", total: 10 }, { title: "Follow up", total: 8 }, { title: "Later", total: 7 }] };
        const answers = await progress.phase("Audit", { total: 10 }, async (bar) => [await bar.agent("audit")]);
        return progress.phase("Follow up", { total: answers.length * ${nextTotal} }, async (bar) => bar.agent("follow up"));
      `,
        );
        expect(yield* Deferred.await(h.completed)).toContain("ok");
        expect(h.spawned()).toBe(3);
        const workflow = h.workflowUpdates.at(-1)!;
        expect(workflow.phases.map((phase) => phase.progress)).toEqual([
          { total: 10, state: "completed" },
          { total: nextTotal, state: "completed" },
          { total: 7, state: "planned" },
        ]);
        expect(workflow.agents).toHaveLength(2);
        expect(workflow.agents[0]).toMatchObject({ phaseIndex: 0, attempt: 1, state: "completed" });
        expect(
          h.workflowUpdates.every(
            (update) =>
              update.phases.find((phase) => phase.title === "Audit")?.progress?.total === 10,
          ),
        ).toBe(true);
      }),
  );

  it.effect("records failed members even when a phase callback resolves", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ finish: () => "failed" });
      yield* launch(
        h.runner,
        'return progress.phase("Audit", { total: 1 }, (bar) => bar.agent("audit"))',
      );
      yield* Deferred.await(h.completed);
      expect(h.workflowUpdates.at(-1)).toMatchObject({
        phases: [{ progress: { total: 1, state: "completed" } }],
        agents: [{ state: "failed", phaseIndex: 0 }],
      });
      expect(h.spawned()).toBe(3);
    }),
  );

  it.effect.each([0, 1])("rejects work beyond a fixed total of %i", (total) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* launch(
        h.runner,
        `return progress.phase("Audit", { total: ${total} }, async (bar) => {
        for (let i = 0; i <= ${total}; i++) await bar.agent("audit " + i);
      })`,
      );
      expect(yield* Deferred.await(h.completed)).toContain("capacity exceeded");
      expect(h.spawned()).toBe(total);
      expect(h.workflowUpdates.at(-1)?.phases[0]?.progress).toEqual({ total, state: "failed" });
    }),
  );

  it.effect("keeps judgment agents outside their worker's progress capacity", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ judgment: () => true });
      yield* launch(
        h.runner,
        'return progress.phase("Audit", { total: 1 }, (bar) => bar.agent("audit", { verify: { type: "judgment", rubric: ["Correct"] } }))',
      );
      yield* Deferred.await(h.completed);
      expect(h.spawned()).toBe(2);
      expect(
        h.workflowUpdates.at(-1)?.agents.filter((agent) => agent.judgmentFor === undefined),
      ).toHaveLength(1);
      expect(h.workflowUpdates.at(-1)?.phases[0]?.progress).toEqual({
        total: 1,
        state: "completed",
      });
    }),
  );

  it.effect("preserves entered phase totals while metadata and earlier work replay", () =>
    Effect.gen(function* () {
      const previousWorkflow: OrchestrationV2SubagentWorkflow = {
        phases: [
          { index: 0, title: "Audit", progress: { total: 10, state: "completed" } },
          { index: 1, title: "Follow up", progress: { total: 2, state: "running" } },
        ],
        agents: [],
      };
      const blocked = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        previousWorkflow,
        finish: () => "hang",
        onWorkflowUpdate: (workflow) =>
          workflow.agents.some((agent) => agent.state === "running")
            ? Deferred.succeed(blocked, undefined)
            : Effect.void,
      });
      yield* h.runner.launch({
        workflowId,
        threadId,
        args: null,
        afterSequence: 0,
        previousWorkflow,
        source: `export const meta = { phases: [{ title: "Audit", total: 10 }, { title: "Follow up", total: 10 }] };
          await progress.phase("Audit", { total: 10 }, bar => bar.agent("audit"));
          return progress.phase("Follow up", { total: 2 }, bar => bar.agent("follow up"));`,
      });
      yield* Deferred.await(blocked);
      yield* h.runner.detachAll;
      expect(h.workflowUpdates.length).toBeGreaterThan(0);
      for (const update of h.workflowUpdates) {
        expect(update.phases[0]?.progress?.state).not.toBe("planned");
        expect(update.phases[1]?.progress).toEqual({ total: 2, state: "running" });
      }
    }),
  );

  it.effect.each([false, true])(
    "preserves logical membership in every crossed replay update (legacy rows: %s)",
    (legacy) =>
      Effect.gen(function* () {
        const source = `return Promise.all([
        progress.phase("First", { total: 2 }, async bar => { await bar.agent("first gate"); return bar.agent("first work"); }),
        progress.phase("Second", { total: 2 }, async bar => { await bar.agent("second gate"); return bar.agent("second work"); })
      ]);`;
        const taskId = (_spawned: number, prompt: string) => `task:${prompt}`;
        const first = yield* makeHarness({ taskId });
        yield* launch(first.runner, source);
        yield* Deferred.await(first.completed);
        const previous = first.workflowUpdates.at(-1)!;
        const previousWorkflow: OrchestrationV2SubagentWorkflow = {
          ...previous,
          phases: previous.phases.map((phase) => ({
            ...phase,
            progress: { total: 2, state: "running" },
          })),
          agents: previous.agents.map((agent) => {
            const row = { ...agent, state: "running" as const };
            if (legacy) Reflect.deleteProperty(row, "requestKey");
            return row;
          }),
        };
        const crossed = yield* Deferred.make<void>();
        const h = yield* makeHarness({
          taskId,
          taskIds: first.taskIds,
          previousWorkflow,
          beforeAwait: (id) => (id === "task:first gate" ? Deferred.await(crossed) : Effect.void),
          onWorkflowUpdate: (workflow) =>
            workflow.agents.some(
              (agent) => agent.agentId === "task:second work" && agent.state === "completed",
            )
              ? Deferred.succeed(crossed, undefined)
              : Effect.void,
        });
        yield* h.runner.launch({
          workflowId,
          threadId,
          args: null,
          afterSequence: 0,
          source,
          previousWorkflow,
        });
        yield* Deferred.await(h.completed);
        for (const update of h.workflowUpdates) {
          const ids = update.agents.flatMap((agent) =>
            agent.agentId === undefined ? [] : [agent.agentId],
          );
          expect(new Set(ids).size).toBe(ids.length);
          for (const phase of update.phases) {
            expect(update.agents.filter((agent) => agent.phaseIndex === phase.index)).toHaveLength(
              2,
            );
          }
        }
        expect(
          h.workflowUpdates.at(-1)?.agents.map((agent) => [agent.index, agent.agentId]),
        ).toEqual(previous.agents.map((agent) => [agent.index, agent.agentId]));
      }),
  );

  it.effect.each(
    (["keyed", "latest", "ids", "history"] as const).flatMap((identity) =>
      [false, true].map((callback) => ({ identity, callback })),
    ),
  )(
    "resumes partial concurrent work with new calls before old calls: %j",
    ({ identity, callback }) =>
      Effect.gen(function* () {
        const calls = `Promise.all([
        (async () => { await call("A gate"); return call("A followup"); })(),
        (async () => { await call("B gate"); return call("B followup"); })()
      ])`;
        const source = callback
          ? `return progress.phase("Work", { total: 4 }, async bar => { const call = bar.agent; return ${calls}; });`
          : `phase("Work"); const call = agent; return ${calls};`;
        const interrupted = yield* Deferred.make<OrchestrationV2SubagentWorkflow>();
        const taskId = (_spawned: number, prompt: string) => `task:${prompt}`;
        const first = yield* makeHarness({
          taskId,
          beforeAwait: (id) =>
            id === "task:B gate" || id === "task:A followup" ? Effect.never : Effect.void,
          onWorkflowUpdate: (workflow) =>
            workflow.agents.some(
              (agent) => agent.agentId === "task:A followup" && agent.state === "running",
            )
              ? Deferred.succeed(interrupted, workflow)
              : Effect.void,
        });
        yield* launch(first.runner, source);
        const previous = yield* Deferred.await(interrupted);
        yield* first.runner.detachAll;
        expect(previous.agents.map((agent) => agent.agentId)).toEqual([
          "task:A gate",
          "task:B gate",
          "task:A followup",
        ]);
        const previousWorkflow = {
          ...previous,
          agents: previous.agents.map((agent) => {
            const row = { ...agent };
            if (identity !== "keyed") delete row.requestKey;
            if (identity === "latest" || identity === "history") delete row.attemptTaskIds;
            if (identity === "latest" || identity === "ids") delete row.attemptHistory;
            if (identity === "ids" || identity === "history") delete row.agentId;
            return row;
          }),
        };
        const crossed = yield* Deferred.make<void>();
        const second = yield* makeHarness({
          taskId,
          taskIds: first.taskIds,
          previousWorkflow,
          beforeAwait: (id) =>
            id === "task:A gate"
              ? Deferred.await(crossed)
              : id === "task:B followup"
                ? Deferred.succeed(crossed, undefined).pipe(Effect.asVoid)
                : Effect.void,
        });
        yield* second.runner.launch({
          workflowId,
          threadId,
          args: null,
          afterSequence: 0,
          source,
          previousWorkflow,
        });
        const result = yield* Deferred.await(second.completed);
        yield* second.runner.detachAll;
        expect(result).not.toContain("workflow failed");
        expect(JSON.parse(result)).toEqual(["ok", "ok"]);
        for (const update of second.workflowUpdates) {
          const ids = update.agents.flatMap((agent) =>
            agent.agentId === undefined ? [] : [agent.agentId],
          );
          expect(new Set(ids).size).toBe(ids.length);
          expect(update.agents.map((agent) => agent.index)).toEqual(
            update.agents.length === 3 ? [0, 1, 2] : [0, 1, 2, 3],
          );
          expect(clientCounts(update).observed).toBe(update.agents.length);
          expect(clientCounts(update).total).toBe(callback ? 4 : null);
        }
        expect(
          second.workflowUpdates.at(-1)?.agents.map((agent) => [agent.index, agent.agentId]),
        ).toEqual([
          [0, "task:A gate"],
          [1, "task:B gate"],
          [2, "task:A followup"],
          [3, "task:B followup"],
        ]);
      }),
  );

  it.effect.each(["input", "permission", "attachment"] as const)(
    "keeps legacy member identity before a replay %s failure",
    (failure) =>
      Effect.gen(function* () {
        const source = `return progress.phase("Pinned", { total: 1 }, bar => bar.agent("audit", {
          inputs: [{ id: "input", path: "input.txt", sha256: "0".repeat(64) }],
          verify: { type: "process", argv: ["check"] }
        }));`;
        const allowed = () => Effect.succeed({ outcome: "passed" as const, detail: "ok" });
        const first = yield* makeHarness({ files: { "input.txt": "x" }, runCommandCheck: allowed });
        yield* launch(first.runner, source);
        yield* Deferred.await(first.completed);
        const previous = first.workflowUpdates.at(-1)!;
        const previousWorkflow = {
          ...previous,
          agents: previous.agents.map(({ requestKey: _key, ...agent }) => ({
            ...agent,
            label: "Legacy display label",
            prompt: "Legacy display preview",
          })),
        };
        const second = yield* makeHarness({
          previousWorkflow,
          taskIds: first.taskIds,
          files: { "input.txt": "x" },
          fileHash: (failure === "input" ? "1" : "0").repeat(64),
          ...(failure === "permission" ? {} : { runCommandCheck: allowed }),
          failSpawn: failure === "attachment",
        });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        yield* Deferred.await(second.completed);
        expect(second.spawned()).toBe(failure === "attachment" ? 1 : 0);
        expect(second.workflowUpdates.length).toBeGreaterThan(0);
        for (const update of second.workflowUpdates) {
          expect(update.agents.map((agent) => agent.index)).toEqual([previous.agents[0]!.index]);
          expect(clientCounts(update)).toMatchObject({ observed: 1, total: 1 });
          expect(clientCounts(update).settled).toBeLessThanOrEqual(1);
        }
        expect(clientCounts(second.workflowUpdates.at(-1)!)).toMatchObject({
          done: 0,
          failed: 1,
          settled: 1,
          observed: 1,
          total: 1,
        });
        expect(second.workflowUpdates.at(-1)!.agents[0]!.result).toContain(
          failure === "input"
            ? "changed"
            : failure === "permission"
              ? "full-access"
              : "reattach failure",
        );
      }),
  );

  it.effect.each([1, 2])(
    "resolves a legacy latest-task-only retry %s before publishing workers or judges",
    (retry) =>
      Effect.gen(function* () {
        const source =
          'return progress.phase("Judged", { total: 1 }, bar => bar.agent("worker", { verify: { type: "judgment", rubric: ["Correct"] } }));';
        const finish = (spawned: number) =>
          spawned <= retry ? ("failed" as const) : ("completed" as const);
        const first = yield* makeHarness({ finish, judgment: () => true });
        yield* launch(first.runner, source);
        yield* Deferred.await(first.completed);
        const previous = first.workflowUpdates.at(-1)!;
        const previousWorkflow = {
          ...previous,
          agents: previous.agents.map(
            ({ requestKey: _key, attemptTaskIds: _ids, attemptHistory: _history, ...agent }) =>
              agent,
          ),
        };
        const second = yield* makeHarness({
          previousWorkflow,
          taskIds: first.taskIds,
          finish,
          judgment: () => true,
        });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        yield* Deferred.await(second.completed);
        expect(second.workflowUpdates.length).toBeGreaterThan(0);
        for (const update of second.workflowUpdates) {
          expect(update.agents.map((agent) => agent.index)).toEqual(
            previous.agents.map((agent) => agent.index),
          );
          expect(clientCounts(update)).toMatchObject({ observed: 1, total: 1 });
          expect(clientCounts(update).settled).toBeLessThanOrEqual(1);
          expect(update.agents.find((agent) => agent.judgmentFor)?.judgmentFor).toEqual({
            agentIndex: 0,
            attempt: retry,
          });
        }
        expect(
          second.workflowUpdates.at(-1)!.agents.map((agent) => [agent.index, agent.agentId]),
        ).toEqual(previous.agents.map((agent) => [agent.index, agent.agentId]));
        expect(clientCounts(second.workflowUpdates.at(-1)!)).toMatchObject({
          done: 1,
          failed: 0,
          settled: 1,
          observed: 1,
          total: 1,
        });
      }),
  );

  it.effect.each(["unavailable", "ambiguous", "unmatched"] as const)(
    "refuses %s legacy identity before side effects or member publication",
    (identity) =>
      Effect.gen(function* () {
        const source =
          'return progress.phase("Identity", { total: 1 }, bar => bar.agent("worker"));';
        const first = yield* makeHarness();
        yield* launch(first.runner, source);
        yield* Deferred.await(first.completed);
        const previous = first.workflowUpdates.at(-1)!;
        const { requestKey: _key, ...legacy } = previous.agents[0]!;
        const previousWorkflow = {
          ...previous,
          agents: identity === "ambiguous" ? [legacy, { ...legacy, index: 1 }] : [legacy],
        };
        const second = yield* makeHarness({
          previousWorkflow,
          taskIds: identity === "unmatched" ? new Map() : first.taskIds,
          ...(identity === "unavailable" ? { agentTaskId: () => undefined } : {}),
        });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        expect(yield* Deferred.await(second.completed)).toContain("workflow agent identity");
        expect(second.spawned()).toBe(0);
        expect(second.workflowUpdates.length).toBeGreaterThan(0);
        for (const update of second.workflowUpdates)
          expect(update.agents).toEqual(previousWorkflow.agents);
      }),
  );

  it.effect.each([false, true])(
    "releases legacy write reservations with fixed member indices (attachment fails: %s)",
    (failSpawn) =>
      Effect.gen(function* () {
        const source = `return progress.phase("Writes", { total: 2 }, bar => Promise.all([
          bar.agent("one", { scopes: { write: ["shared.txt"] } }),
          bar.agent("two", { scopes: { write: ["shared.txt"] } })
        ]));`;
        const first = yield* makeHarness();
        yield* launch(first.runner, source);
        yield* Deferred.await(first.completed);
        const previous = first.workflowUpdates.at(-1)!;
        const previousWorkflow = {
          ...previous,
          agents: previous.agents.map(({ requestKey: _key, ...agent }) => agent),
        };
        const second = yield* makeHarness({ previousWorkflow, taskIds: first.taskIds, failSpawn });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        yield* Deferred.await(second.completed);
        expect(second.spawned()).toBe(2);
        for (const update of second.workflowUpdates) {
          expect(update.agents.map((agent) => agent.index)).toEqual([0, 1]);
          expect(clientCounts(update)).toMatchObject({ observed: 2, total: 2 });
        }
        expect(clientCounts(second.workflowUpdates.at(-1)!)).toMatchObject({
          settled: 2,
          done: failSpawn ? 0 : 2,
          failed: failSpawn ? 2 : 0,
        });
      }),
  );

  it.effect("reuses a legacy placeholder whose invalid agent never started", () =>
    Effect.gen(function* () {
      const source = 'phase("Audit"); return agent("audit", { attemptTimeoutMs: 1 });';
      const first = yield* makeHarness();
      yield* launch(first.runner, source);
      yield* Deferred.await(first.completed);
      const previous = first.workflowUpdates.at(-1)!;
      const previousWorkflow = {
        ...previous,
        agents: previous.agents.map((agent) => {
          const row = { ...agent };
          Reflect.deleteProperty(row, "requestKey");
          return row;
        }),
      };
      const second = yield* makeHarness({ previousWorkflow, agentTaskId: () => undefined });
      yield* second.runner.launch({
        workflowId,
        threadId,
        args: null,
        afterSequence: 0,
        source,
        previousWorkflow,
      });
      yield* Deferred.await(second.completed);
      expect(second.spawned()).toBe(0);
      expect(second.workflowUpdates.at(-1)?.agents).toHaveLength(1);
    }),
  );

  it.effect("replays absolute phase state with stable indices and agent request keys", () =>
    Effect.gen(function* () {
      const source =
        'await progress.phase("First", { total: 1 }, (bar) => bar.agent("first")); return progress.phase("Second", { total: 1 }, (bar) => bar.agent("second"));';
      const first = yield* makeHarness();
      yield* launch(first.runner, source);
      yield* Deferred.await(first.completed);
      const previousWorkflow = first.workflowUpdates.at(-1)!;
      const second = yield* makeHarness();
      yield* second.runner.launch({
        workflowId,
        threadId,
        source,
        args: null,
        afterSequence: 0,
        previousWorkflow,
      });
      yield* Deferred.await(second.completed);
      expect(second.workflowUpdates.at(-1)?.phases).toEqual(previousWorkflow.phases);
      expect(second.workflowUpdates.at(-1)?.agents.map((agent) => agent.phaseIndex)).toEqual([
        0, 1,
      ]);
      expect(second.keys).toEqual(first.keys);
    }),
  );

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
            {
              index: 0,
              requestKey: "prior-budget-member",
              label: "Old",
              state: "completed",
              agentId: "old-task",
              totalTokens: 60,
            },
          ],
        },
      });
      expect(yield* Deferred.await(harness.completed)).toContain("60 recorded");
      expect(harness.spawned()).toBe(0);
    }),
  );
  it.effect("settles a worker when its judge exceeds the agent limit", () =>
    Effect.gen(function* () {
      const { runner, completed, workflowUpdates } = yield* makeHarness();
      yield* launch(
        runner,
        'for (let i = 0; i < 999; i++) await agent("a" + i); return await agent("judged", { verify: { type: "judgment", rubric: ["Correct"] } })',
      );
      yield* Deferred.await(completed);
      const worker = workflowUpdates.at(-1)?.agents.at(-1);
      expect(worker).toMatchObject({
        state: "failed",
        outcomeCategory: "check_failed",
        verification: {
          type: "judgment",
          outcome: "error",
          detail: "This workflow reached its limit of 1000 agents.",
        },
      });
      expect(worker?.runnerSettledAt).toBeDefined();
    }),
  );
  it.effect("does not run a provider-faulted judge again at the agent cap", () =>
    Effect.gen(function* () {
      // The worker is the 999th agent and its judge the 1000th; every try of the judge fails.
      const { runner, completed, workflowUpdates } = yield* makeHarness({
        finish: (spawned) => (spawned >= 1000 ? "failed" : "completed"),
      });
      yield* launch(
        runner,
        'for (let i = 0; i < 998; i++) await agent("a" + i); return await agent("judged", { verify: { type: "judgment", rubric: ["Correct"] }, report: true })',
      );
      const report = JSON.parse(yield* Deferred.await(completed));
      const agents = workflowUpdates.at(-1)!.agents;
      // The cap holds, and the check keeps the error its judge ended with, as without re-runs.
      expect(agents).toHaveLength(1000);
      expect(agents.filter((agent) => agent.judgmentFor !== undefined)).toHaveLength(1);
      expect(report).toMatchObject({
        ok: false,
        verification: { type: "judgment", outcome: "error", attempts: 1 },
      });
      expect(report.verification.detail).not.toContain("reached its limit");
      expect(agents.at(-2)).toMatchObject({ state: "failed", outcomeCategory: "check_failed" });
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
          attempts: 2,
          verification: { type: "structured", outcome: "failed", attempts: 2 },
        });
        expect(report.verification.detail).toContain("output out (out.json) is not JSON");
        expect(spawned()).toBe(2);
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
        // The first attempt hangs; the second finishes.
        const { runner, completed, spawned, stops } = yield* makeHarness({
          finish: (n) => (n < 2 ? "hang" : "completed"),
        });
        yield* launch(
          runner,
          'return await agent("x", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        yield* sweepUntilDone(completed);
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({ ok: true, attempts: 2 });
        expect(spawned()).toBe(2);
        expect(stops).toEqual(["node:agent-1:timed_out"]);
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
        const attempts = yield* Queue.unbounded<NodeId>();
        const { runner, completed, spawned } = yield* makeHarness({
          finish: () => "hang",
          beforeAwait: (taskId) => Queue.offer(attempts, taskId).pipe(Effect.asVoid),
        });
        yield* launch(
          runner,
          'return await agent("x", { attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        for (const attempt of [1, 2]) {
          expect(yield* Queue.take(attempts)).toBe(`node:agent-${attempt}`);
          yield* TestClock.adjust("90 seconds");
        }
        const report = JSON.parse(yield* Deferred.await(completed));
        expect(report).toMatchObject({ ok: false, attempts: 2 });
        expect(report.reason).toBe(
          "Its last work attempt passed its time budget of 60000 ms and was stopped.",
        );
        expect(spawned()).toBe(2);
      }),
    );
  });

  describe("after a restart", () => {
    const script = (options: string) => `return await agent("x", { ${options}, report: true })`;
    const resume = (
      previousWorkflow: OrchestrationV2SubagentWorkflow,
      options: HarnessOptions,
      source: string,
    ) =>
      Effect.gen(function* () {
        const second = yield* makeHarness({ ...options, previousWorkflow });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        return { second, report: JSON.parse(yield* Deferred.await(second.completed)) };
      });
    /** The row the first run left as it was stopping its only attempt, and its task ids. */
    const stoppedRow = (source: string) =>
      Effect.gen(function* () {
        const first = yield* makeHarness({ finish: () => "hang", stopLeavesRunning: true });
        yield* launch(first.runner, source);
        yield* sweepUntil(() => first.stopRequests.length > 0);
        yield* first.runner.detachAll;
        return first;
      });

    it.effect("does not stall an attempt while its thread waits for a person's answer", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ finish: () => "hang", pendingRequestUntil: 600_000 });
        yield* launch(harness.runner, script("stallTimeoutMs: 60000"));
        // Far past the stall timeout, the thread has recorded nothing but a person owes an answer.
        for (let step = 0; step < 19; step += 1) yield* TestClock.adjust("30 seconds");
        expect(harness.stopRequests).toEqual([]);
        // Answered at ten minutes: the silence is then measured from there.
        yield* sweepUntil(() => harness.stopRequests.length > 0);
        expect(harness.stopRequests).toHaveLength(1);
        expect(yield* Clock.currentTimeMillis).toBeGreaterThanOrEqual(600_000 + 60_000);
      }),
    );

    it.effect("retries a stalled attempt as a provider fault, without its feedback", () =>
      Effect.gen(function* () {
        const source = script("stallTimeoutMs: 60000");
        const first = yield* stoppedRow(source);
        // The reason reached the row before the stop was asked for.
        expect(first.rowsAtStop[0]?.agents[0]?.attemptHistory?.[0]?.stoppedBy).toBe("stalled");
        const { second, report } = yield* resume(
          first.workflowUpdates.at(-1)!,
          { taskIds: first.taskIds, finish: (n) => (n === 1 ? "cancelled" : "completed") },
          source,
        );
        expect(report).toMatchObject({ ok: true, attempts: 2 });
        expect(second.spawns.map((spawn) => spawn.requestKey.slice(-3))).toEqual([
          second.spawns[0]!.requestKey.slice(-3),
          "-r1",
        ]);
        expect(second.spawns[1]!.task).not.toContain("Your previous attempt");
      }),
    );

    it.effect("retries an attempt past its deadline as work, with what went wrong", () =>
      Effect.gen(function* () {
        const source = script("attemptTimeoutMs: 60000, stallTimeoutMs: 3600000");
        const first = yield* stoppedRow(source);
        expect(first.rowsAtStop[0]?.agents[0]?.attemptHistory?.[0]?.stoppedBy).toBe("timed_out");
        const { second, report } = yield* resume(
          first.workflowUpdates.at(-1)!,
          { taskIds: first.taskIds, finish: (n) => (n === 1 ? "cancelled" : "completed") },
          source,
        );
        expect(report).toMatchObject({ ok: true, attempts: 2 });
        expect(second.spawns[1]!.task).toContain("passed its time budget of 60000 ms");
        // The replayed record keeps the reason for a later restart.
        expect(
          second.workflowUpdates
            .at(-1)
            ?.agents[0]?.attemptHistory?.map((record) => record.stoppedBy),
        ).toEqual(["timed_out", undefined]);
      }),
    );

    it.effect("attaches a third attempt an older run started instead of orphaning it", () =>
      Effect.gen(function* () {
        const source = script('verify: { type: "process", argv: ["check"] }');
        const failed = () => Effect.succeed({ outcome: "failed" as const, detail: "wrong" });
        // Under this limit the first run stops after two failed checks.
        const first = yield* makeHarness({ runCommandCheck: failed });
        yield* launch(first.runner, source);
        yield* Deferred.await(first.completed);
        const agent = first.workflowUpdates.at(-1)!.agents[0]!;
        const requestKey = agent.requestKey!;
        // A run under the old limit of three went on to a third attempt, still running.
        const third = NodeId.make("node:older-third");
        const taskIds = new Map([...first.taskIds, [`${requestKey}-r2`, third]]);
        const {
          result: _result,
          outcomeCategory: _category,
          runnerSettledAt: _settled,
          verification: _verification,
          ...running
        } = agent;
        const previousWorkflow = {
          ...first.workflowUpdates.at(-1)!,
          agents: [
            {
              ...running,
              state: "running" as const,
              agentId: third,
              attempt: 2,
              attemptHistory: [
                ...(agent.attemptHistory ?? []),
                {
                  taskId: third,
                  childThreadId: ThreadId.make("thread:older-third"),
                  attempt: 2,
                  state: "running" as const,
                  providerInstanceId: ProviderInstanceId.make("codex"),
                  usageStatus: "unavailable" as const,
                  timingComplete: false,
                },
              ],
            },
          ],
        };
        const { second, report } = yield* resume(
          previousWorkflow,
          {
            taskIds,
            agentStarted: (key) => taskIds.has(key),
            runCommandCheck: (_workflow, childThreadId) =>
              childThreadId === "thread:agent-3"
                ? Effect.succeed({ outcome: "passed" as const, detail: "right" })
                : failed(),
          },
          source,
        );
        expect(report).toMatchObject({ ok: true, attempts: 3, result: "ok" });
        expect(second.spawns.map((spawn) => spawn.requestKey)).toEqual([
          requestKey,
          `${requestKey}-r1`,
          `${requestKey}-r2`,
        ]);
        const row = second.workflowUpdates.at(-1)!.agents[0]!;
        expect(row).toMatchObject({ state: "completed", agentId: third, result: "ok" });
        expect(row.attemptHistory?.map((record) => record.taskId).at(-1)).toBe(third);
      }),
    );
  });

  it.effect.each([
    [
      "spawn",
      { outcome: "error" as const, detail: "spawn check ENOENT", infrastructure: true as const },
    ],
    ["verdict", { outcome: "failed" as const, detail: "wrong" }],
  ] as const)(
    "runs a check that could not start again without using a work attempt (%s)",
    ([kind, firstRun]) =>
      Effect.gen(function* () {
        let runs = 0;
        const harness = yield* makeHarness({
          runCommandCheck: () => {
            runs += 1;
            return Effect.succeed(
              runs === 1 ? firstRun : { outcome: "passed" as const, detail: "ok" },
            );
          },
        });
        yield* launch(
          harness.runner,
          'return await agent("x", { verify: { type: "process", argv: ["check"] }, report: true })',
        );
        const report = JSON.parse(yield* Deferred.await(harness.completed));
        expect(report).toMatchObject({ ok: true, attempts: kind === "spawn" ? 1 : 2 });
        // Only a failed verdict judged the work; a check that did not start judged nothing.
        expect(harness.spawned()).toBe(kind === "spawn" ? 1 : 2);
        expect(runs).toBe(2);
      }),
  );

  it.effect("retires a replaced attempt on the row before ending its work", () =>
    Effect.gen(function* () {
      let runs = 0;
      const harness = yield* makeHarness({
        runCommandCheck: () => {
          runs += 1;
          return Effect.succeed(
            runs === 1
              ? { outcome: "failed" as const, detail: "wrong" }
              : { outcome: "passed" as const, detail: "ok" },
          );
        },
      });
      yield* launch(
        harness.runner,
        'return await agent("x", { verify: { type: "process", argv: ["check"] }, report: true })',
      );
      expect(JSON.parse(yield* Deferred.await(harness.completed))).toMatchObject({ attempts: 2 });
      expect(harness.endedAttempts).toHaveLength(1);
      // The row already said so when the drain read the thread, so no wake could slip in after it.
      expect(harness.rowsAtEnd[0]?.agents[0]?.attemptHistory?.[0]?.superseded).toBe(true);
    }),
  );

  it.effect("starts no retry when the replaced attempt's retirement does not commit", () =>
    Effect.gen(function* () {
      let runs = 0;
      const harness = yield* makeHarness({
        runCommandCheck: () => {
          runs += 1;
          return Effect.succeed(
            runs === 1
              ? { outcome: "failed" as const, detail: "wrong" }
              : { outcome: "passed" as const, detail: "ok" },
          );
        },
        // The row write that would mark the first attempt replaced fails.
        onWorkflowUpdate: (workflow) =>
          workflow.agents[0]?.attemptHistory?.[0]?.superseded === true
            ? Effect.fail({ code: "orchestration_error", message: "The disk is full." } as never)
            : Effect.void,
      });
      yield* launch(
        harness.runner,
        'return await agent("x", { verify: { type: "process", argv: ["check"] }, report: true })',
      );
      yield* Deferred.await(harness.firstCompletion);
      expect(harness.spawned()).toBe(1);
      expect(harness.endedAttempts).toEqual([]);
    }),
  );

  it("recovers a request key from attempt keys up to the most attempts an agent makes", () => {
    const key = `wf-${"a".repeat(24)}-0`;
    expect([key, `${key}-r1`, `${key}-r4`].map(agentRequestKey)).toEqual([key, key, key]);
    expect(agentRequestKey(`${key}-r5`)).toBeUndefined();
  });

  describe("retries", () => {
    const rung = (effort: string) => ({
      providerInstanceId: "codex",
      model: "m",
      options: { effort },
    });
    // The target as the delegated item carries it, with its options in list form.
    const sent = (effort: string) => ({
      providerInstanceId: "codex",
      model: "m",
      options: [{ id: "effort", value: effort }],
    });
    const failed = () => Effect.succeed({ outcome: "failed" as const, detail: "wrong" });
    const passedOn =
      (childThreadId: string): WorkflowRunnerDeps["runCommandCheck"] =>
      (_workflow, child) =>
        child === childThreadId
          ? Effect.succeed({ outcome: "passed" as const, detail: "right" })
          : failed();
    const checked = `verify: { type: "process", argv: ["check"] }`;
    const ladder = `target: ${JSON.stringify(rung("low"))}, retries: ${JSON.stringify([rung("medium"), rung("high")])}`;
    const run = (source: string, options: HarnessOptions = {}) =>
      Effect.gen(function* () {
        const h = yield* makeHarness(options);
        yield* launch(h.runner, source);
        return { h, report: JSON.parse(yield* Deferred.await(h.completed)) };
      });

    it.effect("keys an agent without retries as before, and one with them apart", () =>
      Effect.gen(function* () {
        // report is not part of the key; the pinned key is the one this call had before retries.
        const plain = yield* run('return await agent("x", { report: true })');
        expect(plain.h.spawns.map((spawn) => spawn.requestKey)).toEqual([
          "wf-c585ef6a4b3b95ec597f40fb-0",
        ]);
        const listed = yield* run('return await agent("x", { retries: [], report: true })');
        expect(listed.h.spawns[0]!.requestKey).not.toBe("wf-c585ef6a4b3b95ec597f40fb-0");
      }),
    );

    describe("T3's cheap-first defaults", () => {
      const at = (providerInstanceId: string, model: string, effort?: string) => ({
        providerInstanceId,
        model,
        options: effort === undefined ? [] : [{ id: "reasoningEffort", value: effort }],
        inheritOptions: false as const,
      });
      const defaultRouting = {
        target: at("codex", "gpt-5.4-mini", "low"),
        retries: [at("codex", "gpt-5.4-mini", "high"), at("codex", "gpt-5.4", "high")],
        judges: [
          { family: "gpt", target: at("codex", "gpt-5.4-mini", "medium") },
          { family: "claude", target: at("claude", "claude-haiku-4-5") },
        ],
      };
      const runWithDefaults = (
        source: string,
        options: HarnessOptions = {},
        workerTarget?: unknown,
      ) =>
        Effect.gen(function* () {
          const h = yield* makeHarness(options);
          yield* h.runner.launch({
            workflowId,
            threadId,
            source,
            args: null,
            afterSequence: 0,
            defaultRouting,
            ...(workerTarget === undefined ? {} : { workerTarget }),
          });
          return { h, report: JSON.parse(yield* Deferred.await(h.completed)) };
        });

      it.effect("climb an agent without a target, keyed by what the script asked", () =>
        Effect.gen(function* () {
          // The key is the one the same call had before defaults, so a resumed run finds its task.
          const plain = yield* runWithDefaults('return await agent("x", { report: true })');
          expect(plain.h.spawns.map((spawn) => [spawn.requestKey, spawn.target])).toEqual([
            ["wf-c585ef6a4b3b95ec597f40fb-0", defaultRouting.target],
          ]);
          expect(plain.h.workflowUpdates.at(-1)?.agents[0]?.targetSource).toBe("default");
          const { h, report } = yield* runWithDefaults(
            `return await agent("x", { ${checked}, report: true })`,
            { runCommandCheck: passedOn("thread:agent-3") },
          );
          expect(report).toMatchObject({ ok: true, attempts: 3 });
          expect(h.spawns.map((spawn) => spawn.target)).toEqual([
            defaultRouting.target,
            ...defaultRouting.retries,
          ]);
        }),
      );

      it.effect("judge with the cheapest model of another family", () =>
        Effect.gen(function* () {
          const { h, report } = yield* runWithDefaults(
            'return await agent("x", { verify: { type: "judgment", rubric: ["ok"] }, report: true })',
            { judgment: () => true },
          );
          expect(report).toMatchObject({ ok: true, attempts: 1 });
          expect(h.spawns.map((spawn) => spawn.target)).toEqual([
            defaultRouting.target,
            at("claude", "claude-haiku-4-5"),
          ]);
          expect(
            h.workflowUpdates.at(-1)?.agents.map((agent) => [agent.label, agent.targetSource]),
          ).toEqual([
            ["agent 1", "default"],
            ["check agent 1", "default"],
          ]);
        }),
      );

      it.effect("say when no other family can judge, keeping the worker's own target", () =>
        Effect.gen(function* () {
          const h = yield* makeHarness({ judgment: () => true });
          yield* h.runner.launch({
            workflowId,
            threadId,
            source:
              'return await agent("x", { verify: { type: "judgment", rubric: ["ok"] }, report: true })',
            args: null,
            afterSequence: 0,
            defaultRouting: { ...defaultRouting, judges: [defaultRouting.judges[0]!] },
          });
          yield* Deferred.await(h.completed);
          expect(h.spawns.map((spawn) => spawn.target)).toEqual([
            defaultRouting.target,
            defaultRouting.target,
          ]);
          expect(
            h.workflowCommands.map(
              (command) => (command as { readonly progress?: string }).progress,
            ),
          ).toContain(`agent 1 judgment: ${NO_DEFAULT_JUDGE_NOTE}`);
        }),
      );

      it.effect("say why there are no defaults when an agent would have taken them", () =>
        Effect.gen(function* () {
          const reasons = (source: string) =>
            Effect.gen(function* () {
              const h = yield* makeHarness();
              yield* h.runner.launch({
                workflowId,
                threadId,
                source,
                args: null,
                afterSequence: 0,
                defaultsUnavailable: "No list prices are at hand, so T3 sets no defaults.",
              });
              yield* Deferred.await(h.completed);
              return h.workflowCommands
                .map((command) => (command as { readonly progress?: string }).progress)
                .filter((progress) => progress?.startsWith("No list prices"));
            });
          expect(
            new Set(yield* reasons('await agent("a"); await agent("b"); return null')),
          ).toEqual(new Set(["No list prices are at hand, so T3 sets no defaults."]));
          const own = { providerInstanceId: "codex", model: "m" };
          expect(
            yield* reasons(`return await agent("x", { target: ${JSON.stringify(own)} })`),
          ).toEqual([]);
        }),
      );

      it.effect("leave every target the script or workerTarget chose", () =>
        Effect.gen(function* () {
          const own = { providerInstanceId: "codex", model: "m" };
          const judged = `verify: { type: "judgment", rubric: ["ok"] }`;
          const targeted = yield* runWithDefaults(
            `return await agent("x", { target: ${JSON.stringify(own)}, ${judged}, report: true })`,
            { judgment: () => true },
          );
          // Its check inherits its target as before: no default judge, no default retries.
          expect(targeted.h.spawns.map((spawn) => spawn.target)).toEqual([own, own]);
          const worker = yield* runWithDefaults(
            `return await agent("x", { ${judged}, report: true })`,
            { judgment: () => true },
            own,
          );
          expect(worker.h.spawns.map((spawn) => spawn.target)).toEqual([own, own]);
          expect(
            worker.h.workflowUpdates.at(-1)?.agents.map((agent) => agent.targetSource),
          ).toEqual(["workerTarget", "workerTarget"]);
        }),
      );
    });

    it.effect.each([
      { name: "after each failed check", finish: undefined },
      {
        name: "past a provider fault, which repeats its target",
        finish: (n: number) => (n === 2 ? ("failed" as const) : ("completed" as const)),
      },
    ])("walks its targets in order $name", ({ finish }) =>
      Effect.gen(function* () {
        const faulted = finish !== undefined;
        const { h, report } = yield* run(
          `return await agent("x", { ${ladder}, ${checked}, report: true })`,
          {
            runCommandCheck: passedOn(faulted ? "thread:agent-4" : "thread:agent-3"),
            ...(finish === undefined ? {} : { finish }),
          },
        );
        expect(report).toMatchObject({ ok: true, attempts: faulted ? 4 : 3 });
        expect(h.spawns.map((spawn) => spawn.target)).toEqual(
          faulted
            ? [sent("low"), sent("medium"), sent("medium"), sent("high")]
            : [sent("low"), sent("medium"), sent("high")],
        );
        // Every attempt after a failed check carries what the check saw.
        expect(h.spawns.slice(1).every((spawn) => spawn.task.includes("wrong"))).toBe(true);
      }),
    );

    it.effect.each([
      { moves: "its effort alone", next: rung("medium"), says: "at medium effort" },
      { moves: "to another model", next: { ...rung("low"), model: "n" }, says: "on n" },
    ])("names a retry that moves $moves by what changes", ({ next, says }) =>
      Effect.gen(function* () {
        const { h } = yield* run(
          `return await agent("x", { target: ${JSON.stringify(rung("low"))}, retries: ${JSON.stringify([next])}, ${checked}, report: true })`,
          { runCommandCheck: passedOn("thread:agent-2") },
        );
        expect(
          h.workflowCommands.map((command) => (command as { readonly progress?: string }).progress),
        ).toContain(`agent "agent 1" failed its process check; starting it again ${says}.`);
      }),
    );

    it.effect("leaves one work attempt for an empty list", () =>
      Effect.gen(function* () {
        const { h, report } = yield* run(
          `return await agent("x", { retries: [], ${checked}, report: true })`,
          { runCommandCheck: failed },
        );
        expect(report).toMatchObject({ ok: false, attempts: 1 });
        expect(h.spawns).toHaveLength(1);
      }),
    );

    it.effect.each([
      { retries: '"high"', reason: "retries must be an array of targets." },
      {
        retries: JSON.stringify([rung("a"), rung("b"), rung("c")]),
        reason: "retries takes at most 2 targets.",
      },
      {
        retries: JSON.stringify([{ model: "m" }]),
        reason: "retries[0] needs a providerInstanceId and a model",
      },
      {
        retries: JSON.stringify([{ ...rung("a"), role: "reviewer" }]),
        reason: "retries[0] takes providerInstanceId, model, options and inheritOptions, not role.",
      },
      {
        retries: JSON.stringify([{ ...rung("a"), environmentId: "elsewhere" }]),
        reason:
          "retries[0] cannot set environmentId: workflow agents run in this thread's environment.",
      },
    ])("refuses retries of $retries before starting anything", ({ retries, reason }) =>
      Effect.gen(function* () {
        const { h, report } = yield* run(
          `return await agent("x", { retries: ${retries}, report: true })`,
        );
        expect(report.ok).toBe(false);
        expect(report.reason).toContain(reason);
        expect(h.spawns).toEqual([]);
      }),
    );

    it.effect("refuses retries that leave the family of a judgment check's worker", () =>
      Effect.gen(function* () {
        const judged = (checkTarget: string) =>
          `return await agent("x", { target: { providerInstanceId: "codex", model: "gpt-5.4" }, retries: [{ providerInstanceId: "claude", model: "claude-sonnet-4-6" }], verify: { type: "judgment", rubric: ["ok"]${checkTarget} }, report: true })`;
        const inherited = yield* run(judged(""));
        expect(inherited.report.reason).toContain("judgment check needs a target of its own");
        expect(inherited.h.spawns).toEqual([]);
        // With its own target the check no longer follows the worker's first one.
        const own = yield* run(
          judged(', target: { providerInstanceId: "claude", model: "claude-opus-5" }'),
          { judgment: () => true },
        );
        expect(own.report.ok).toBe(true);
      }),
    );

    // A judgment check without its own target runs on the worker's first target, as resolved.
    const inheritedJudgment = (rungModel: string) =>
      `return await agent("x", { retries: [{ providerInstanceId: "p", model: "${rungModel}" }], verify: { type: "judgment", rubric: ["ok"] }, report: true })`;

    it.effect("accepts a same-family retry for a check on the caller's model it inherits", () =>
      Effect.gen(function* () {
        const { h, report } = yield* run(inheritedJudgment("gpt-5.5"), { judgment: () => true });
        expect(report).toMatchObject({ ok: true, attempts: 1 });
        // The worker, then its judge.
        expect(h.spawns).toHaveLength(2);
      }),
    );

    it.effect("refuses a retry outside the family of the caller's model the check inherits", () =>
      Effect.gen(function* () {
        const { h, report } = yield* run(inheritedJudgment("claude-sonnet-4-6"));
        expect(report.reason).toContain(
          `retries runs claude-sonnet-4-6 outside the model family of the first target (${CALLER_MODEL})`,
        );
        expect(h.spawns).toEqual([]);
      }),
    );

    // workerTarget's family is not the caller's, so each verdict tells the two paths apart.
    it.effect("judges a check it inherits against workerTarget, not the caller's model", () =>
      Effect.gen(function* () {
        const runOn = (rungModel: string, options: HarnessOptions = {}) =>
          Effect.gen(function* () {
            const h = yield* makeHarness(options);
            yield* h.runner.launch({
              workflowId,
              threadId,
              source: inheritedJudgment(rungModel),
              args: null,
              afterSequence: 0,
              workerTarget: { providerInstanceId: "p", model: "claude-haiku-4-5" },
            });
            return { h, report: JSON.parse(yield* Deferred.await(h.completed)) };
          });
        const same = yield* runOn("claude-sonnet-4-6", { judgment: () => true });
        expect(same.report).toMatchObject({ ok: true, attempts: 1 });
        // The worker runs on workerTarget, and so does the check it inherits.
        expect(same.h.spawns.map((spawn) => spawn.target)).toEqual([
          { providerInstanceId: "p", model: "claude-haiku-4-5" },
          { providerInstanceId: "p", model: "claude-haiku-4-5" },
        ]);
        const other = yield* runOn(CALLER_MODEL);
        expect(other.report.reason).toContain(
          `retries runs ${CALLER_MODEL} outside the model family of the first target (claude-haiku-4-5)`,
        );
        expect(other.h.spawns).toEqual([]);
      }),
    );

    it.effect.each([
      {
        name: "a model its provider does not list",
        bad: { providerInstanceId: "codex", model: "typo" },
        reason: "retries[1]: Model typo is not advertised by provider codex.",
      },
      {
        name: "an option value its model rejects",
        bad: { providerInstanceId: "codex", model: "m", options: { effort: "huge" } },
        reason: "retries[1]: Model m on provider codex rejected options: Option effort must be",
      },
    ])("refuses a retry target with $name before any attempt", ({ bad, reason }) =>
      Effect.gen(function* () {
        // Resolves as graph review does: a listed model and options it accepts.
        const resolveTarget: WorkflowRunnerDeps["resolveTarget"] = (_workflow, value) => {
          const target = value as { readonly model: string; readonly options?: unknown };
          if (target.model === "typo")
            return Effect.fail({
              code: "model_unavailable",
              message: "Model typo is not advertised by provider codex.",
            } as never);
          if (JSON.stringify(target.options ?? {}).includes("huge"))
            return Effect.fail({
              code: "invalid_request",
              message:
                "Model m on provider codex rejected options: Option effort must be one of: low, medium, high.",
            } as never);
          return Effect.succeed({ model: target.model });
        };
        const retries = JSON.stringify([rung("medium"), bad]);
        const source = `return await agent("x", { target: ${JSON.stringify(rung("low"))}, retries: ${retries}, ${checked}, report: true })`;
        const { h, report } = yield* run(source, { resolveTarget, runCommandCheck: failed });
        expect(report).toMatchObject({ ok: false, attempts: 0 });
        expect(report.reason).toContain(reason);
        expect(h.spawns).toEqual([]);
        // An agent an earlier run started may still be running, so it is attached, not refused.
        const resumed = yield* run(source, {
          resolveTarget,
          agentStarted: () => true,
          runCommandCheck: passedOn("thread:agent-1"),
        });
        expect(resumed.report).toMatchObject({ ok: true, attempts: 1 });
      }),
    );

    it.effect("resumes past a stop at the attempt deadline on the next retry target", () =>
      Effect.gen(function* () {
        const source = `return await agent("x", { ${ladder}, attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })`;
        // The first run stops its first attempt at the deadline and records why, then detaches.
        const first = yield* makeHarness({ finish: () => "hang", stopLeavesRunning: true });
        yield* launch(first.runner, source);
        yield* sweepUntil(() => first.stopRequests.length > 0);
        yield* first.runner.detachAll;
        const previousWorkflow = first.workflowUpdates.at(-1)!;
        expect(previousWorkflow.agents[0]?.attemptHistory?.[0]?.stoppedBy).toBe("timed_out");
        const second = yield* makeHarness({
          previousWorkflow,
          taskIds: first.taskIds,
          finish: (n) => (n === 1 ? "cancelled" : "completed"),
        });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        expect(JSON.parse(yield* Deferred.await(second.completed))).toMatchObject({
          ok: true,
          attempts: 2,
        });
        // The stopped attempt counts as failed work, so the next runs on the first retry target.
        expect(second.spawns.map((spawn) => spawn.target)).toEqual([sent("low"), sent("medium")]);
        expect(second.spawns[1]!.task).toContain("passed its time budget of 60000 ms");
      }),
    );

    it.effect("resumes part-way through on the target each attempt started on", () =>
      Effect.gen(function* () {
        const source = `return await agent("x", { ${ladder}, ${checked}, report: true })`;
        // The first run fails its first check, then stops while its second attempt runs.
        const secondStarted = yield* Deferred.make<OrchestrationV2SubagentWorkflow>();
        const first = yield* makeHarness({
          runCommandCheck: failed,
          finish: (n) => (n === 1 ? "completed" : "hang"),
          onWorkflowUpdate: (workflow) =>
            workflow.agents[0]?.attemptHistory?.length === 2
              ? Deferred.succeed(secondStarted, workflow)
              : Effect.void,
        });
        yield* launch(first.runner, source);
        const previousWorkflow = yield* Deferred.await(secondStarted);
        yield* first.runner.detachAll;
        const requestKey = first.spawns[0]!.requestKey;
        const second = yield* makeHarness({
          previousWorkflow,
          taskIds: first.taskIds,
          agentStarted: (key) => first.taskIds.has(key),
          runCommandCheck: passedOn("thread:agent-3"),
        });
        yield* second.runner.launch({
          workflowId,
          threadId,
          source,
          args: null,
          afterSequence: 0,
          previousWorkflow,
        });
        expect(JSON.parse(yield* Deferred.await(second.completed))).toMatchObject({
          ok: true,
          attempts: 3,
        });
        // The first two attempts are attached again by their keys, each on the target it started
        // on; only the third is new.
        expect(first.spawns.map((spawn) => spawn.target)).toEqual([sent("low"), sent("medium")]);
        expect(second.spawns.map((spawn) => [spawn.requestKey, spawn.target])).toEqual([
          [requestKey, sent("low")],
          [`${requestKey}-r1`, sent("medium")],
          [`${requestKey}-r2`, sent("high")],
        ]);
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
      expect(report).toMatchObject({ ok: false, attempts: 2 });
      expect(report.verification).toMatchObject({ type: "structured", outcome: "failed" });
      expect(spawned()).toBe(2);
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
    it.effect("keeps the deadline on a settled task whose thread still runs work", () =>
      Effect.gen(function* () {
        const finalization = yield* Deferred.make<void>();
        const observed = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          finish: () => "hang",
          workLive: true,
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
        expect(harness.stops).toEqual(["node:agent-1:timed_out"]);
        yield* Deferred.succeed(finalization, undefined);
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
      "persists each attempt's usage, timing, identity and effort without charging checkers twice",
      () =>
        Effect.gen(function* () {
          const { runner, completed, workflowUpdates } = yield* makeHarness({
            judgment: (spawned) => spawned !== 2,
            model: (spawned) => `model-${spawned}`,
            startOptions: (spawned) => [
              { id: "reasoningEffort", value: spawned === 1 ? "low" : "high" },
            ],
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
              effort: "low",
              options: { reasoningEffort: "low" },
              state: "completed",
              superseded: true,
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
              effort: "high",
              options: { reasoningEffort: "high" },
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
          ]);
          expect(spawned()).toBe(4);
        }),
    );
    it.effect("keeps a failed check's feedback through a provider failure that follows it", () =>
      Effect.gen(function* () {
        const { runner, completed, spawns } = yield* makeHarness({
          finish: (n) => (n === 3 ? "failed" : "completed"),
          judgment: () => false,
        });
        yield* launch(
          runner,
          'return await agent("x", { node: "a", verify: { type: "judgment", rubric: ["Correct"] } })',
          twoNodePlan,
        );
        yield* Deferred.await(completed);
        // Spawns: work, judge (fails), work with feedback (provider fails), work again, judge.
        const workers = spawns.filter((spawn) => !spawn.task.includes("independent checker"));
        expect(workers.map((spawn) => spawn.requestKey.slice(-3))).toEqual([
          workers[0]!.requestKey.slice(-3),
          "-r1",
          "-r2",
        ]);
        expect(workers.map((spawn) => spawn.task.includes("Your previous attempt"))).toEqual([
          false,
          true,
          true,
        ]);
      }),
    );
    it.effect("retries a provider failure on the same target without using a work attempt", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates, spawned } = yield* makeHarness({
          finish: (n) => (n === 1 ? "failed" : "completed"),
          judgment: () => false,
        });
        yield* launch(
          runner,
          'return await agent("x", { node: "a", verify: { type: "judgment", rubric: ["Correct"] } })',
          twoNodePlan,
        );
        yield* Deferred.await(completed);
        // Both work attempts were judged after the failed one, still within maxAgentsPerCall.
        const agents = workflowUpdates.at(-1)!.agents;
        expect(agents.map((agent) => agent.judgmentFor?.attempt ?? "worker")).toEqual([
          "worker",
          1,
          2,
        ]);
        expect(agents[0]?.attemptHistory?.map((attempt) => attempt.state)).toEqual([
          "failed",
          "completed",
          "completed",
        ]);
        expect(spawned()).toBe(5);
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
        // @effect-diagnostics-next-line processEnvInEffect:off
        if (process.env.C7_PAYLOAD_ARTIFACT) {
          NodeFS.writeFileSync(
            // @effect-diagnostics-next-line processEnvInEffect:off
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
        // A checker cannot read the answer's task, so the marker names a file it can read, by an
        // absolute path outside the checkout.
        const pointer = `${CHECKER_FOLDER}/checker-node:agent-1.txt`;
        expect(body).toMatch(
          new RegExp(`\\.\\.\\.truncated \\(\\d+ of \\d+ bytes\\), full output at ${pointer}$`),
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
          const stored = readableByChecker[0]!.get(`${CHECKER_FOLDER}/checker-node:agent-1.txt`)!;
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

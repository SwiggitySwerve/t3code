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
}

/** A runner whose agents finish as told, recording what it dispatches and stops. */
const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const updates = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const completed = yield* Deferred.make<string>();
    const statuses = new Map<string, string>();
    const taskUpdates = new Map<string, Queue.Queue<void>>();
    const stops: Array<string> = [];
    const keys = new Map<string, string>();
    const firstSpawn = yield* Deferred.make<void>();
    const workflowUpdates: Array<OrchestrationV2SubagentWorkflow> = [];
    const workflowCommands: Array<unknown> = [];
    let spawned = 0;
    const update = (id: string, status: string) => {
      statuses.set(id, status);
      return Effect.gen(function* () {
        const queue = taskUpdates.get(id);
        if (queue !== undefined) yield* Queue.offer(queue, undefined);
        return yield* Queue.offer(updates, {
          sequence: spawned,
          event: {
            type: "subagent.updated",
            payload: { id, status, result: "ok" } as unknown as OrchestrationV2Subagent,
          },
        } as unknown as OrchestrationV2StoredEvent);
      });
    };
    const threads = {
      streamStoredEventsFrom: () => Stream.fromQueue(updates),
      dispatch: (command: {
        readonly type: string;
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
        return command.type === "workflow.complete"
          ? Deferred.succeed(completed, command.result ?? "").pipe(Effect.as({} as never))
          : Effect.succeed({} as never);
      },
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
            summary: "ok",
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
      stopAgent: (_workflow, taskId, _childThreadId, why) =>
        Effect.gen(function* () {
          stops.push(`${taskId}:${why}`);
          yield* update(taskId, "cancelled");
        }),
    };
    return {
      runner: makeWorkflowRunner(deps),
      completed,
      spawned: () => spawned,
      stops,
      keys,
      firstSpawn,
      /** Every row update the runner sent, oldest first. */
      workflowUpdates,
      workflowCommands,
      /** Ends the workflow row as a stop would. */
      stopWorkflow: () => update(workflowId, "cancelled"),
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
});

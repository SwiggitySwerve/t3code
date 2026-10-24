import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowPlan,
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
import { makeWorkflowRunner, type WorkflowRunnerDeps } from "./workflowRunner.ts";
import { aggregateWorkflowUsage } from "./workflowUsage.ts";

const threadId = ThreadId.make("thread:workflow-runner");
const workflowId = NodeId.make("workflow:runner-test");

interface HarnessOptions {
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
    const stops: Array<string> = [];
    const keys = new Map<string, string>();
    const firstSpawn = yield* Deferred.make<void>();
    const workflowUpdates: Array<OrchestrationV2SubagentWorkflow> = [];
    let spawned = 0;
    const update = (id: string, status: string) => {
      statuses.set(id, status);
      return Queue.offer(updates, {
        sequence: spawned,
        event: {
          type: "subagent.updated",
          payload: { id, status, result: "ok" } as unknown as OrchestrationV2Subagent,
        },
      } as unknown as OrchestrationV2StoredEvent);
    };
    const threads = {
      streamStoredEventsFrom: () => Stream.fromQueue(updates),
      dispatch: (command: {
        readonly type: string;
        readonly result?: string;
        readonly workflow?: OrchestrationV2SubagentWorkflow;
      }) => {
        if (command.type === "workflow.update" && command.workflow !== undefined) {
          workflowUpdates.push(command.workflow);
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
          const taskId = NodeId.make(`node:agent-${spawned}`);
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
      readAgent: (_workflow, taskId) =>
        Effect.succeed({
          status: statuses.get(taskId) ?? "running",
          summary: "ok",
          cancelledByServerRestart: false,
          outcomeCategory: statuses.get(taskId) === "completed" ? "completed" : "cancelled",
          usage: aggregateWorkflowUsage([]),
          ...(options.judgment === undefined
            ? {}
            : {
                structuredResult: {
                  outcome: options.judgment(Number(taskId.split("-").at(-1))) ? "passed" : "failed",
                  reasons: "Checked the result",
                },
              }),
          ...(options.structuredResultError === undefined
            ? {}
            : { structuredResultError: options.structuredResultError }),
        }),
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
      /** Ends the workflow row as a stop would. */
      stopWorkflow: () => update(workflowId, "cancelled"),
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
          expect(
            workflowUpdates.some((update) => update.agents[0]?.model === "actual-first-model"),
          ).toBe(true);
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

    it.effect("keeps a 30-node graph's row update under 64 KB", () =>
      Effect.gen(function* () {
        const { runner, completed, workflowUpdates } = yield* makeHarness({
          finish: (n) => (n % 3 === 0 ? "failed" : "completed"),
        });
        const plan: OrchestrationV2WorkflowPlan = {
          nodes: Array.from({ length: 30 }, (_, index) => ({
            key: `node-${String(index).padStart(2, "0")}`,
            label: `Audit package number ${index} for token usage`,
            wave: Math.floor(index / 5),
            dependsOn: index < 5 ? [] : [`node-${String(index - 5).padStart(2, "0")}`],
          })),
        };
        // Prompts at the preview limit and reasons past it: the largest a row gets from these fields.
        yield* launch(
          runner,
          `await parallel(${JSON.stringify(plan.nodes.map((node) => node.key))}.map((key) => async () => {
  await agent(key + " " + "p".repeat(800), { node: key, label: key });
  node(key, { status: "failed", reason: "r".repeat(2000), attempts: 3 });
}))`,
          plan,
        );
        yield* Deferred.await(completed);
        const sizes = workflowUpdates.map((update) => JSON.stringify(update).length);
        const planBytes = JSON.stringify({
          plan: workflowUpdates.at(-1)!.plan,
          nodeOutcomes: workflowUpdates.at(-1)!.nodeOutcomes,
        }).length;
        expect(Object.keys(workflowUpdates.at(-1)!.nodeOutcomes ?? {})).toHaveLength(30);
        expect(Math.max(...sizes)).toBeLessThan(64 * 1024);
        // The plan and outcomes stay a minority of the row.
        expect(planBytes).toBeLessThan(24 * 1024);
      }),
    );
  });
});

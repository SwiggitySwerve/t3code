import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
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
  /** Whether the nth agent (1-based) finishes on its own, and how; otherwise it hangs. */
  readonly finish?: (spawned: number) => "completed" | "failed" | "hang";
  /** Workspace files by path, for declared outputs. */
  readonly files?: Readonly<Record<string, string>>;
}

/** A runner whose agents finish as told, recording what it dispatches and stops. */
const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const updates = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const completed = yield* Deferred.make<string>();
    const statuses = new Map<string, string>();
    const stops: Array<string> = [];
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
      dispatch: (command: { readonly type: string; readonly result?: string }) =>
        command.type === "workflow.complete"
          ? Deferred.succeed(completed, command.result ?? "").pipe(Effect.as({} as never))
          : Effect.succeed({} as never),
      // Every attempt's run started at the epoch, which is where the test clock starts.
      getThreadShell: () =>
        Effect.succeed({
          updatedAt: DateTime.makeUnsafe(0),
          latestRunStartedAt: DateTime.makeUnsafe(0),
        }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"];
    const deps: WorkflowRunnerDeps = {
      threads,
      spawnAgent: () =>
        Effect.gen(function* () {
          spawned += 1;
          const taskId = NodeId.make(`node:agent-${spawned}`);
          const finish = options.finish?.(spawned) ?? "completed";
          if (finish !== "hang") yield* update(taskId, finish);
          return {
            taskId,
            childThreadId: ThreadId.make(`thread:agent-${spawned}`),
            model: null,
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
        }),
      agentStarted: () => Effect.succeed(false),
      canRunCommands: () => Effect.succeed(false),
      runCommandCheck: () => Effect.die("unused"),
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
    };
  });

/** Moves the test clock in stall-sweep steps until the workflow completes, at most 2 hours. */
const sweepUntilDone = (completed: Deferred.Deferred<string>) =>
  Effect.gen(function* () {
    for (let step = 0; step < 240 && !(yield* Deferred.isDone(completed)); step += 1) {
      yield* TestClock.adjust("30 seconds");
    }
  });

const launch = (runner: ReturnType<typeof makeWorkflowRunner>, source: string) =>
  runner.launch({ workflowId, threadId, source, args: null, afterSequence: 0 });

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
});

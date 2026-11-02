import { assert, expect, it } from "@effect/vitest";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestConsole from "effect/testing/TestConsole";

import { printWorkflowReport, type ThreadTools, waitForRun } from "./thread.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

it.effect("workflow-report prints a thread's reports as text, or as JSON with --json", () =>
  Effect.gen(function* () {
    const report = {
      threadId,
      workflows: [
        {
          workflowId: "workflow:one",
          name: "One",
          kind: "script",
          status: "completed",
          agents: [
            {
              index: 0,
              label: "work",
              phase: null,
              role: "worker",
              node: null,
              provider: "codex",
              model: "gpt-5.4",
              effort: "high",
              targetSource: "target",
              usageStatus: "complete",
              inputTokens: 10,
              cachedInputTokens: 5,
              outputTokens: 2,
              totalTokens: 12,
              durationMs: 1_000,
              attempts: 1,
              status: "completed",
              outcome: "completed",
              check: "none",
              checkOutcome: null,
            },
          ],
          summary: [
            {
              role: "worker",
              family: "gpt",
              check: "none",
              agents: 1,
              passed: 1,
              firstTryPassRate: 1,
              redos: 0,
              medianTokensPerPassed: 12,
            },
          ],
          loop: {
            phases: 0,
            agents: 1,
            attempts: 1,
            settledAgents: 1,
            totalTokens: 12,
            budgetTokens: null,
            endedBy: "settled",
          },
        },
      ],
    };
    const { tools, calls } = scriptedTools({ t3_workflow_report: [report, report] });
    yield* printWorkflowReport(tools, threadId, false);
    yield* printWorkflowReport(tools, threadId, true);
    const [text, json] = (yield* TestConsole.logLines).map(String);
    expect(text?.split("\n")).toEqual([
      "One (workflow:one): script, completed",
      "#  label  phase  role    provider/model  effort  source  in/cached/out  time  tries  outcome    check",
      "0  work   -      worker  codex/gpt-5.4   high    target  10/5/2         1.0s  1      completed  -",
      "",
      "role    family  check  agents  first-try pass  redos  median tokens/passed",
      "worker  gpt     none   1       100%            0      12",
      "",
      "phases 0, agents 1 (1 settled), attempts 1, tokens 12, ended by settled",
    ]);
    expect(JSON.parse(json!)).toEqual(report);
    expect(calls.map((entry) => entry.args)).toEqual([{ threadId }, { threadId }]);
  }).pipe(Effect.provide(TestConsole.layer)),
);

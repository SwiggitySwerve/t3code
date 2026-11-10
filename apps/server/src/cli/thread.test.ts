import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { AuthSessionId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  printWorkflowReport,
  readLatestMessages,
  threadCommand,
  ThreadNeedsInputError,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect(
  "start resolves home-relative project paths while preserving ids and relative paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-thread-project-path-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = path.join(root, "home");
      const cwd = path.join(root, "current");
      const workspaceRoot = path.join(home, "My Project");
      const nestedRoot = path.join(workspaceRoot, "nested");
      const baseDir = path.join(root, "state");
      yield* fs.makeDirectory(nestedRoot, { recursive: true });
      yield* fs.makeDirectory(cwd);
      const projects = [
        { id: ProjectId.make("current-project"), title: "Current", workspaceRoot: cwd },
        { id: ProjectId.make("home-project"), title: "Home", workspaceRoot: home },
        { id: ProjectId.make("intended-project"), title: "Intended", workspaceRoot },
        { id: ProjectId.make("nested-project"), title: "Nested", workspaceRoot: nestedRoot },
        { id: ProjectId.make("~/literal-id"), title: "Exact id", workspaceRoot: cwd },
      ];
      yield* persistServerRuntimeState({
        path: path.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
        Effect.succeed({
          call: (tool, args) => {
            switch (tool) {
              case "t3_project_list":
                return Effect.succeed({ structuredContent: { projects, nextCursor: null } });
              case "t3_thread_launch":
                return Effect.succeed({
                  structuredContent: { threadId, projectId: args.projectId, runId: null },
                });
              default:
                return Effect.die(`unexpected ${tool} call`);
            }
          },
        }),
      );

      for (const [identifier, expectedProjectId] of [
        ["intended-project", "intended-project"],
        ["~/literal-id", "~/literal-id"],
        [workspaceRoot, "intended-project"],
        [path.relative(cwd, workspaceRoot), "intended-project"],
        [".", "current-project"],
        ["~/My Project", "intended-project"],
        ["~", "home-project"],
        ["~/My Project/nested", "nested-project"],
        ["~/My Project/missing", "intended-project"],
      ] as const) {
        yield* Command.runWith(threadCommand, { version: "0.0.0" })([
          "start",
          identifier,
          "Inspect this project",
          "--json",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        assert.strictEqual(
          (yield* TestConsole.logLines).at(-1),
          JSON.stringify({ threadId, projectId: expectedProjectId, runId: null }),
          identifier,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
        ),
      ),
    ),
);

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
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000, untilDelegatedWorkSettled: true },
        { threadId, runId, timeoutMs: 15_000, untilDelegatedWorkSettled: true },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "waiting", timedOut: true, awaitingAnswer: "thread" },
        { threadId, runId, status: "waiting", timedOut: true, awaitingAnswer: "thread" },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "needs_input",
      reason: "request",
    });
  }),
);

// The coordinator's own run has ended and holds no request; only the server
// knows a workflow agent's thread asks something.
it.effect("--wait stops when an agent in the thread's workflow waits for an answer", () =>
  Effect.gen(function* () {
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "completed", timedOut: true },
        { threadId, runId, status: "completed", timedOut: true, awaitingAnswer: "descendant" },
        { threadId, runId, status: "completed", timedOut: true, awaitingAnswer: "descendant" },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "needs_input",
      reason: "member_request",
    });
    assert.deepStrictEqual(
      calls.map((entry) => (entry.args as { readonly timeoutMs: number }).timeoutMs),
      [15_000, 15_000, 1],
    );
    assert.include(
      new ThreadNeedsInputError({ threadId, reason: "member_request" }).message,
      "workflow agent or task",
    );
  }),
);

it.effect("--wait keeps waiting when the request was answered before the recheck", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "completed", timedOut: true, awaitingAnswer: "descendant" },
        // Answered, and the workflow agent works on.
        { threadId, runId, status: "completed", timedOut: true },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId, status: "completed" },
        },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

it.effect("--wait reports the run a workflow's completion wakes, not the first turn", () =>
  Effect.gen(function* () {
    const wake = RunId.make("run-2");
    const { tools } = scriptedTools({
      t3_thread_wait: [
        // The first turn ended, but its workflow is still running.
        { threadId, runId, status: "completed", timedOut: true },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId: wake, status: "completed" },
        },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId: wake,
      status: "completed",
    });
  }),
);

it.effect("--wait reports the answered run when a request clears before the recheck", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "waiting", timedOut: true, awaitingAnswer: "thread" },
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId, status: "completed" },
        },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

// Ending the turn on a review settles the thread, but its workflow has not run.
it.effect("--wait needs input when the turn ends on a workflow waiting for approval", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        {
          threadId,
          runId,
          status: "completed",
          timedOut: false,
          resultRun: { runId, status: "completed" },
          awaitingAnswer: "workflow_review",
        },
      ],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "needs_input",
      reason: "workflow_review",
      runId,
    });
    assert.include(
      new ThreadNeedsInputError({ threadId, reason: "workflow_review" }).message,
      "approve or dismiss its workflow",
    );
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
              childThreadId: null,
              provider: "codex",
              model: "gpt-5.4",
              effort: "high",
              targetSource: "target",
              usageStatus: "complete",
              inputTokens: 10,
              cachedInputTokens: 5,
              outputTokens: 2,
              totalTokens: 12,
              costUsd: 0.0001,
              costSource: "modelPriced",
              attemptCosts: [],
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
              retries: 0,
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
      pricing: { status: "cached", source: "rates.json", fetchedAt: null },
    };
    const { tools, calls } = scriptedTools({ t3_workflow_report: [report, report] });
    yield* printWorkflowReport(tools, threadId, false);
    yield* printWorkflowReport(tools, threadId, true);
    const [text, json] = (yield* TestConsole.logLines).map(String);
    expect(text?.split("\n")).toEqual([
      "One (workflow:one): script, completed",
      "#  label  phase  role    provider/model  effort  source  in/cached/out  cost     time  tries  outcome    check",
      "0  work   -      worker  codex/gpt-5.4   high    target  10/5/2         $0.0001  1.0s  1      completed  -",
      "",
      "role    family  check  agents  first-try pass  retries  escalations  median tokens/passed",
      "worker  gpt     none   1       100%            0        -            12",
      "",
      "phases 0, agents 1 (1 settled), attempts 1, tokens 12, ended by settled",
      "",
      "list prices: cached",
    ]);
    expect(JSON.parse(json!)).toEqual(report);
    expect(calls.map((entry) => entry.args)).toEqual([{ threadId }, { threadId }]);
  }).pipe(Effect.provide(TestConsole.layer)),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

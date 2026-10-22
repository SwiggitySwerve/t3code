import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { makeWorkflowRunner, type WorkflowRunnerDeps } from "./workflowRunner.ts";

const threadId = ThreadId.make("thread:workflow-runner");
const workflowId = NodeId.make("workflow:runner-test");

/** A runner whose agents finish as soon as they start, recording what it dispatches. */
const makeHarness = Effect.gen(function* () {
  const updates = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
  const completed = yield* Deferred.make<string>();
  let spawned = 0;
  const finished = (id: string) =>
    ({
      sequence: spawned,
      event: {
        type: "subagent.updated",
        payload: { id, status: "completed", result: "ok" } as unknown as OrchestrationV2Subagent,
      },
    }) as unknown as OrchestrationV2StoredEvent;
  const threads = {
    streamStoredEventsFrom: () => Stream.fromQueue(updates),
    dispatch: (command: { readonly type: string; readonly result?: string }) =>
      command.type === "workflow.complete"
        ? Deferred.succeed(completed, command.result ?? "").pipe(Effect.as({} as never))
        : Effect.succeed({} as never),
    getThreadShell: () => Effect.succeed(null),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];
  const deps: WorkflowRunnerDeps = {
    threads,
    spawnAgent: () =>
      Effect.gen(function* () {
        spawned += 1;
        const taskId = NodeId.make(`node:agent-${spawned}`);
        yield* Queue.offer(updates, finished(taskId));
        return {
          taskId,
          childThreadId: ThreadId.make(`thread:agent-${spawned}`),
          model: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
        };
      }),
    readAgent: () =>
      Effect.succeed({
        status: "completed",
        summary: "ok",
        cancelledByServerRestart: false,
        tokens: 0,
      }),
    agentStarted: () => Effect.succeed(false),
    stopAgent: () => Effect.void,
  };
  return { runner: makeWorkflowRunner(deps), completed, spawned: () => spawned };
});

describe("workflow runner", () => {
  it.effect("refuses the agent past the per-workflow limit of 1000", () =>
    Effect.gen(function* () {
      const { runner, completed, spawned } = yield* makeHarness;
      yield* runner.launch({
        workflowId,
        threadId,
        source:
          "let started = 0\ntry { for (let i = 0; i < 1001; i++) { await agent('a' + i); started++ } } catch (error) { return [started, error.message] }",
        args: null,
        afterSequence: 0,
      });
      const result = JSON.parse(yield* Deferred.await(completed));
      expect(result).toEqual([1000, "This workflow reached its limit of 1000 agents."]);
      expect(spawned()).toBe(1000);
    }),
  );
});

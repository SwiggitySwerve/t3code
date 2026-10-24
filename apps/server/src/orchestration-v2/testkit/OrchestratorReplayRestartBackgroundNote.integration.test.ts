import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeRestartReplayHarness,
} from "../Adapters/ClaudeAdapterV2.testkit.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { workflowTurnNote } from "@t3tools/provider-core/server/workflowTrigger";
import * as EffectWorker from "../EffectWorker.ts";
import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./fixtures/claude_background_subagent_after_root/input.ts";
import {
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "./fixtures/shared.ts";
import { runOrchestratorV2ProviderReplayScenario } from "./ProviderReplayHarness.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { runOrchestratorV2Scenario } from "./OrchestratorScenario.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";

const SCENARIO = "claude_background_subagent_after_root";
const SESSION_ID = "cca274e4-25ae-4171-b972-bbb31118517e";
const FIRST_AFTER_RESTART = "Is the background subagent done yet?";
const SECOND_AFTER_RESTART = "Thanks. Anything else?";
const NOTE = [
  "Note: the T3 server restarted, and this background work was cancelled before it finished. It will not report back on its own, so resume or restart what you still need and wait for its result:",
  "- subagent: Background subagent test (id a2995bfced8019363)",
].join("\n");

const readRestartTranscript = Effect.fn("readRestartTranscript")(function* (
  resumedPrompts: ReadonlyArray<string>,
) {
  const recorded = yield* readProviderReplayTranscript(
    new URL(`./fixtures/${SCENARIO}/claude_transcript.ndjson`, import.meta.url),
  );
  const rootResult = recorded.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "result",
  );

  const queryOpen = recorded.entries[0];
  const openFrame = queryOpen?.type === "expect_outbound" ? queryOpen.frame : undefined;
  const queryOptions: unknown =
    typeof openFrame === "object" && openFrame !== null
      ? Reflect.get(openFrame, "options")
      : undefined;
  if (typeof queryOptions !== "object" || queryOptions === null) {
    throw new Error(`${SCENARIO} must open with a recorded query.open frame.`);
  }
  const { sessionId: _sessionId, ...resumeOptions } = queryOptions as Record<string, unknown>;
  const resumedTurn = (label: string, text: string): ReadonlyArray<ProviderReplayEntry> => [
    {
      type: "expect_outbound",
      label: `prompt.offer:${label}`,
      frame: {
        type: "prompt.offer",
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        },
      },
    },
    {
      type: "emit_inbound",
      label: `assistant:${label}`,
      frame: {
        type: "assistant",
        message: {
          model: "claude-sonnet-4-6",
          id: `msg_restart_${label}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `REPLY_${label}` }],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        session_id: SESSION_ID,
        uuid: `restart-assistant-${label}`,
      },
    },
    {
      type: "emit_inbound",
      label: `result:${label}`,
      frame: {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 1,
        result: `REPLY_${label}`,
        stop_reason: "end_turn",
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        session_id: SESSION_ID,
        uuid: `restart-result-${label}`,
      },
    },
  ];
  return yield* ClaudeOrchestratorReplayHarness.decodeTranscript({
    ...recorded,
    entries: [
      ...recorded.entries.slice(0, rootResult + 1),
      // Keep the query alive until the crash snapshot is captured.
      {
        type: "expect_outbound",
        label: "query.open:resume",
        frame: { type: "query.open", options: { ...resumeOptions, resume: SESSION_ID } },
      },
      ...resumedPrompts.flatMap((prompt, index) => resumedTurn(String(index + 1), prompt)),
    ],
  });
});

const runRestart = Effect.fn("runRestart")(function* (input: {
  readonly resumedPrompts: ReadonlyArray<string>;
  readonly userMessagesAfterRestart: ReadonlyArray<string>;
  readonly continueThreadsAfterServerUpdate: boolean;
  /** Applies to the turns after the restart; the recorded first turn ran with the defaults. */
  readonly serverSettings?: ProviderReplayHarness.ReplayServerSettings;
}) {
  const transcript = yield* readRestartTranscript(input.resumedPrompts);
  const workspace = yield* checkpointWorkspace(SCENARIO);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "t3-orchestration-v2-restart-note-" }),
    (directory) => fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: SCENARIO,
    fixtureInput: {
      steps: [
        { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT },
        ...input.userMessagesAfterRestart.map((text) => ({ type: "message" as const, text })),
      ],
    },
    driver: ProviderDriverKind.make("claudeAgent"),
    modelSelection: CLAUDE_MODEL_SELECTION,
  });

  const firstIdle = materialized.steps.findIndex((step) => step.type === "await_thread_idle");
  const phase1Steps = materialized.steps.slice(0, firstIdle + 1);
  const phase2Steps = materialized.steps.slice(firstIdle + 1);
  const { harness, assertComplete } = makeClaudeRestartReplayHarness(transcript);
  const layerDatabase = SqlitePersistence.layerFromPath(path.join(tempDir, "state.sqlite")).pipe(
    Layer.provide(NodeServices.layer),
  );
  const snapshotPath = path.join(tempDir, "restart-state.sqlite");
  const scenario = (name: string, steps: typeof materialized.steps) => ({
    name: `${SCENARIO}:${name}`,
    transcript,
    commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
    steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { cwd: workspace },
  });

  const beforeScenario = scenario("before-restart", phase1Steps);
  const before = yield* Effect.scoped(
    Effect.gen(function* () {
      const result = yield* runOrchestratorV2Scenario(beforeScenario);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = materialized.projectionThreadIds[0];
      if (threadId === undefined) {
        return yield* Effect.die("restart scenario has no projection thread");
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const session = projection.providerSessions[0];
      if (session === undefined) {
        return yield* Effect.die("restart scenario has no provider session");
      }
      // Snapshot the legacy running task before exit cleanup settles it, then
      // seed the stopped session that older runtimes could leave after a crash.
      const now = yield* DateTime.now;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:restart-background-note:stopped-provider-session"),
            type: "provider-session.updated",
            threadId,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: { ...session, status: "stopped", updatedAt: now, lastError: null },
          },
        ],
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${snapshotPath}`;
      return result;
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProviderReplayHarness.layerProviderReplay(beforeScenario, harness, {
            databaseLayer: layerDatabase,
          }),
          layerDatabase,
        ),
      ),
    ),
  );
  const snapshotDatabase = SqlitePersistence.layerFromPath(snapshotPath).pipe(
    Layer.provide(NodeServices.layer),
  );
  const settled = projectionFor(before, SCENARIO);
  assert.equal(settled.runs[0]?.status, "completed");
  assert.equal(settled.subagents[0]?.status, "running");

  const restartScenario = scenario("restarted", []);
  const restarted = yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      return yield* runOrchestratorV2Scenario(restartScenario);
    }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(restartScenario, harness, {
          databaseLayer: snapshotDatabase,
          recoverOnStartup: true,
          continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
        }),
      ),
    ),
  );
  const recovered = projectionFor(restarted, SCENARIO);
  assert.deepEqual(
    recovered.runs.map((run) => run.status),
    ["completed"],
  );
  assert.equal(recovered.subagents[0]?.status, "cancelled");
  assert.equal(recovered.runs[0]?.restartCancelledBackgroundWork?.[0]?.kind, "subagent");

  const after = yield* Effect.scoped(
    runOrchestratorV2ProviderReplayScenario(scenario("after-restart", phase2Steps), harness, {
      databaseLayer: snapshotDatabase,
      continueThreadsAfterServerUpdate: input.continueThreadsAfterServerUpdate,
      ...(input.serverSettings === undefined ? {} : { serverSettings: input.serverSettings }),
    }),
  );

  yield* assertComplete;
  const projection = projectionFor(after, SCENARIO);
  assert.equal(projection.subagents[0]?.status, "cancelled");
  return projection;
});

const userTexts = (projection: ReturnType<typeof projectionFor>) =>
  projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : []));

describe("restart-cancelled background work", () => {
  it.effect.each([false, true])(
    "keeps the thread settled and tells the next user turn once when continuation is %s",
    (continueThreadsAfterServerUpdate) =>
      Effect.scoped(
        Effect.gen(function* () {
          const projection = yield* runRestart({
            resumedPrompts: [
              `${NOTE}\n\nUser message:\n${FIRST_AFTER_RESTART}`,
              SECOND_AFTER_RESTART,
            ],
            userMessagesAfterRestart: [FIRST_AFTER_RESTART, SECOND_AFTER_RESTART],
            continueThreadsAfterServerUpdate,
          });
          assert.deepEqual(
            projection.runs.map((run) => run.status),
            ["completed", "completed", "completed"],
          );
          assert.isFalse(
            projection.runs.some((run) => run.restartContinuationOfRunId !== undefined),
          );

          assert.deepEqual(userTexts(projection), [
            CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
            FIRST_AFTER_RESTART,
            SECOND_AFTER_RESTART,
          ]);
        }).pipe(
          provideDeterministicTestRuntime,
          Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
        ),
      ),
  );
});

// The real hook, delivery wrapper and Claude adapter: the workflow note must reach the provider
// after the restart note, on a driver whose own ultracode a keyword would otherwise start.
describe("workflow trigger on the first turn after a restart", () => {
  const PROFILES = {
    presets: [
      {
        id: "profile-fast",
        name: "Fast worker",
        target: {
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
        },
      },
    ],
    defaultPresetId: null,
  };
  const NOTE_FOR_PROFILES = workflowTurnNote(PROFILES);
  const run = (input: {
    readonly typed: string;
    readonly resumedPrompt: string;
    /** The next message does not ask for a workflow, so only the ultracode setting shapes it. */
    readonly secondPrompt?: string;
    readonly serverSettings: ProviderReplayHarness.ReplayServerSettings;
  }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const projection = yield* runRestart({
          resumedPrompts: [input.resumedPrompt, input.secondPrompt ?? SECOND_AFTER_RESTART],
          userMessagesAfterRestart: [input.typed, SECOND_AFTER_RESTART],
          continueThreadsAfterServerUpdate: false,
          serverSettings: input.serverSettings,
        });
        // The stored message is what the person typed; the note is only in the provider prompt.
        assert.deepEqual(userTexts(projection), [
          CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT,
          input.typed,
          SECOND_AFTER_RESTART,
        ]);
      }).pipe(
        provideDeterministicTestRuntime,
        Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
      ),
    );

  it.effect(
    "keeps the plan-first note after the restart note and lists the user's profiles",
    () => {
      const typed = "Plan a workflow to finish the background audit";
      return run({
        typed,
        resumedPrompt: `${NOTE}\n\nUser message:\n${typed}\n\n${NOTE_FOR_PROFILES}`,
        serverSettings: { workflowPresets: PROFILES },
      });
    },
  );

  it.effect("prefers the workflow note over ultracode and adds no native trigger word", () => {
    const typed = "ultracode: finish the background audit as a workflow";
    return run({
      typed,
      resumedPrompt: `${NOTE}\n\nUser message:\n${typed}\n\n${workflowTurnNote({ presets: [], defaultPresetId: null })}`,
      // Claude's own ultracode keyword is added only where the person did not ask for a workflow.
      secondPrompt: `${SECOND_AFTER_RESTART}\n\nultracode`,
      serverSettings: { ultracode: "always" },
    });
  });

  it.effect("sends the message as typed when workflow triggers are off", () => {
    const typed = "Finish the background audit as a workflow";
    return run({
      typed,
      resumedPrompt: `${NOTE}\n\nUser message:\n${typed}`,
      serverSettings: { ultracode: "off", workflowTriggers: { enabled: false, extras: [] } },
    });
  });
});

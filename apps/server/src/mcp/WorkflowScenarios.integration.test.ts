/**
 * Dynamic workflow scenarios on stub providers: a `workflow_start` script in Claude's Workflow
 * format, workers finished with scripted results, and assertions on the runner's invariants and
 * on the stored record and its workflow report. Nothing here reaches a real provider.
 */
// @effect-diagnostics nodeBuiltinImport:off -- a test writes the file a worker's command would.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestratorMcpWorkflowReport,
  OrchestratorMcpWorkflowReportResult,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import { formatWorkflowReport } from "./workflowReport.ts";
import {
  answerWorkflowAgents,
  awaitCheckers,
  awaitMember,
  awaitWorkflowEnd,
  childTasks,
  claudeInstanceId,
  claudeModel,
  completeChild,
  decodeReview,
  decodeWorkflow,
  instanceId,
  invocation,
  invoke,
  invokeAs,
  layerRefusedTargets,
  layerTest,
  model,
  reviewGraph,
  parentThreadId,
  setBackgroundWork,
  wakeChild,
  withScratchDir,
  startParent,
  startWorkflow,
  withServerProcess,
  adjustBySweeps,
  type WorkerReply,
} from "./WorkflowHarness.testkit.ts";

/** The t3 CLI's caller: a client outside any thread. */
const cli: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:delegate-tasks"),
  requestNamespace: "client:workflow-report",
  thread: undefined,
  client: { sessionId: "cli", label: "t3 thread cli", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const isChecker = (prompt: string) => prompt.includes("independent checker");
const verdict = (passed: boolean, reasons: string) =>
  `\`\`\`json\n${JSON.stringify({ outcome: passed ? "passed" : "failed", reasons })}\n\`\`\``;
const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

/** The report `t3 thread workflow-report` prints for one workflow of the test thread. */
const decodeReport = Schema.decodeUnknownEffect(OrchestratorMcpWorkflowReportResult);
const reportOf = (workflowId: string) =>
  Effect.gen(function* () {
    const result = yield* invokeAs(cli, "t3_workflow_report", { threadId: parentThreadId });
    expect(result.isError).not.toBe(true);
    const { workflows } = yield* decodeReport(result.structuredContent);
    return workflows.find((entry) => entry.workflowId === workflowId)!;
  });

const membersOf = (workflowId: string) =>
  Effect.map(childTasks, (tasks) => tasks.filter((task) => task.parentNodeId === workflowId));

const rowOf = (workflowId: string) =>
  Effect.map(childTasks, (tasks) => tasks.find((task) => task.id === workflowId)!);

const TERMINAL: ReadonlyArray<OrchestrationV2Subagent["status"]> = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

/** Every agent task the workflow started has ended, and so has every agent its record holds. */
const expectSettled = (workflowId: string) =>
  Effect.gen(function* () {
    const members = yield* membersOf(workflowId);
    expect(members.filter((task) => !TERMINAL.includes(task.status))).toEqual([]);
    const row = yield* rowOf(workflowId);
    expect(
      row.workflow?.agents.filter(
        (agent) => agent.state !== "completed" && agent.state !== "failed",
      ),
    ).toEqual([]);
    return members;
  });

const groupsOf = (report: OrchestratorMcpWorkflowReport) =>
  report.summary.map((group) => [
    group.role,
    group.family,
    group.check,
    group.agents,
    group.firstTryPassRate,
    group.retries,
  ]);

describe("workflow scenarios", () => {
  it.effect("1. a failed verify check redoes the work, and the second attempt passes", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(
        (prompt) => json({ ok: prompt.includes("did not pass its") }),
        300,
      );
      const started = yield* startWorkflow(
        'return await agent("build the parser", { label: "build", schema: { type: "object", required: ["ok"] }, verify: { type: "structured", equals: { "/ok": true } }, report: true })',
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({
        ok: true,
        result: { ok: true },
        attempts: 2,
        verification: { type: "structured", outcome: "passed", attempts: 2 },
      });
      expect(yield* expectSettled(started.workflowId)).toHaveLength(2);
      const report = yield* reportOf(started.workflowId);
      expect(report.agents).toMatchObject([
        {
          label: "build",
          attempts: 2,
          totalTokens: 600,
          check: "structured",
          checkOutcome: "passed",
          targetSource: "caller",
        },
      ]);
      expect(groupsOf(report)).toEqual([["worker", "gpt", "structured", 1, 0, 1]]);
      expect(report.loop).toMatchObject({ attempts: 2, endedBy: "settled", totalTokens: 600 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "2. a reviewer on another provider rejects the work, and the script redoes it with more effort",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) => {
          if (isChecker(prompt))
            return verdict(prompt.includes("careful draft"), "Checked the draft.");
          return prompt.includes("Take more care") ? "careful draft" : "quick draft";
        }, 200);
        const started = yield* startWorkflow(
          `const verify = { type: "judgment", rubric: ["The draft is careful."], target: args.judge };
let draft = await agent("write the summary", { label: "summary", target: args.quick, verify, report: true });
const first = draft.reason;
if (!draft.ok) draft = await agent("write the summary. Take more care.", { label: "summary again", target: args.careful, verify, report: true });
return { ok: draft.ok, result: draft.result, first };`,
          {
            judge: { providerInstanceId: claudeInstanceId, model: claudeModel },
            quick: { providerInstanceId: instanceId, model, options: { reasoningEffort: "low" } },
            careful: {
              providerInstanceId: instanceId,
              model,
              options: { reasoningEffort: "high" },
            },
          },
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        const result = JSON.parse(ended.result!);
        expect(result).toMatchObject({ ok: true, result: "careful draft" });
        expect(result.first).toContain("judgment check failed");
        yield* expectSettled(started.workflowId);
        const report = yield* reportOf(started.workflowId);
        expect(
          report.agents.map((agent) => [
            agent.label,
            agent.role,
            agent.provider,
            agent.effort,
            agent.attempts,
            agent.checkOutcome,
          ]),
        ).toEqual([
          ["summary", "worker", instanceId, "low", 2, "failed"],
          ["check summary", "checker", claudeInstanceId, null, 1, "failed"],
          ["check summary", "checker", claudeInstanceId, null, 1, "failed"],
          ["summary again", "worker", instanceId, "high", 1, "passed"],
          ["check summary again", "checker", claudeInstanceId, null, 1, "passed"],
        ]);
        expect(report.agents.every((agent) => agent.targetSource === "target")).toBe(true);
        // Each attempt keeps the effort it ran at; with no rate table every cost stays unknown.
        expect(
          report.agents.flatMap((agent) =>
            (agent.attemptCosts ?? []).map((attempt) => [
              agent.label,
              attempt.effort,
              attempt.costSource,
            ]),
          ),
        ).toEqual(
          expect.arrayContaining([
            ["summary", "low", "noRates"],
            ["summary again", "high", "noRates"],
          ]),
        );
        expect(report.agents.every((agent) => agent.costUsd === null)).toBe(true);
        expect(groupsOf(report)).toEqual([
          ["checker", "claude", "none", 3, 1, 0],
          ["worker", "gpt", "judgment", 2, 0.5, 1],
        ]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "3. a report that says the work is incomplete opens a research phase with new agents",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) => {
          if (prompt.startsWith("survey")) return undefined;
          return prompt.startsWith("research") ? `notes on ${prompt.slice(9)}` : "written";
        });
        const started = yield* startWorkflow(
          `const survey = await progress.phase("Survey", { total: 1 }, (bar) => bar.agent("survey the code", { label: "survey", schema: { type: "object", required: ["gaps"] }, report: true }));
const gaps = survey.ok ? survey.result.gaps : [];
const notes = gaps.length === 0 ? [] : await progress.phase("Research", { total: gaps.length }, (bar) => parallel(gaps.map((gap) => () => bar.agent("research " + gap, { label: gap }))));
const done = await progress.phase("Write", { total: 1 }, (bar) => bar.agent("write it up", { label: "write" }));
return { notes, done };`,
        );
        const survey = yield* awaitMember(started.workflowId, 1);
        // While the survey runs, only its own phase exists: the rest are found at run time.
        expect(
          (yield* rowOf(started.workflowId)).workflow?.phases.map((phase) => phase.title),
        ).toEqual(["Survey"]);
        yield* completeChild(
          survey.childThreadId!,
          json({ complete: false, gaps: ["auth", "cache"] }),
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toEqual({
          notes: ["notes on auth", "notes on cache"],
          done: "written",
        });
        expect(ended.phaseProgress?.map((phase) => [phase.title, phase.progress])).toEqual([
          ["Survey", { total: 1, state: "completed" }],
          ["Research", { total: 2, state: "completed" }],
          ["Write", { total: 1, state: "completed" }],
        ]);
        yield* expectSettled(started.workflowId);
        const report = yield* reportOf(started.workflowId);
        expect(report.agents.map((agent) => [agent.label, agent.phase])).toEqual([
          ["survey", "Survey"],
          ["auth", "Research"],
          ["cache", "Research"],
          ["write", "Write"],
        ]);
        expect(report.loop).toMatchObject({ phases: 3, agents: 4, attempts: 4 });
      }).pipe(Effect.provide(layerTest)),
  );

  const stateLoop = (cap: number) =>
    `for (let round = 1; round <= ${cap}; round++) {
  await agent("apply step " + round, { label: "step " + round });
  const state = await agent("is the migration done after step " + round + "?", { label: "state " + round, schema: { type: "object", required: ["done"] } });
  if (state !== null && state.done) return { rounds: round };
}
return { rounds: null };`;

  it.effect("4. a state check loop repeats until the checker says done", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) =>
        prompt.startsWith("is the migration")
          ? json({ done: prompt.includes("after step 3") })
          : "applied",
      );
      const started = yield* startWorkflow(stateLoop(10));
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toEqual({ rounds: 3 });
      expect(yield* expectSettled(started.workflowId)).toHaveLength(6);
      const report = yield* reportOf(started.workflowId);
      expect(report.loop).toMatchObject({ agents: 6, attempts: 6, endedBy: "settled" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    { name: "the token budget", budgetTokens: 1_000, cap: 50, endedBy: "budget", agents: 6 },
    {
      name: "the script's loop cap",
      budgetTokens: undefined,
      cap: 3,
      endedBy: "settled",
      agents: 6,
    },
  ])("5. a checker that never says done stops at $name and settles", (variant) =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(
        (prompt) => (prompt.startsWith("is the migration") ? json({ done: false }) : "applied"),
        200,
      );
      const started = yield* decodeWorkflow(
        (yield* invoke("workflow_start", {
          script: stateLoop(variant.cap),
          ...(variant.budgetTokens === undefined ? {} : { budgetTokens: variant.budgetTokens }),
        })).structuredContent,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      const members = yield* expectSettled(started.workflowId);
      const report = yield* reportOf(started.workflowId);
      expect(report.loop).toMatchObject({ agents: variant.agents, endedBy: variant.endedBy });
      if (variant.budgetTokens === undefined) {
        expect(JSON.parse(ended.result!)).toEqual({ rounds: null });
        expect(members).toHaveLength(6);
        return;
      }
      // Five agents ran (1,000 tokens); the sixth was refused before it started.
      expect(ended.status).toBe("failed");
      expect(ended.result).toContain("budget of 1000 tokens is spent");
      expect(members).toHaveLength(5);
      expect(report.agents.at(-1)).toMatchObject({ outcome: "never_started", attempts: 0 });
      expect(report.loop.totalTokens).toBe(1_000);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("6. one parallel branch fails and the others' results are kept", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt): WorkerReply =>
        prompt.includes("module b")
          ? { text: "", status: "failed" }
          : { text: `reviewed ${prompt.slice(7)}`, tokens: 100 },
      );
      const started = yield* startWorkflow(
        // Only module b declares a check, which its failed attempts never reach.
        `const verify = { type: "process", argv: ["node", "-e", "0"] };
const reports = await parallel(["module a", "module b", "module c"].map((name) => () => agent("review " + name, { label: name, report: true, ...(name === "module b" ? { verify } : {}) })));
return { kept: reports.filter((entry) => entry.ok).map((entry) => entry.result), failed: reports.filter((entry) => !entry.ok).length };`,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toEqual({
        kept: ["reviewed module a", "reviewed module c"],
        failed: 1,
      });
      // A provider failure is retried twice beside the work attempts; the others ran once.
      expect(yield* expectSettled(started.workflowId)).toHaveLength(5);
      const report = yield* reportOf(started.workflowId);
      expect(
        report.agents.map((agent) => [
          agent.label,
          agent.attempts,
          agent.outcome,
          agent.check,
          agent.checkOutcome,
        ]),
      ).toEqual([
        ["module a", 1, "completed", "none", null],
        ["module b", 3, "provider_error", "process", "not_run"],
        ["module c", 1, "completed", "none", null],
      ]);
      expect(report.agents.every((agent) => agent.childThreadId !== null)).toBe(true);
      expect(groupsOf(report)).toEqual([
        ["worker", "gpt", "none", 2, 1, 0],
        ["worker", "gpt", "process", 1, 0, 2],
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("7. an attempt past its deadline counts as a failed attempt and is retried", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("slow work", { label: "slow", attemptTimeoutMs: 60000, report: true })',
      );
      yield* awaitMember(started.workflowId, 1);
      yield* adjustBySweeps(4);
      const retry = yield* awaitMember(started.workflowId, 2);
      yield* completeChild(retry.childThreadId!, "finished in time");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({
        ok: true,
        result: "finished in time",
        attempts: 2,
      });
      yield* expectSettled(started.workflowId);
      const row = yield* rowOf(started.workflowId);
      expect(row.workflow?.agents[0]?.attemptHistory?.map((entry) => entry.state)).toEqual([
        "interrupted",
        "completed",
      ]);
      const report = yield* reportOf(started.workflowId);
      expect(report.agents[0]).toMatchObject({ attempts: 2, status: "completed" });
      expect(groupsOf(report)).toEqual([["worker", "gpt", "none", 1, 0, 1]]);
    }).pipe(Effect.provide(layerTest)),
  );

  const steps = (cap: number) =>
    `const done = [];
for (let step = 1; step <= ${cap}; step++) done.push(await agent("step " + step, { label: "step " + step }));
return done;`;

  it.effect("8. stopping mid-loop settles everything and starts no further agent", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) => (prompt === "step 3" ? undefined : `did ${prompt}`));
      const started = yield* startWorkflow(steps(20));
      const third = yield* awaitMember(started.workflowId, 3);
      expect(third.prompt).toBe("step 3");
      yield* invoke("workflow_stop", { workflowId: started.workflowId });
      // Time for a runner that ignored the stop to start the next agent.
      yield* adjustBySweeps(10);
      yield* Effect.yieldNow;
      const ended = yield* decodeWorkflow(
        (yield* invoke("workflow_status", { workflowId: started.workflowId })).structuredContent,
      );
      expect(ended.status).toBe("cancelled");
      const members = yield* membersOf(started.workflowId);
      expect(members.map((task) => task.prompt)).toEqual(["step 1", "step 2", "step 3"]);
      expect(members.filter((task) => !TERMINAL.includes(task.status))).toEqual([]);
      // A stop leaves the record's running agent as it was; readers take its task's status.
      const report = yield* reportOf(started.workflowId);
      expect(report.agents.map((agent) => agent.status)).toEqual([
        "completed",
        "completed",
        "interrupted",
      ]);
      expect(report.loop).toMatchObject({ agents: 3, settledAgents: 3 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("9. a restart mid-loop resumes it without running finished agents again", () =>
    Effect.gen(function* () {
      yield* startParent;
      const workflowId = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          const started = yield* service.workflowStart(invocation, { script: steps(4) });
          for (const step of [1, 2]) {
            const member = yield* awaitMember(started.workflowId, step);
            yield* completeChild(member.childThreadId!, `did step ${step}`, undefined, 100);
          }
          yield* awaitMember(started.workflowId, 3);
          return started.workflowId;
        }),
      );
      const ended = yield* withServerProcess((service) =>
        Effect.gen(function* () {
          expect(yield* service.resumeWorkflows).toBe(1);
          for (const step of [3, 4]) {
            const member = yield* awaitMember(workflowId, step);
            yield* completeChild(member.childThreadId!, `did step ${step}`, undefined, 100);
          }
          return yield* awaitWorkflowEnd(workflowId);
        }),
      );
      expect(JSON.parse(ended.result!)).toEqual([
        "did step 1",
        "did step 2",
        "did step 3",
        "did step 4",
      ]);
      const members = yield* expectSettled(workflowId);
      expect(members.map((task) => task.prompt)).toEqual(["step 1", "step 2", "step 3", "step 4"]);
      const report = yield* reportOf(workflowId);
      expect(
        report.agents.map((agent) => [agent.label, agent.attempts, agent.totalTokens]),
      ).toEqual([1, 2, 3, 4].map((step) => [`step ${step}`, 1, 100]));
      expect(report.loop).toMatchObject({ attempts: 4, totalTokens: 400, endedBy: "settled" });
    }).pipe(Effect.provide(layerTest)),
  );

  describe("10. a checker whose provider is not enabled", () => {
    const judge = { providerInstanceId: claudeInstanceId, model: claudeModel };

    it.effect("blocks graph review instead of falling back to the worker's model", () =>
      Effect.gen(function* () {
        yield* startParent;
        const reviewed = yield* decodeReview(
          (yield* invoke("graph_review", {
            graph: {
              schemaVersion: 1,
              nodes: {
                a: {
                  subject: "work",
                  description: "do the work",
                  dependsOn: [],
                  verify: { type: "judgment", rubric: ["It is done."], target: judge },
                },
              },
            },
          })).structuredContent,
        );
        expect(reviewed.digest).toBeNull();
        expect(reviewed.next).toBe("Fix the blockers, then call graph_review again.");
        expect(reviewed.blockers.join("\n")).toContain(
          `a judgment: Provider ${claudeInstanceId} cannot run a child task`,
        );
      }).pipe(Effect.provide(layerRefusedTargets)),
    );

    const judgedScript = `return await agent("do the work", { label: "work", verify: { type: "judgment", rubric: ["It is done."], target: args }, report: true })`;

    it.effect("fails the worker's check in a script and starts no checker on another model", () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) => (isChecker(prompt) ? verdict(true, "ok") : "done"));
        const started = yield* startWorkflow(judgedScript, judge);
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toMatchObject({
          ok: false,
          attempts: 1,
          verification: { type: "judgment", outcome: "error", attempts: 1 },
        });
        // Only the worker ran: the checker never started, on its provider or any other.
        const members = yield* expectSettled(started.workflowId);
        expect(members.map((task) => task.providerInstanceId)).toEqual([instanceId]);
        const report = yield* reportOf(started.workflowId);
        expect(report.agents.map((agent) => [agent.role, agent.outcome])).toEqual([
          ["worker", "check_failed"],
          ["checker", "never_started"],
        ]);
      }).pipe(Effect.provide(layerRefusedTargets)),
    );

    it.effect("names why the checker could not start in the worker's failed check", () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents(() => "done");
        const started = yield* startWorkflow(judgedScript, judge);
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!).verification.detail).toContain(
          `Provider ${claudeInstanceId} cannot run a child task`,
        );
      }).pipe(Effect.provide(layerRefusedTargets)),
    );
  });
});

describe("11. coordinator-written retries", () => {
  const codex = (effort: string) => ({
    providerInstanceId: instanceId,
    model,
    options: { reasoningEffort: effort },
  });
  const claude = { providerInstanceId: claudeInstanceId, model: claudeModel };
  const onClaude = (task: OrchestrationV2Subagent) => task.providerInstanceId === claudeInstanceId;
  const attemptTargets = (report: OrchestratorMcpWorkflowReport) =>
    report.agents.map((agent) =>
      (agent.attemptCosts ?? []).map((attempt) => [
        attempt.provider,
        attempt.model,
        attempt.effort,
      ]),
    );
  const checkedScript = `return await agent("build the parser", { label: "build", target: args.first, retries: args.retries, schema: { type: "object", required: ["ok"] }, verify: { type: "structured", equals: { "/ok": true } }, report: true })`;

  it.effect("a failed check moves the work along its retries, and the report shows each step", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((_prompt, task) => json({ ok: onClaude(task) }), 100);
      const started = yield* startWorkflow(checkedScript, {
        first: codex("low"),
        retries: [codex("high"), claude],
      });
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({ ok: true, attempts: 3 });
      const members = yield* expectSettled(started.workflowId);
      expect(members.map((task) => task.providerInstanceId)).toEqual([
        instanceId,
        instanceId,
        claudeInstanceId,
      ]);
      // Each move along the list keeps what the failed check saw.
      expect(members.slice(1).every((task) => task.prompt.includes("did not pass its"))).toBe(true);
      const report = yield* reportOf(started.workflowId);
      expect(attemptTargets(report)).toEqual([
        [
          [instanceId, model, "low"],
          [instanceId, model, "high"],
          [claudeInstanceId, claudeModel, null],
        ],
      ]);
      expect(
        report.summary.map((group) => [group.agents, group.retries, group.escalations]),
      ).toEqual([[1, 2, 2]]);
      const text = formatWorkflowReport(report);
      expect(text).toContain(
        `${instanceId}/${model} > ${instanceId}/${model} > ${claudeInstanceId}/${claudeModel}`,
      );
      expect(text).toContain("low > high > -");
      // The groups table prints the count under its own column.
      const lines = text.split("\n");
      const header = lines.findIndex((line) => line.includes("escalations"));
      const column = lines[header]!.indexOf("escalations");
      expect(lines[header + 1]!.slice(column).split(/\s+/u)[0]).toBe("2");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a provider fault repeats its attempt's target and moves nowhere along the list", () =>
    Effect.gen(function* () {
      yield* startParent;
      let answered = 0;
      yield* answerWorkflowAgents((): WorkerReply => {
        answered += 1;
        if (answered === 2) return { text: "", status: "failed", tokens: 100 };
        return { text: json({ ok: answered === 3 }), tokens: 100 };
      });
      const started = yield* startWorkflow(checkedScript, {
        first: codex("low"),
        retries: [codex("high"), claude],
      });
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({ ok: true, attempts: 3 });
      const report = yield* reportOf(started.workflowId);
      expect(attemptTargets(report)).toEqual([
        [
          [instanceId, model, "low"],
          [instanceId, model, "high"],
          [instanceId, model, "high"],
        ],
      ]);
      expect(report.summary[0]?.escalations).toBe(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("an attempt past its deadline moves to the next target", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("slow work", { label: "slow", target: args.first, retries: args.retries, attemptTimeoutMs: 60000, report: true })',
        { first: codex("low"), retries: [claude] },
      );
      yield* awaitMember(started.workflowId, 1);
      yield* adjustBySweeps(4);
      const retry = yield* awaitMember(started.workflowId, 2);
      expect(retry.providerInstanceId).toBe(claudeInstanceId);
      expect(retry.prompt).toContain("passed its time budget of 60000 ms");
      yield* completeChild(retry.childThreadId!, "finished in time");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({ ok: true, attempts: 2 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a script's judgment check on the caller's model it inherits takes a same-family retry",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        yield* answerWorkflowAgents((prompt) => (isChecker(prompt) ? verdict(true, "ok") : "done"));
        // No target: the worker and its check run on the caller's model, in the family of the retry.
        const started = yield* startWorkflow(
          `return await agent("do the work", { label: "work", retries: args, verify: { type: "judgment", rubric: ["It is done."] }, report: true })`,
          [codex("high")],
        );
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toMatchObject({ ok: true, attempts: 1 });
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      name: "a model its provider does not list",
      bad: { providerInstanceId: instanceId, model: "unknown-model" },
      reason: `retries[1]: Model unknown-model is not advertised by provider ${instanceId}.`,
    },
    {
      name: "an option given twice",
      bad: {
        ...codex("high"),
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "reasoningEffort", value: "low" },
        ],
      },
      reason: `retries[1]: Model ${model} on provider ${instanceId} rejected options: Option reasoningEffort was specified more than once.`,
    },
  ])("a script's retry target with $name is refused before any attempt", ({ bad, reason }) =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents(() => json({ ok: false }));
      const started = yield* startWorkflow(checkedScript, {
        first: codex("low"),
        retries: [codex("high"), bad],
      });
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({ ok: false, attempts: 0 });
      expect(JSON.parse(ended.result!).reason).toContain(reason);
      expect(yield* membersOf(started.workflowId)).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  const node = (fields: Record<string, unknown>) => ({
    subject: "build",
    description: "build the parser",
    dependsOn: [],
    target: codex("low"),
    ...fields,
  });
  const graphOf = (fields: Record<string, unknown>) => ({
    schemaVersion: 1,
    nodes: { a: node(fields) },
  });
  const judged = (target?: unknown) => ({
    type: "judgment",
    rubric: ["It is right."],
    ...(target === undefined ? {} : { target }),
  });

  it.effect("graph review resolves every retry target into the digest it approves", () =>
    Effect.gen(function* () {
      yield* startParent;
      const plain = yield* reviewGraph(graphOf({}));
      const reviewed = yield* reviewGraph(graphOf({ retries: [codex("high")] }));
      expect(reviewed.ready).toBe(true);
      expect(reviewed.next).toContain("call graph_start now");
      const concrete = {
        providerInstanceId: instanceId,
        model,
        options: [{ id: "reasoningEffort", value: "high" }],
        inheritOptions: false,
      };
      expect(reviewed.targets[0]?.retries).toEqual([concrete]);
      expect(
        (reviewed.expandedGraph as { nodes: Record<string, { retries?: unknown }> }).nodes.a
          ?.retries,
      ).toEqual([concrete]);
      // The digest covers the list, so a graph that walks it is not the one without it.
      expect(reviewed.digest).not.toBe(plain.digest);
      expect((yield* reviewGraph(reviewed.expandedGraph)).digest).toBe(reviewed.digest);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a started graph walks the retry targets it was reviewed with", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((_prompt, task) => json({ ok: onClaude(task) }), 100);
      const reviewed = yield* reviewGraph(
        graphOf({
          retries: [claude],
          schema: { type: "object", required: ["ok"] },
          verify: { type: "structured", equals: { "/ok": true } },
        }),
      );
      const started = yield* decodeWorkflow(
        (yield* invoke("graph_start", {
          graph: reviewed.expandedGraph,
          acceptedDigest: reviewed.digest,
        })).structuredContent,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("completed");
      const members = yield* expectSettled(started.workflowId);
      expect(members.map((task) => task.providerInstanceId)).toEqual([
        instanceId,
        claudeInstanceId,
      ]);
      expect(ended.nodes?.a).toMatchObject({ status: "passed", attempts: 2 });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      name: "a retry target that does not resolve",
      fields: { retries: [{ providerInstanceId: instanceId, model: "unknown-model" }] },
      blocker: `a retries[0]: Model unknown-model is not advertised by provider ${instanceId}.`,
    },
    {
      name: "a retries field that is not a list",
      fields: { retries: "escalate" },
      blocker: "a: retries must be an array of targets.",
    },
    {
      name: "retries that leave the worker's family under an inherited judgment check",
      fields: { retries: [claude], verify: judged() },
      blocker: `a judgment: retries runs ${claudeModel} outside the model family of the first target (${model}), so the judgment check needs a target of its own.`,
    },
  ])("graph review blocks $name", ({ fields, blocker }) =>
    Effect.gen(function* () {
      yield* startParent;
      const reviewed = yield* reviewGraph(graphOf(fields));
      expect(reviewed.digest).toBeNull();
      expect(reviewed.ready).toBe(false);
      expect(reviewed.blockers).toContain(blocker);
      expect(reviewed.next).toContain("Fix the blockers");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "a check with its own target allows retries across families, and notes any in its family",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const reviewed = yield* reviewGraph(graphOf({ retries: [claude], verify: judged(claude) }));
        expect(reviewed.blockers).toEqual([]);
        expect(reviewed.ready).toBe(true);
        expect(reviewed.advisory?.assignmentNotes).toEqual([
          "a retries[0]: same model family as its judgment check (claude) while another family is enabled.",
        ]);
      }).pipe(Effect.provide(layerTest)),
  );
});

/** A small seeded generator (mulberry32), so each seed replays the same outcomes. */
const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const BUDGET = 2_500;
const CAP = 4;
// Two work attempts, plus two same-target retries after provider failures.
const MAX_ATTEMPTS = 4;
const redoUntilPass = `for (let round = 0; round < ${CAP}; round++) {
  let report;
  try {
    report = await agent("task round " + round, { label: "round " + round, schema: { type: "object", required: ["ok"] }, verify: { type: "structured", equals: { "/ok": true } }, report: true });
  } catch (error) {
    return { stopped: round };
  }
  if (report.ok) return { passed: round };
}
return { passed: null };`;

describe("redo until pass, with seeded outcomes", () => {
  it.effect.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %s keeps the runner's invariants", (seed) =>
    Effect.gen(function* () {
      yield* startParent;
      const next = seeded(seed);
      const spent: Array<number> = [];
      yield* answerWorkflowAgents((): WorkerReply => {
        const roll = next();
        const tokens = 100 + Math.floor(next() * 500);
        spent.push(tokens);
        if (roll < 0.25) return { text: "", status: "failed", tokens };
        return { text: json({ ok: roll >= 0.7 }), tokens };
      });
      const started = yield* decodeWorkflow(
        (yield* invoke("workflow_start", {
          script: redoUntilPass,
          budgetTokens: BUDGET,
        })).structuredContent,
      );
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(ended.status).toBe("completed");
      const members = yield* expectSettled(started.workflowId);
      const report = yield* reportOf(started.workflowId);
      const total = spent.reduce((sum, tokens) => sum + tokens, 0);
      // Every started attempt is one child task, and each began while spend was under budget.
      expect(members).toHaveLength(spent.length);
      expect(total - spent.at(-1)!).toBeLessThan(BUDGET);
      expect(report.agents.length).toBeLessThanOrEqual(CAP);
      expect(report.agents.every((agent) => agent.attempts <= MAX_ATTEMPTS)).toBe(true);
      // The record's totals are the sums of its agents.
      expect(report.loop.attempts).toBe(
        report.agents.reduce((sum, agent) => sum + agent.attempts, 0),
      );
      expect(report.loop.attempts).toBe(spent.length);
      expect(report.loop.totalTokens).toBe(total);
      expect(report.agents.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0)).toBe(total);
      // A script that caught the budget's refusal still ended by the budget.
      expect(report.loop.endedBy).toBe(
        JSON.parse(ended.result!).stopped === undefined ? "settled" : "budget",
      );
    }).pipe(Effect.provide(layerTest)),
  );
});

describe("a worker settles on its work, not its turn", () => {
  /** Settles the member's task now, as the orchestrator would after its turn ended. */
  const taskAfterTurn = (member: OrchestrationV2Subagent) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const run = (yield* orchestrator.getThreadProjection(member.childThreadId!)).runs.at(-1)!;
      yield* orchestrator.recoverDelegatedTask(member.childThreadId!, run.id);
      return (yield* membersOf(member.parentNodeId)).find((task) => task.id === member.id)!;
    });

  const runsOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return (yield* orchestrator.getThreadProjection(threadId)).runs;
    });

  const command = { taskId: "tests", kind: "command" as const, description: "vp test" };

  it.effect("a turn that ends with its tests still running waits for them, then passes", () =>
    withScratchDir((dir) =>
      Effect.gen(function* () {
        yield* startParent;
        const out = `${dir}/part.json`;
        const started = yield* startWorkflow(
          `return await agent("run the shard", { label: "shard", verify: { type: "process", argv: ["node", "-e", "require('fs').accessSync(process.argv[1])", ${JSON.stringify(out)}] }, report: true })`,
        );
        const member = yield* awaitMember(started.workflowId, 1);
        yield* setBackgroundWork(member.childThreadId!, [command]);
        yield* completeChild(member.childThreadId!, "The tests run in the background.");
        // The turn ended, but its command still runs: the attempt is not over.
        expect((yield* taskAfterTurn(member)).result).toBeNull();
        NodeFS.writeFileSync(out, "{}");
        yield* setBackgroundWork(member.childThreadId!, []);
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toMatchObject({
          ok: true,
          attempts: 1,
          verification: { type: "process", outcome: "passed", attempts: 1 },
        });
        expect(yield* expectSettled(started.workflowId)).toHaveLength(1);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  /** Whether the runner asked the child to stop: Stop records its request on the stopped run. */
  const stopRequested = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const child = yield* orchestrator.getThreadProjection(threadId);
      return child.turnItems.some((item) => item.type === "run_interrupt_request");
    });

  it.effect(
    "a command past the deadline fails the attempt, is stopped, then the retry starts",
    () =>
      Effect.gen(function* () {
        yield* startParent;
        const started = yield* startWorkflow(
          'return await agent("run the shard", { label: "shard", attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
        );
        const first = yield* awaitMember(started.workflowId, 1);
        yield* setBackgroundWork(first.childThreadId!, [command]);
        yield* completeChild(first.childThreadId!, "The tests run in the background.");
        expect((yield* taskAfterTurn(first)).result).toBeNull();
        yield* adjustBySweeps(4);
        // Past the deadline the runner stops the attempt, and starts nothing while its command runs.
        expect(yield* stopRequested(first.childThreadId!)).toBe(true);
        expect(yield* membersOf(started.workflowId)).toHaveLength(1);
        // The provider ends the command the stop reached; only then does the retry start.
        yield* setBackgroundWork(first.childThreadId!, []);
        const retry = yield* awaitMember(started.workflowId, 2);
        yield* completeChild(retry.childThreadId!, "finished in time");
        const ended = yield* awaitWorkflowEnd(started.workflowId);
        expect(JSON.parse(ended.result!)).toMatchObject({
          ok: true,
          result: "finished in time",
          attempts: 2,
        });
        const row = yield* rowOf(started.workflowId);
        expect(row.workflow?.agents[0]?.attemptHistory?.map((entry) => entry.stoppedBy)).toEqual([
          "timed_out",
          undefined,
        ]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a command its stop cannot end fails the agent without starting another", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("run the shard", { label: "shard", attemptTimeoutMs: 60000, stallTimeoutMs: 3600000, report: true })',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      yield* setBackgroundWork(first.childThreadId!, [command]);
      yield* completeChild(first.childThreadId!, "The tests run in the background.");
      // The deadline's stop, then the grace a stop gets, pass with the command still running.
      yield* adjustBySweeps(8);
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      const report = JSON.parse(ended.result!);
      expect(report).toMatchObject({ ok: false, attempts: 1 });
      expect(report.reason).toContain("did not stop");
      expect(yield* membersOf(started.workflowId)).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a member whose command a restart cut is started again on the same rung", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        'return await agent("run the shard", { label: "shard", report: true })',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      // What restart recovery leaves on a turn that ended while its tests ran: the lost command.
      yield* completeChild(first.childThreadId!, "The tests run in the background.", {
        status: "completed",
        restartCancelledBackgroundWork: [{ kind: "shell", label: "vp test", awaited: true }],
      });
      const retry = yield* awaitMember(started.workflowId, 2);
      // A restart is no judgment on the work: the retry gets no repair feedback.
      expect(retry.prompt).not.toContain("did not pass its");
      yield* completeChild(retry.childThreadId!, "Every test ran.");
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({ ok: true, result: "Every test ran." });
      const row = yield* rowOf(started.workflowId);
      expect(row.workflow?.agents[0]?.attemptHistory?.map((entry) => entry.state)).toEqual([
        "interrupted",
        "completed",
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a retry starts only after the attempt it replaces has stopped", () =>
    Effect.gen(function* () {
      yield* startParent;
      const started = yield* startWorkflow(
        `return await agent("write the summary", { label: "summary", verify: { type: "judgment", rubric: ["The summary is complete."], target: args.judge }, report: true })`,
        { judge: { providerInstanceId: claudeInstanceId, model: claudeModel } },
      );
      const first = yield* awaitMember(started.workflowId, 1);
      yield* completeChild(first.childThreadId!, "a short summary");
      const [checker] = yield* awaitCheckers(started.workflowId, 1);
      // A command the first attempt left woke it while its result was being judged.
      yield* wakeChild(first.childThreadId!, "late-shard");
      const woken = yield* runsOf(first.childThreadId!);
      expect(woken).toHaveLength(2);
      yield* completeChild(checker!.childThreadId!, verdict(false, "Section 2 is missing."));
      const retry = yield* awaitMember(started.workflowId, 3);
      expect(retry.prompt).toContain("write the summary");
      // By the time the retry started, every run of the attempt it replaced had ended.
      const runs = yield* runsOf(first.childThreadId!);
      expect(
        runs.filter((run) => run.completedAt === null && run.status !== "interrupted"),
      ).toEqual([]);
      expect(runs.at(-1)?.status).toBe("interrupted");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a replaced attempt's late wake starts no run and wakes no caller", () =>
    Effect.gen(function* () {
      yield* startParent;
      yield* answerWorkflowAgents((prompt) => json({ ok: prompt.includes("did not pass its") }));
      const started = yield* startWorkflow(
        'return await agent("build the parser", { label: "build", schema: { type: "object", required: ["ok"] }, verify: { type: "structured", equals: { "/ok": true } }, report: true })',
      );
      const first = yield* awaitMember(started.workflowId, 1);
      yield* awaitMember(started.workflowId, 2);
      const before = yield* runsOf(first.childThreadId!);
      yield* wakeChild(first.childThreadId!, "late-build");
      // The replaced attempt starts nothing that could rewrite the node's files.
      expect(yield* runsOf(first.childThreadId!)).toHaveLength(before.length);
      const ended = yield* awaitWorkflowEnd(started.workflowId);
      expect(JSON.parse(ended.result!)).toMatchObject({ ok: true, attempts: 2 });
      // Nothing outside the workflow came from the old attempt's thread to wake the caller.
      expect(
        (yield* childTasks).filter(
          (task) =>
            task.childThreadId === first.childThreadId && task.parentNodeId !== started.workflowId,
        ),
      ).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );
});

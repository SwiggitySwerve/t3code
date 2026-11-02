import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  OrchestrationV2SubagentWorkflow,
  type OrchestrationV2Subagent,
  type OrchestratorMcpWorkflowAgent,
  type OrchestratorMcpWorkflowResult,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { formatWorkflowReport, workflowReport } from "./workflowReport.ts";

const decodeWorkflow = Schema.decodeUnknownSync(OrchestrationV2SubagentWorkflow);
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const attempt = (index: number, durationMs: number, state: "completed" | "failed") => ({
  taskId: NodeId.make(`task:${index}`),
  childThreadId: ThreadId.make(`thread:child-${index}`),
  attempt: index,
  state,
  providerInstanceId: codex,
  usageStatus: "complete" as const,
  durationMs,
  timingComplete: true,
});

/**
 * A script run as stored: a worker retried after its checker failed it, and a researcher whose
 * declared process check never ran because its provider failed.
 */
const stored = {
  budget: { limit: 20_000, exhausted: false },
  phases: [
    { index: 0, title: "Write" },
    { index: 1, title: "Research" },
  ],
  agents: [
    {
      index: 0,
      label: "draft",
      state: "completed",
      phaseIndex: 0,
      phaseTitle: "Write",
      agentId: "task:1",
      attempt: 1,
      attemptHistory: [attempt(0, 1_500, "completed"), attempt(1, 2_500, "completed")],
      providerInstanceId: codex,
      driver: "codex",
      model: "gpt-5.4",
      options: { reasoningEffort: "high" },
      effort: "high",
      targetSource: "target",
      verification: { type: "judgment", outcome: "passed", attempts: 2 },
    },
    ...[0, 1].map((round) => ({
      index: 1 + round,
      label: "check draft",
      state: "completed",
      phaseIndex: 0,
      phaseTitle: "Write",
      agentId: `task:check-${round}`,
      judgmentFor: { agentIndex: 0, attempt: round },
      judgmentOutcome: round === 0 ? "failed" : "passed",
      providerInstanceId: claude,
      model: "claude-sonnet-4-6",
      options: { effort: "max" },
      effort: "max",
      targetSource: "target",
    })),
    {
      index: 3,
      label: "research",
      state: "failed",
      phaseIndex: 1,
      phaseTitle: "Research",
      agentId: "task:research-2",
      attempt: 2,
      providerInstanceId: claude,
      model: "claude-sonnet-4-6",
      targetSource: "caller",
      declaredCheck: "process",
      outcomeCategory: "provider_error",
    },
  ],
};

const usage = (input: number, output: number) => ({
  status: "complete" as const,
  inputTokens: input,
  cachedInputTokens: input / 2,
  cacheCreationTokens: 0,
  uncachedInputTokens: input / 2,
  outputTokens: output,
  totalTokens: input + output,
});
const read = (
  index: number,
  status: OrchestratorMcpWorkflowAgent["status"],
  agentUsage: OrchestratorMcpWorkflowAgent["usage"],
): OrchestratorMcpWorkflowAgent => ({
  usage: agentUsage,
  outcomeCategory: status === "completed" ? "completed" : "provider_error",
  timings: {
    createdAt: null,
    runStartedAt: null,
    providerTurnStartedAt: null,
    providerTurnEndedAt: null,
    completedAt: null,
    runnerSettledAt: null,
  },
  index,
  label: stored.agents[index]!.label,
  phase: stored.agents[index]!.phaseTitle,
  status,
  taskId: null,
  childThreadId: null,
  model: stored.agents[index]!.model,
  result: null,
  verification: null,
});
const result: OrchestratorMcpWorkflowResult = {
  workflowId: NodeId.make("workflow:fixture"),
  status: "failed",
  name: "Fixture",
  phases: ["Write", "Research"],
  agents: [
    read(0, "completed", usage(4_000, 1_000)),
    read(1, "completed", usage(1_000, 200)),
    read(2, "completed", usage(1_200, 300)),
    read(3, "failed", {
      status: "unavailable",
      inputTokens: null,
      cachedInputTokens: null,
      cacheCreationTokens: null,
      uncachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
    }),
  ],
  progress: null,
  usage: usage(6_200, 1_500),
  tokensUsed: 7_700,
  budgetTokens: 20_000,
  result: "research failed",
};
const row = (workflow: OrchestrationV2Subagent["workflow"]) =>
  ({ workflow, driver: ProviderDriverKind.make("codex") }) as OrchestrationV2Subagent;

describe("workflow report", () => {
  it("decodes rows stored before options, target source and plan features were recorded", () => {
    const old = decodeWorkflow({
      phases: [{ index: 0, title: "Layer 1" }],
      agents: [{ index: 0, label: "old", state: "completed", model: "gpt-5.4", effort: "low" }],
      plan: { nodes: [{ key: "a", label: "A", wave: 0, dependsOn: [] }] },
    });
    const report = workflowReport(row(old), { ...result, agents: [] });
    expect(report.kind).toBe("graph");
    expect(report.agents[0]).toMatchObject({
      label: "old",
      effort: "low",
      targetSource: null,
      check: "none",
      attempts: 0,
    });
  });

  it("joins the record with the read usage, one row per agent and groups by family and check", () => {
    const report = workflowReport(row(decodeWorkflow(stored)), result);
    expect(
      report.agents.map((agent) => [
        agent.label,
        agent.attempts,
        agent.durationMs,
        agent.childThreadId,
      ]),
    ).toEqual([
      ["draft", 2, 4_000, "thread:child-1"],
      ["check draft", 1, null, null],
      ["check draft", 1, null, null],
      ["research", 3, null, null],
    ]);
    expect(report.agents[0]).toMatchObject({
      role: "worker",
      provider: "codex",
      model: "gpt-5.4",
      effort: "high",
      targetSource: "target",
      inputTokens: 4_000,
      cachedInputTokens: 2_000,
      outputTokens: 1_000,
      check: "judgment",
      checkOutcome: "passed",
    });
    expect(report.agents[1]).toMatchObject({
      role: "checker",
      check: "none",
      checkOutcome: "failed",
    });
    // A declared check that never ran is not the same as no check.
    expect(report.agents[3]).toMatchObject({ check: "process", checkOutcome: "not_run" });
    expect(report.summary).toEqual([
      {
        role: "checker",
        family: "claude",
        check: "none",
        agents: 2,
        passed: 2,
        firstTryPassRate: 1,
        retries: 0,
        medianTokensPerPassed: 1_350,
      },
      {
        role: "worker",
        family: "claude",
        check: "process",
        agents: 1,
        passed: 0,
        firstTryPassRate: 0,
        retries: 2,
        medianTokensPerPassed: null,
      },
      {
        role: "worker",
        family: "gpt",
        check: "judgment",
        agents: 1,
        passed: 1,
        firstTryPassRate: 0,
        retries: 1,
        medianTokensPerPassed: 5_000,
      },
    ]);
    expect(report.loop).toEqual({
      phases: 2,
      agents: 4,
      attempts: 7,
      settledAgents: 4,
      totalTokens: 7_700,
      budgetTokens: 20_000,
      endedBy: "settled",
    });
    // The CLI's --json prints this object as is, so a run can be aggregated with others.
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  it("prints the same report as text", () => {
    expect(formatWorkflowReport(workflowReport(row(decodeWorkflow(stored)), result))).toBe(
      [
        "Fixture (workflow:fixture): script, failed",
        "#  label        phase     role     provider/model            effort  source  in/cached/out   time  tries  outcome         check",
        "0  draft        Write     worker   codex/gpt-5.4             high    target  4000/2000/1000  4.0s  2      completed       judgment:passed",
        "1  check draft  Write     checker  claude/claude-sonnet-4-6  max     target  1000/500/200    -     1      completed       verdict:failed",
        "2  check draft  Write     checker  claude/claude-sonnet-4-6  max     target  1200/600/300    -     1      completed       verdict:passed",
        "3  research     Research  worker   claude/claude-sonnet-4-6  -       caller  -/-/-           -     3      provider_error  process:not_run",
        "",
        "role     family  check     agents  first-try pass  retries  median tokens/passed",
        "checker  claude  none      2       100%            0        1350",
        "worker   claude  process   1       0%              2        -",
        "worker   gpt     judgment  1       0%              1        5000",
        "",
        "phases 2, agents 4 (4 settled), attempts 7, tokens 7700 of 20000, ended by settled",
      ].join("\n"),
    );
  });

  it("says a workflow stopped at its budget", () => {
    const report = workflowReport(
      row(decodeWorkflow({ ...stored, budget: { limit: 20_000, exhausted: true } })),
      result,
    );
    expect(report.loop.endedBy).toBe("budget");
  });
});

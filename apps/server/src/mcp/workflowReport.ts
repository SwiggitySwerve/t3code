/**
 * A workflow's trace as one row per agent plus summaries, for comparing how coordinators assign
 * work across runs. The durable record says who ran each agent and how it ended; usage and
 * outcomes come from `workflowResult`, which owns the joins with the child threads.
 */
import type {
  OrchestrationV2Subagent,
  OrchestratorMcpWorkflowReport,
  OrchestratorMcpWorkflowReportAgent,
  OrchestratorMcpWorkflowReportGroup,
  OrchestratorMcpWorkflowResult,
} from "@t3tools/contracts";

import { modelFamily } from "./workflowAdvisory.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** `result` must be `workflowResult` of the same row. */
export function workflowReport(
  row: OrchestrationV2Subagent,
  result: OrchestratorMcpWorkflowResult,
): OrchestratorMcpWorkflowReport {
  const record = row.workflow;
  const joined = new Map(result.agents.map((agent) => [agent.index, agent]));
  const plan = new Map((record?.plan?.nodes ?? []).map((node) => [node.key, node]));
  const agents = (record?.agents ?? []).map((agent): OrchestratorMcpWorkflowReportAgent => {
    const read = joined.get(agent.index);
    const history = agent.attemptHistory ?? [];
    const started = agent.agentId !== undefined || history.length > 0;
    const durations = history.flatMap((attempt) =>
      attempt.durationMs === undefined ? [] : [attempt.durationMs],
    );
    const checker = agent.judgmentFor !== undefined;
    const declared =
      agent.graphNodeKey === undefined ? undefined : plan.get(agent.graphNodeKey)?.features?.check;
    return {
      index: agent.index,
      label: agent.label,
      phase: agent.phaseTitle ?? null,
      role: checker ? "checker" : "worker",
      node: agent.graphNodeKey ?? agent.judgmentFor?.graphNodeKey ?? null,
      provider: agent.providerInstanceId ?? agent.plannedIdentity?.providerInstanceId ?? null,
      model: agent.model ?? read?.model ?? agent.plannedIdentity?.model ?? null,
      effort: agent.effort ?? null,
      targetSource: agent.targetSource ?? null,
      usageStatus: read?.usage.status ?? "unavailable",
      inputTokens: read?.usage.inputTokens ?? null,
      cachedInputTokens: read?.usage.cachedInputTokens ?? null,
      outputTokens: read?.usage.outputTokens ?? null,
      totalTokens: read?.usage.totalTokens ?? null,
      durationMs: durations.length === 0 ? null : durations.reduce((sum, ms) => sum + ms, 0),
      attempts: Math.max(history.length, started ? (agent.attempt ?? 0) + 1 : 0),
      status: read?.status ?? agent.state,
      outcome: read?.outcomeCategory ?? agent.outcomeCategory ?? null,
      check: checker ? "none" : (agent.verification?.type ?? declared ?? "none"),
      checkOutcome: checker
        ? (agent.judgmentOutcome ?? null)
        : (agent.verification?.outcome ?? null),
    };
  });
  const groups = new Map<string, Array<OrchestratorMcpWorkflowReportAgent>>();
  for (const agent of agents) {
    const family = agent.model === null ? "unknown" : modelFamily(agent.model);
    const key = JSON.stringify([agent.role, family, agent.check]);
    groups.set(key, [...(groups.get(key) ?? []), agent]);
  }
  const summary = [...groups]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, members]): OrchestratorMcpWorkflowReportGroup => {
      const [role, family, check] = JSON.parse(key) as [
        OrchestratorMcpWorkflowReportGroup["role"],
        string,
        OrchestratorMcpWorkflowReportGroup["check"],
      ];
      const passed = members.filter((agent) => agent.status === "completed");
      return {
        role,
        family,
        check,
        agents: members.length,
        passed: passed.length,
        firstTryPassRate:
          passed.filter((agent) => agent.attempts === 1).length / Math.max(1, members.length),
        redos: members.reduce((sum, agent) => sum + Math.max(0, agent.attempts - 1), 0),
        medianTokensPerPassed: median(
          passed.flatMap((agent) => (agent.totalTokens === null ? [] : [agent.totalTokens])),
        ),
      };
    });
  return {
    workflowId: result.workflowId,
    name: result.name,
    kind: record?.plan === undefined ? "script" : "graph",
    status: result.status,
    agents,
    summary,
    loop: {
      phases: record?.phases.length ?? 0,
      agents: agents.length,
      attempts: agents.reduce((sum, agent) => sum + agent.attempts, 0),
      settledAgents: agents.filter((agent) => TERMINAL.has(agent.status)).length,
      totalTokens: result.usage.totalTokens,
      budgetTokens: result.budgetTokens,
      endedBy:
        result.status === "running" ? "running" : record?.budget?.exhausted ? "budget" : "settled",
    },
  };
}

const count = (value: number | null) => (value === null ? "-" : String(Math.round(value)));

function duration(ms: number | null): string {
  if (ms === null) return "-";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function table(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((cells) => cells[column]!.length)),
  );
  return rows
    .map((cells) =>
      cells
        .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** The report as plain text: one table of agents, one of groups, then the loop line. */
export function formatWorkflowReport(report: OrchestratorMcpWorkflowReport): string {
  const agents = table([
    [
      "#",
      "label",
      "phase",
      "role",
      "provider/model",
      "effort",
      "source",
      "in/cached/out",
      "time",
      "tries",
      "outcome",
      "check",
    ],
    ...report.agents.map((agent) => [
      String(agent.index),
      agent.label,
      agent.phase ?? "-",
      agent.role,
      `${agent.provider ?? "-"}/${agent.model ?? "-"}`,
      agent.effort ?? "-",
      agent.targetSource ?? "-",
      `${count(agent.inputTokens)}/${count(agent.cachedInputTokens)}/${count(agent.outputTokens)}`,
      duration(agent.durationMs),
      String(agent.attempts),
      agent.outcome ?? agent.status,
      agent.role === "checker"
        ? `verdict:${agent.checkOutcome ?? "-"}`
        : agent.check === "none" && agent.checkOutcome === null
          ? "-"
          : `${agent.check}:${agent.checkOutcome ?? "-"}`,
    ]),
  ]);
  const groups = table([
    ["role", "family", "check", "agents", "first-try pass", "redos", "median tokens/passed"],
    ...report.summary.map((group) => [
      group.role,
      group.family,
      group.check,
      String(group.agents),
      `${Math.round(group.firstTryPassRate * 100)}%`,
      String(group.redos),
      count(group.medianTokensPerPassed),
    ]),
  ]);
  const { loop } = report;
  return [
    `${report.name ?? "Workflow"} (${report.workflowId}): ${report.kind}, ${report.status}`,
    agents,
    "",
    groups,
    "",
    `phases ${loop.phases}, agents ${loop.agents} (${loop.settledAgents} settled), attempts ${loop.attempts}, tokens ${count(loop.totalTokens)}${loop.budgetTokens === null ? "" : ` of ${loop.budgetTokens}`}, ended by ${loop.endedBy}`,
  ].join("\n");
}

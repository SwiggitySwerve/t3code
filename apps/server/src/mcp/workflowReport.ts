/**
 * A workflow's trace as one row per agent plus summaries, for comparing how coordinators assign
 * work across runs. The durable record says who ran each agent and how it ended; usage and
 * outcomes come from `workflowResult`, which owns the joins with the child threads.
 */
import type {
  OrchestrationV2Subagent,
  OrchestratorMcpWorkflowReport,
  OrchestratorMcpWorkflowReportAgent,
  OrchestratorMcpWorkflowReportAttempt,
  OrchestratorMcpWorkflowReportGroup,
  OrchestratorMcpWorkflowResult,
  OrchestratorMcpWorkflowUsage,
  WorkflowReportCostSource,
} from "@t3tools/contracts";

import type { UsageSpeed } from "@t3tools/provider-core/server/usage";

import { codexSpeed } from "../provider/Drivers/codexUsage.ts";
import { lookupRate, priceUsage, type RateTable } from "../usage/usagePricing.ts";
import { modelFamily } from "./workflowAdvisory.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

function median(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

interface Cost {
  readonly costUsd: number | null;
  readonly costSource: WorkflowReportCostSource;
}

/** The service tier an attempt's options bill at: T3's `serviceTier` and `fastMode` option ids. */
function speedOf(options: Readonly<Record<string, string | boolean>> | undefined): UsageSpeed {
  const tier = codexSpeed(options?.serviceTier);
  return tier === "standard" && options?.fastMode === true ? "fast" : tier;
}

/** One attempt's usage at its own model's base list price; unknown stays null, never $0. */
export function attemptCost(
  rates: RateTable,
  attempt: {
    readonly model?: string | undefined;
    readonly options?: Readonly<Record<string, string | boolean>> | undefined;
  },
  usage: OrchestratorMcpWorkflowUsage | undefined,
): Cost {
  const { model } = attempt;
  if (rates.size === 0) return { costUsd: null, costSource: "noRates" };
  if (usage === undefined || usage.status === "unavailable") {
    return { costUsd: null, costSource: "noUsage" };
  }
  if (model === undefined || lookupRate(rates, model) === null) {
    return { costUsd: null, costSource: "unpriced" };
  }
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  const priced = priceUsage(rates, {
    model,
    totals: {
      // From the totals: a turn that reports no cache split is all uncached input.
      uncachedInputTokens: Math.max(
        0,
        (usage.inputTokens ?? 0) - cachedInputTokens - cacheCreationTokens,
      ),
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: usage.outputTokens ?? 0,
      reasoningTokens: 0,
    },
    speed: speedOf(attempt.options),
    reportedCostUsd: null,
  });
  return {
    costUsd: priced.costUsd,
    costSource: usage.status === "complete" ? "modelPriced" : "partialUsage",
  };
}

/** An agent's cost: null when any attempt's is unknown or unrecorded; a lower bound when partial. */
function agentCost(
  attempts: ReadonlyArray<OrchestratorMcpWorkflowReportAttempt>,
  attemptCount: number,
  rates: RateTable,
): Cost {
  if (attempts.length === 0 || attempts.length < attemptCount) {
    return { costUsd: null, costSource: rates.size === 0 ? "noRates" : "noUsage" };
  }
  const unknown = attempts.find((attempt) => attempt.costUsd === null);
  if (unknown !== undefined) return { costUsd: null, costSource: unknown.costSource };
  const partial = attempts.some((attempt) => attempt.costSource === "partialUsage");
  return {
    costUsd: attempts.reduce((sum, attempt) => sum + (attempt.costUsd ?? 0), 0),
    costSource: partial ? "partialUsage" : "modelPriced",
  };
}

export interface WorkflowReportPricing {
  /** Each attempt's own usage, by its task id. */
  readonly attemptUsage: ReadonlyMap<string, OrchestratorMcpWorkflowUsage>;
  /** The base rate table, never price overrides; empty when none could be read. */
  readonly rates: RateTable;
}

/** `result` must be `workflowResult` of the same row. */
export function workflowReport(
  row: OrchestrationV2Subagent,
  result: OrchestratorMcpWorkflowResult,
  pricing: WorkflowReportPricing,
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
    const planned =
      agent.graphNodeKey === undefined ? undefined : plan.get(agent.graphNodeKey)?.features?.check;
    const declared = agent.declaredCheck ?? planned;
    const ended = agent.state === "completed" || agent.state === "failed";
    const attemptCosts = history.map((attempt): OrchestratorMcpWorkflowReportAttempt => ({
      attempt: attempt.attempt,
      provider: attempt.providerInstanceId,
      model: attempt.model ?? null,
      effort: attempt.effort ?? null,
      options: attempt.options ?? null,
      state: attempt.state,
      totalTokens: attempt.totalTokens ?? null,
      ...attemptCost(pricing.rates, attempt, pricing.attemptUsage.get(attempt.taskId)),
    }));
    const attempts = Math.max(history.length, started ? (agent.attempt ?? 0) + 1 : 0);
    return {
      index: agent.index,
      label: agent.label,
      phase: agent.phaseTitle ?? null,
      role: checker ? "checker" : "worker",
      node: agent.graphNodeKey ?? agent.judgmentFor?.graphNodeKey ?? null,
      childThreadId: history.at(-1)?.childThreadId ?? agent.childThreadId ?? null,
      provider: agent.providerInstanceId ?? agent.plannedIdentity?.providerInstanceId ?? null,
      model: agent.model ?? read?.model ?? agent.plannedIdentity?.model ?? null,
      effort: agent.effort ?? null,
      targetSource: agent.targetSource ?? null,
      usageStatus: read?.usage.status ?? "unavailable",
      inputTokens: read?.usage.inputTokens ?? null,
      cachedInputTokens: read?.usage.cachedInputTokens ?? null,
      outputTokens: read?.usage.outputTokens ?? null,
      totalTokens: read?.usage.totalTokens ?? null,
      ...agentCost(attemptCosts, attempts, pricing.rates),
      attemptCosts,
      durationMs: durations.length === 0 ? null : durations.reduce((sum, ms) => sum + ms, 0),
      attempts,
      status: read?.status ?? agent.state,
      outcome: read?.outcomeCategory ?? agent.outcomeCategory ?? null,
      check: checker ? "none" : (agent.verification?.type ?? declared ?? "none"),
      checkOutcome: checker
        ? (agent.judgmentOutcome ?? null)
        : (agent.verification?.outcome ??
          (ended && declared !== undefined && declared !== "none" ? "not_run" : null)),
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
        retries: members.reduce((sum, agent) => sum + Math.max(0, agent.attempts - 1), 0),
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
const usd = (value: number | null | undefined) => (value == null ? "-" : `$${value.toFixed(4)}`);

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
      "cost",
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
      usd(agent.costUsd),
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
    ["role", "family", "check", "agents", "first-try pass", "retries", "median tokens/passed"],
    ...report.summary.map((group) => [
      group.role,
      group.family,
      group.check,
      String(group.agents),
      `${Math.round(group.firstTryPassRate * 100)}%`,
      String(group.retries),
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

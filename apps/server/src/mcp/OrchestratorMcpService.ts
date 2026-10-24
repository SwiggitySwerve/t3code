// @effect-diagnostics nodeBuiltinImport:off -- workflow inputs and outputs are hashed with node:crypto, as attachments are.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  EnvironmentId,
  type RunId,
  isProviderAvailable,
  MessageId,
  ModelSelection,
  NodeId,
  TurnItemId,
  WorkflowPresets,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2TurnItem,
  OrchestrationV2WorkflowPlan,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpModelOption,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTasksInput,
  type OrchestratorMcpDelegateTasksItem,
  type OrchestratorMcpDelegateTasksResult,
  type OrchestratorMcpDelegatedTaskStart,
  type OrchestratorMcpTaskWaitInput,
  type OrchestratorMcpGraphReviewInput,
  type OrchestratorMcpGraphReviewResult,
  type OrchestratorMcpGraphStartInput,
  type OrchestratorMcpWorkflowInput,
  type OrchestratorMcpWorkflowResult,
  type OrchestratorMcpWorkflowStartInput,
  type OrchestratorMcpWorkflowStopInput,
  type OrchestratorMcpTaskWaitResult,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  type ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  subagentResultForRun,
  delegatedTaskProgress,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { delegatedRunOutcome, runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientRuntimeModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  readStructuredResult,
  resultSchemaOf,
  withResultSchema,
} from "./delegatedTaskResultFormat.ts";
import { validateJsonSchema } from "./jsonSchemaValidation.ts";
import {
  makeWorkflowRunner,
  selectWorkflowTarget,
  workflowAgentOutcomeCategory,
} from "./workflowRunner.ts";
import {
  aggregateWorkflowUsage,
  workflowExecutionTiming,
  workflowTurnUsage,
} from "./workflowUsage.ts";
import { GRAPH_DRIVER_SCRIPT, graphPlan, parseGraph, reviewGraph } from "./workflowGraph.ts";
import type { CheckOutcome } from "./workflowChecks.ts";
import * as ProcessRunner from "../processRunner.ts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  parseStoredWorkflowScript,
  storedWorkflowScript,
} from "@t3tools/shared/storedWorkflowScript";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import { checkWorkflowScript } from "./workflowScript.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly delegateTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTasksInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTasksResult, OrchestratorMcpFailure>;
  readonly workflowStart: (
    scope: McpInvocationScope,
    input: OrchestratorMcpWorkflowStartInput,
  ) => Effect.Effect<OrchestratorMcpWorkflowResult, OrchestratorMcpFailure>;
  readonly workflowStatus: (
    scope: McpInvocationScope,
    input: OrchestratorMcpWorkflowInput,
  ) => Effect.Effect<OrchestratorMcpWorkflowResult, OrchestratorMcpFailure>;
  readonly workflowStop: (
    scope: McpInvocationScope,
    input: OrchestratorMcpWorkflowStopInput,
  ) => Effect.Effect<OrchestratorMcpWorkflowResult, OrchestratorMcpFailure>;
  /** Validates a graph and binds its input files; starts nothing and records nothing. */
  readonly graphReview: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGraphReviewInput,
  ) => Effect.Effect<OrchestratorMcpGraphReviewResult, OrchestratorMcpFailure>;
  /** Runs a reviewed graph as a workflow, refusing it if it or its inputs changed. */
  readonly graphStart: (
    scope: McpInvocationScope,
    input: OrchestratorMcpGraphStartInput,
  ) => Effect.Effect<OrchestratorMcpWorkflowResult, OrchestratorMcpFailure>;
  /** Restarts the scripts of workflows a server stop left running; returns how many. */
  readonly resumeWorkflows: Effect.Effect<number>;
  readonly taskWait: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskWaitInput,
  ) => Effect.Effect<OrchestratorMcpTaskWaitResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /**
   * The value never reaches the agent: the result is a status.
   */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);
const decodeWorkflowPlan = Schema.decodeUnknownOption(OrchestrationV2WorkflowPlan);
const decodeWorkflowCallerSelection = Schema.decodeUnknownOption(ModelSelection);
const decodeWorkflowTarget = Schema.decodeUnknownEffect(OrchestratorMcpTarget);
const WorkflowTargetSnapshot = Schema.Union([
  Schema.Struct({ target: OrchestratorMcpTarget }),
  Schema.Struct({ error: Schema.String }),
]);
const decodeWorkerTargetSnapshot = Schema.decodeUnknownOption(WorkflowTargetSnapshot);
const decodeWorkflowPresets = Schema.decodeUnknownOption(WorkflowPresets);
const decodePresetTargets = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, WorkflowTargetSnapshot),
);
const concreteWorkflowTarget = (selection: ModelSelection): OrchestratorMcpTarget => ({
  providerInstanceId: selection.instanceId,
  model: selection.model,
  // Explicit empty options prevent later inheritance; ordering does not change selection.
  options: [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
});

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

/**
 * A caller's thread is live while it is not archived, runs on the caller's
 * provider instance, and has an active run or a background subagent that
 * instance started. A background subagent outlives its run and calls tools
 * with its thread's credential, which is revoked when the provider process
 * goes away.
 */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

/**
 * Threads an agent starts over MCP are `mcp:<uuid>`, and agents often paste the
 * bare uuid. The id is never rewritten, so permission checks keyed on it still
 * hold; the miss only names a live thread the caller could read by its full id.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadShell">,
  threadId: ThreadId,
  message: string,
) {
  const prefixed = ThreadId.make(`mcp:${threadId}`);
  const shell = yield* threads.getThreadShell(prefixed).pipe(Effect.orElseSucceed(() => null));
  return yield* failure(
    "thread_not_found",
    shell === null || shell.deletedAt !== null
      ? message
      : `${message} Did you mean \`${prefixed}\`?`,
  );
});

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduledTaskWorkspaceStrategy(
  boundToThread: boolean,
): ScheduledTask["workspaceStrategy"] {
  return boundToThread
    ? { type: "root" }
    : { type: "worktree", baseRef: "main", startFromOrigin: true };
}

function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}

/**
 * Large catalogs (OpenCode, Cursor, Pi) can list hundreds of models, so agents
 * get a short list by default and search for the rest. These providers have
 * small official catalogs, so all their current models are listed.
 */
const FULL_CATALOG_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "muse", "grok"]);
const LISTED_MODEL_LIMIT = 8;

/**
 * Picks the models orchestrator_capabilities shows for one provider. Hidden
 * models never appear. With search terms, lists matches; otherwise lists pinned
 * models (custom, favorite, the caller's own) plus the provider's non-legacy
 * models, or only the first few in the user's model order for large catalogs.
 */
function listCapabilityModels(input: {
  readonly provider: ServerProvider;
  readonly preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly isPinned: (model: ServerProviderModel) => boolean;
  readonly searchTerms: ReadonlyArray<string>;
}) {
  const rank = new Map(input.preferences?.modelOrder.map((slug, index) => [slug, index]));
  const visible = input.provider.models
    .filter((model) => model.isCustom || !input.preferences?.hiddenModels.includes(model.slug))
    .toSorted((a, b) => (rank.get(a.slug) ?? rank.size) - (rank.get(b.slug) ?? rank.size));
  if (input.searchTerms.length > 0) {
    const matches = visible.filter((model) => {
      const text = `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
      return input.searchTerms.every((term) => text.includes(term));
    });
    const listed = matches.slice(0, LISTED_MODEL_LIMIT);
    return { listed, omitted: matches.length - listed.length };
  }
  const current = visible.filter((model) => !model.isLegacy);
  const shown = new Set(
    FULL_CATALOG_DRIVERS.has(input.provider.driver)
      ? current
      : current.slice(0, LISTED_MODEL_LIMIT),
  );
  const listed = visible.filter((model) => input.isPinned(model) || shown.has(model));
  return { listed, omitted: visible.length - listed.length };
}

/** Option ids and allowed values are all a delegating agent needs; labels are UI copy. */
function capabilityModelOption(descriptor: ProviderOptionDescriptor): OrchestratorMcpModelOption {
  const defaultValue = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    values:
      descriptor.type === "boolean" ? [false, true] : descriptor.options.map((choice) => choice.id),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  // Driver availability comes from the registry, even when health probes are skipped.
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Models without descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always fail: downstream
 * consumers disagree on whether the first or last value of a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run:
    | (Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> &
        Partial<Pick<OrchestrationV2Run, "admission">>)
    | undefined,
  stopRequested = false,
): OrchestratorMcpDelegateTaskResult["status"] {
  // A child waiting for a slot under the running-delegated-task limit has not started.
  if (run?.status === "preparing" && run.admission === "waiting") return "queued";
  switch (run === undefined ? undefined : delegatedRunOutcome(run, stopRequested)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

/** Modern runs name their task; untagged legacy child threads retain thread-level ownership. */
function workflowTaskRecords(
  taskId: NodeId,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
) {
  const runs = child.runs.filter(
    (run) => run.delegatedTaskId === taskId || run.delegatedTaskId === undefined,
  );
  const runIds = new Set(runs.map((run) => run.id));
  const attempts = child.attempts.filter((attempt) => runIds.has(attempt.runId));
  const attemptIds = new Set([
    ...attempts.map((attempt) => attempt.id),
    ...runs.flatMap((run) => (run.activeAttemptId === null ? [] : [run.activeAttemptId])),
  ]);
  const rootNodeIds = new Set([
    ...runs.map((run) => run.rootNodeId),
    ...attempts.map((attempt) => attempt.rootNodeId),
  ]);
  return {
    runs,
    providerTurns: child.providerTurns.filter((turn) =>
      turn.runAttemptId === null ? rootNodeIds.has(turn.nodeId) : attemptIds.has(turn.runAttemptId),
    ),
  };
}

function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    result.hasPendingQuestion ||
    result.pendingApproval !== null ||
    isTerminalTaskStatus(result.status)
  );
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "nodes" | "runtimeRequests">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
) {
  const taskRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            // Legacy tasks own only their original run, not later turns in the child thread.
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"] = null;
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    ) {
      continue;
    }
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId === undefined || runId === null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      approval = { requestId: request.id, kind: request.kind, runId };
    }
  }
  return approval;
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

function interactionModeRank(mode: ProviderInteractionMode): number {
  return mode === "plan" ? 0 : 1;
}

export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: Pick<ResolvedTarget, "modelSelection" | "supportedRuntimeModes">,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      failure(
        "runtime_mode_escalation_denied",
        `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      ),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      failure(
        "invalid_request",
        `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      ),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? parentMode : requested;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function structuredResultFor(prompt: string, summary: string | null) {
  const schema = summary === null ? undefined : resultSchemaOf(prompt);
  return schema === undefined || summary === null
    ? {}
    : readStructuredResult(summary, (value) => validateJsonSchema(schema, value));
}

function taskPrompt(input: OrchestratorMcpDelegateTasksItem): string {
  return withResultSchema(
    input.role === undefined || input.role === "general"
      ? input.task
      : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`,
    input.resultSchema,
  );
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

/** The same links `list_thread_pull_requests` reports, without the snapshot details. */
function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

function listItemFromShell(
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = offset + input.maxChars;
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const loadWorkflowPresets = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.workflowPresets),
    Effect.mapError(() => failure("orchestration_error", "Unable to read workflow presets.")),
  );
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);
  const secretRequests = yield* SecretRequests.SecretRequests;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(
        threadId,
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: {
          runtimeMode: clientRuntimeModeCeiling(scope.client),
          interactionMode: "default",
        } satisfies { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
      } as const;
    }
    const parent = yield* loadProjection(scope.thread.threadId);
    return {
      parent,
      limits: {
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
      },
    } as const;
  });

  const loadThreadCaller = Effect.fn("OrchestratorMcpService.loadThreadCaller")(function* (
    scope: McpInvocationScope,
    operation: string,
  ) {
    yield* requireCapability(scope);
    const threadScope = yield* requireThreadScope(scope, operation);
    const parent = yield* loadProjection(threadScope.thread.threadId);
    return { scope: threadScope, parent } as const;
  });

  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a T3 thread.",
            ),
          );

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    return yield* loadProjectThread(shell.projectId, threadId);
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const caller = yield* loadCaller(scope);
    const target =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? caller.parent
        : yield* loadTargetThread(threadId);
    return { ...caller, target } as const;
  });

  /**
   * A thread caller writes to another thread only while its own run is live,
   * so a credential that outlived its session cannot reach across threads.
   */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return threadManagement.getThreadShell(parent.thread.id).pipe(
        Effect.mapError(threadManagementFailure),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(notActive)
      : Effect.void;
  };

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const { parent } = yield* loadCaller(scope);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        threadId,
        `Thread ${threadId} is no longer available.`,
      );
    }
    const target = yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
        "runs",
        "runtimeRequests",
        "contextTransfers",
      ])
      .pipe(Effect.mapError(threadManagementFailure));
    return { parent, target, shell } as const;
  });

  const loadProviders = providerRegistry.getProviders;

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /**
   * Provider snapshots only re-probe while a client is in the foreground, so an
   * unattended agent can see a provider as unavailable after it was fixed.
   * Re-probe the requested instance once before refusing it.
   */
  const assertTargetEnabledForProject = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /**
     * Set only when the command that will dispatch this target already has a receipt: that
     * dispatch can only replay the recorded result, never start anything new, so filtering
     * candidates by the project's current settings would just refuse a retry that does no new
     * work. Never set this for a resolution whose dispatch uses a different command id than the
     * one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.fn.Return<ResolvedTarget, OrchestratorMcpFailure> {
    const requestedInstanceId = input.target?.providerInstanceId;
    const requestedDriver = input.target?.driverKind;
    const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
    let instanceId = requestedInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver &&
          orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (candidates.length === 0) {
        return yield* failure(
          "provider_unavailable",
          `No V2 provider adapter is registered for driver ${requestedDriver}.`,
        );
      }
      const healthyCandidates = candidates.filter(
        (candidate) => providerConstraints(candidate, true).length === 0,
      );
      const inheritedCandidate = healthyCandidates.find(
        (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
      );
      const orderedCandidates = [
        ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
        ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
      ];
      for (const candidate of orderedCandidates) {
        const enabledForProject =
          input.skipProjectEnablementFilter === true ||
          (yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: input.parent.thread.projectId,
            instanceId: candidate.instanceId,
          }));
        if (enabledForProject) {
          instanceId = candidate.instanceId;
          break;
        }
      }
      if (instanceId === undefined) {
        return yield* failure(
          "provider_unavailable",
          healthyCandidates.length === 0
            ? `No available V2 provider instance for driver ${requestedDriver}.`
            : `No instance of driver ${requestedDriver} is enabled for this project.`,
        );
      }
    }
    instanceId ??= input.parent.thread.modelSelection.instanceId;

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `Provider instance ${instanceId} is not registered.`,
      );
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* failure(
        "invalid_request",
        `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      );
    }
    const constraints = providerConstraints(
      provider,
      orchestrationCapableInstanceIds.has(provider.instanceId),
    );
    if (constraints.length > 0) {
      return yield* failure(
        "provider_unavailable",
        `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
      );
    }

    const inheritedSelection = input.parent.thread.modelSelection;
    const requestedModel = input.target?.model;
    const model =
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider?.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (
      requestedModel !== undefined &&
      provider !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === requestedModel)
    ) {
      return yield* failure(
        "model_unavailable",
        `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
      );
    }

    const requestedOptions = input.target?.options;
    if (requestedOptions !== undefined) {
      const descriptors = provider.models.find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors;
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }

    const inheritsOptions =
      instanceId === inheritedSelection.instanceId && model === inheritedSelection.model;
    let options = inheritsOptions ? inheritedSelection.options : undefined;
    if (requestedOptions !== undefined) {
      const selections = new Map(
        (requestedOptions.length === 0 ? [] : (options ?? [])).map((selection) => [
          selection.id,
          selection,
        ]),
      );
      for (const selection of requestedOptions) {
        selections.set(selection.id, selection);
      }
      options = [...selections.values()];
    }
    return {
      modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4().pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const parentProjection = yield* loadProjection(scope.thread.threadId);
    const task = parentProjection.subagents.find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === scope.thread.threadId,
    );
    if (task === undefined || task.childThreadId === null) {
      return yield* failure(
        "task_not_found",
        task?.workflow !== undefined
          ? `${taskId} is a workflow; use workflow_status or workflow_stop.`
          : `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
      );
    }
    const childControls = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        [
          "runs",
          "messages",
          "contextTransfers",
          "subagents",
          "providerThreads",
          "runtimeRequests",
          "nodes",
        ],
        { messageRoles: ["user"], omitSettledLeafNodes: true },
      )
      .pipe(Effect.mapError(threadManagementFailure));
    const childRun = delegatedTaskRun(childControls, task);
    const terminalRun = latestTerminalResultRun(childControls, childRun);
    const progress = delegatedTaskProgress(childControls);
    const taskResultRun =
      childRun?.delegatedTaskId === task.id
        ? childControls.runs
            .filter((run) => run.delegatedTaskId === task.id)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]
        : progress.resultRun;
    const taskWorkState =
      childRun?.delegatedTaskId === task.id
        ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? "result_available"
          : "working"
        : progress.state;
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error", "run_interrupt_request"],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    // Finalization can trail a Stop; until it lands, the status follows the same rule.
    const resultRun = taskResultRun ?? childRun;
    const resultRunStopRequested = resultRecords.turnItems.some(
      (item) => item.type === "run_interrupt_request" && item.runId === resultRun?.id,
    );
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: resultRecords.turnItems,
    };
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(Effect.mapError(threadManagementFailure)));
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const status =
      task.result !== null
        ? taskStatusForRun(
            task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
              ? { status: task.status }
              : childRun,
          )
        : workState === "result_available"
          ? taskStatusForRun(resultRun, resultRunStopRequested)
          : taskStatusForRun(resultRun) === "queued"
            ? "queued"
            : "running";
    const derivedResult =
      task.result !== null
        ? task.result
        : taskResultRun !== undefined && isTerminalTaskStatus(status)
          ? subagentResultForRun(childProjection, taskResultRun).text
          : null;
    const resultTransfers = parentProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === task.childThreadId &&
        transfer.targetThreadId === scope.thread.threadId,
    );
    const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
      !canExposeTaskRunResult(run)
        ? null
        : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
          (run.id === childRun?.id
            ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
            : undefined) ??
          null);
    const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
    const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : subagentResultForRun(childProjection, terminalRun).text
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const modelSelection = childRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    const response = {
      taskId: task.id,
      childThreadId: task.childThreadId,
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      options: modelSelection.options ?? [],
      summary: derivedResult,
      ...structuredResultFor(task.prompt, isTerminalTaskStatus(status) ? derivedResult : null),
      resultContextTransferId,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      latestTerminalSummary: latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
      latestTerminalResultContextTransferId:
        latestTerminalResultContextTransferId === resultContextTransferId
          ? null
          : latestTerminalResultContextTransferId,
      hasPendingQuestion:
        !isTerminalTaskStatus(status) &&
        childControls.runtimeRequests.some(
          (request) =>
            request.kind === "user_input" &&
            request.status === "pending" &&
            request.responseCapability.type === "live",
        ),
      pendingApproval:
        isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? null
          : pendingTaskApproval(childControls, task.id, childRun),
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
    if (
      acknowledgeTerminal &&
      isTerminalTaskStatus(status) &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      const acknowledgementRequestKey = yield* requestKey(undefined);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: acknowledgementRequestKey,
            operation: acknowledgementOperation,
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return response;
  });

  type CallerProjection = Effect.Success<ReturnType<typeof loadThreadCaller>>["parent"];

  const requireDelegatingRun = Effect.fn("OrchestratorMcpService.requireDelegatingRun")(function* (
    scope: McpThreadInvocationScope,
    parent: CallerProjection,
  ) {
    const parentRun = parent.runs
      .filter(ThreadManagementService.isActiveRun)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    if (
      parentRun === undefined ||
      parentRun.rootNodeId === null ||
      parentRun.providerInstanceId !== scope.thread.providerInstanceId
    ) {
      return yield* failure(
        "parent_not_active",
        "Delegated tasks require an active run owned by this MCP provider session.",
      );
    }
    return { ...parentRun, rootNodeId: parentRun.rootNodeId };
  });

  // Resolved at most once per call: a batch of worktree tasks shares one base commit.
  const makeParentCommitResolver = (parent: CallerProjection) =>
    Effect.cached(
      Effect.gen(function* () {
        const project = yield* requireProject(parent.thread.projectId);
        const base = yield* gitDriver
          .resolveCommit({
            cwd: parent.thread.worktreePath ?? project.workspaceRoot,
            revision: "HEAD",
          })
          .pipe(
            Effect.mapError(() =>
              failure("invalid_request", "Unable to resolve the parent checkout commit."),
            ),
          );
        // Launch preparation creates the worktree from the project root, so a
        // parent checkout in another repository (such as a Git folder inside
        // Scratch) would hand it a commit it cannot find.
        if (parent.thread.worktreePath !== null) {
          yield* gitDriver
            .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
            .pipe(
              Effect.mapError(() =>
                failure(
                  "invalid_request",
                  `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                ),
              ),
            );
        }
        return base.commitSha;
      }),
    );

  const prepareDelegation = Effect.fn("OrchestratorMcpService.prepareDelegation")(
    function* (input: {
      readonly scope: McpThreadInvocationScope;
      readonly parent: CallerProjection;
      readonly providers: Effect.Success<typeof loadProviders>;
      readonly item: OrchestratorMcpDelegateTasksItem;
      readonly requestKey: string;
      readonly parentCommit: Effect.Success<ReturnType<typeof makeParentCommitResolver>>;
    }) {
      const { scope, parent, item } = input;
      const commandId = stableCommandId({
        scope,
        requestKey: input.requestKey,
        operation: "delegate-task",
      });
      const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
      const target = yield* resolveTargetRechecking({
        parent,
        target: item.target,
        providers: input.providers,
        skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
      });
      const runtimeMode = yield* resolveRuntimeMode(
        parent.thread.runtimeMode,
        item.runtimeMode,
        target,
      );
      const interactionMode = yield* resolveInteractionMode(
        parent.thread.interactionMode,
        item.interactionMode,
      );
      const workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined =
        item.isolation === "worktree" && !isRetryOfAcceptedDelegation
          ? { type: "worktree", baseRef: yield* input.parentCommit, startFromOrigin: false }
          : undefined;
      return { commandId, item, target, runtimeMode, interactionMode, workspaceStrategy } as const;
    },
  );

  const dispatchDelegation = Effect.fn("OrchestratorMcpService.dispatchDelegation")(
    function* (input: {
      readonly scope: McpThreadInvocationScope;
      readonly parentRun: { readonly id: RunId; readonly rootNodeId: NodeId };
      readonly prepared: Effect.Success<ReturnType<typeof prepareDelegation>>;
      readonly completionWake: "always" | "settled_only";
      readonly workflowId?: NodeId;
    }) {
      const { scope, parentRun, prepared } = input;
      // ThreadManagementService.dispatch is the chokepoint for this command
      // type's own enablement check, using the same command id and its
      // receipt-replay exemption, so no separate assert runs here.
      const result = yield* threadManagement
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: prepared.commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: taskPrompt(prepared.item),
          ...(prepared.item.title === undefined ? {} : { title: prepared.item.title }),
          modelSelection: prepared.target.modelSelection,
          runtimeMode: prepared.runtimeMode,
          interactionMode: prepared.interactionMode,
          ...(prepared.workspaceStrategy === undefined
            ? {}
            : { workspaceStrategy: prepared.workspaceStrategy }),
          completionWake: input.completionWake,
          ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to create delegated task: ${errorMessage(error)}`,
                ),
          ),
        );
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (
        taskEvent?.event.type !== "subagent.updated" ||
        taskEvent.event.payload.childThreadId === null
      ) {
        return yield* failure(
          "orchestration_error",
          "Delegated task command did not produce a task projection.",
        );
      }
      const taskId = taskEvent.event.payload.id;
      const childThreadId = taskEvent.event.payload.childThreadId;
      const { driver, providerInstanceId } = taskEvent.event.payload;
      const childRunEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (
        childRunEvent?.event.type === "run.created" &&
        childRunEvent.event.payload.workspacePreparation !== undefined
      ) {
        yield* threadLaunch.prepareRun({
          commandId: prepared.commandId,
          threadId: childThreadId,
          runId: childRunEvent.event.payload.id,
        });
      }
      const childRun = result.storedEvents.findLast(
        (stored) =>
          (stored.event.type === "run.created" || stored.event.type === "run.updated") &&
          stored.event.threadId === childThreadId,
      );
      return {
        taskId,
        childThreadId,
        driver,
        providerInstanceId,
        queued:
          (childRun?.event.type === "run.created" || childRun?.event.type === "run.updated") &&
          (childRun.event.payload.status === "queued" ||
            childRun.event.payload.admission === "waiting"),
      };
    },
  );

  // A workflow's agents act with the starting thread's authority; this scope only
  // namespaces their command ids so each workflow derives its own.
  const workflowScope = (
    scope: McpThreadInvocationScope,
    workflowId: NodeId,
  ): McpThreadInvocationScope => ({ ...scope, requestNamespace: `workflow:${workflowId}` });
  const workflowScopes = new Map<NodeId, McpThreadInvocationScope>();

  /**
   * A workspace-relative file in the thread's own checkout, read and hashed up to maxBytes.
   * Workflow agents with declared files, and graphs, share this checkout.
   */
  const readCallerFile = Effect.fn("OrchestratorMcpService.readCallerFile")(function* (
    threadId: ThreadId,
    relativePath: string,
    maxBytes: number,
  ) {
    const parent = yield* loadProjection(threadId);
    const root =
      parent.thread.worktreePath ?? (yield* requireProject(parent.thread.projectId)).workspaceRoot;
    const filePath = path.join(root, relativePath);
    const unreadable = (error: { readonly message: string }) =>
      failure("orchestration_error", `Unable to read ${relativePath}: ${error.message}`);
    const info = yield* fileSystem.stat(filePath).pipe(
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
      }),
      Effect.mapError(unreadable),
    );
    if (info === null || info.type !== "File") return { status: "missing" } as const;
    if (Number(info.size) > maxBytes) {
      return { status: "too_large", sizeBytes: Number(info.size) } as const;
    }
    const bytes = yield* fileSystem.readFile(filePath).pipe(Effect.mapError(unreadable));
    // The file can grow between the stat and the read.
    if (bytes.byteLength > maxBytes) {
      return { status: "too_large", sizeBytes: bytes.byteLength } as const;
    }
    return {
      status: "found",
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      text: new TextDecoder().decode(bytes),
    } as const;
  });

  const workflowRunner = makeWorkflowRunner({
    threads: threadManagement,
    spawnAgent: Effect.fn("OrchestratorMcpService.spawnWorkflowAgent")(
      function* (workflow, item, key) {
        const scope = workflowScopes.get(workflow.workflowId);
        if (scope === undefined) {
          return yield* failure("orchestration_error", "The workflow is not running here.");
        }
        const parent = yield* loadProjection(workflow.threadId);
        const row = parent.subagents.find((task) => task.id === workflow.workflowId);
        if (row?.runId == null) {
          return yield* failure("orchestration_error", "The workflow row is missing.");
        }
        const prepared = yield* prepareDelegation({
          scope,
          parent:
            workflow.callerSelection === undefined
              ? parent
              : {
                  ...parent,
                  thread: { ...parent.thread, modelSelection: workflow.callerSelection },
                },
          providers: yield* loadProviders,
          item,
          requestKey: key,
          parentCommit: yield* makeParentCommitResolver(parent),
        });
        const started = yield* dispatchDelegation({
          scope,
          parentRun: { id: row.runId, rootNodeId: workflow.workflowId },
          prepared,
          completionWake: "always",
          workflowId: workflow.workflowId,
        });
        return {
          taskId: started.taskId,
          childThreadId: started.childThreadId,
          model: prepared.target.modelSelection.model,
          providerInstanceId: started.providerInstanceId,
          driver: started.driver,
        };
      },
    ),
    agentStarted: Effect.fn("OrchestratorMcpService.workflowAgentStarted")(
      function* (workflow, requestKey) {
        const scope = workflowScopes.get(workflow.workflowId);
        if (scope === undefined) return false;
        return yield* threadManagement.hasReceipt(
          stableCommandId({ scope, requestKey, operation: "delegate-task" }),
        );
      },
    ),
    canRunCommands: (workflow) =>
      loadProjection(workflow.threadId).pipe(
        Effect.map((projection) => projection.thread.runtimeMode === "full-access"),
      ),
    runCommandCheck: Effect.fn("OrchestratorMcpService.runWorkflowCommandCheck")(
      function* (workflow, childThreadId, check, result, files) {
        const parent = yield* loadProjection(workflow.threadId);
        const child = yield* threadManagement
          .getThreadShell(childThreadId)
          .pipe(Effect.mapError(threadManagementFailure));
        const root =
          child?.worktreePath ??
          parent.thread.worktreePath ??
          (yield* requireProject(parent.thread.projectId)).workspaceRoot;
        const [command, ...args] = check.argv;
        // Checks run without a shell, so no argument is ever read as a command.
        const resolved = yield* resolveSpawnCommand(command, args);
        if (resolved.shell) {
          return {
            outcome: "error",
            detail: `${command} runs through a shell (a .cmd or .bat launcher); name the executable itself.`,
          } satisfies CheckOutcome;
        }
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const resultFile = yield* fileSystem.makeTempFileScoped({ prefix: "t3-check-" });
            yield* fileSystem.writeFileString(resultFile, result);
            const expanded = args.map((arg) =>
              arg
                .replaceAll("{{result}}", resultFile)
                .replace(/\{\{((?:input|output):[A-Za-z0-9._-]+)\}\}/g, (token, key: string) => {
                  const relative = files[key];
                  return relative === undefined ? token : path.join(root, relative);
                }),
            );
            const unknownToken = expanded.find((arg) => /\{\{[^}]*\}\}/.test(arg));
            if (unknownToken !== undefined) {
              return {
                outcome: "error",
                detail: `Unknown token in ${unknownToken}; checks support {{result}}, and {{input:<id>}} and {{output:<id>}} for the agent's declared files.`,
              } satisfies CheckOutcome;
            }
            const ran = yield* processRunner
              .run({
                command,
                args: expanded,
                cwd: path.join(root, check.cwd),
                timeout: Duration.millis(check.timeoutMs),
                maxOutputBytes: check.maxOutputBytes,
                outputMode: "truncate",
                timeoutBehavior: "timedOutResult",
              })
              .pipe(Effect.result);
            if (ran._tag === "Failure") {
              return { outcome: "error", detail: ran.failure.message } satisfies CheckOutcome;
            }
            const tail = (label: string, text: string) =>
              text.trim().length === 0 ? [] : [`${label}:\n${text.trimEnd().slice(-2_000)}`];
            const output = [
              ...tail("stdout", ran.success.stdout),
              ...tail("stderr", ran.success.stderr),
            ];
            if (
              ran.success.timedOut ||
              ran.success.stdoutTruncated ||
              ran.success.stderrTruncated
            ) {
              return {
                outcome: "error",
                detail: ran.success.timedOut
                  ? `The check timed out after ${check.timeoutMs} ms.`
                  : `The check printed more than ${check.maxOutputBytes} bytes.`,
              } satisfies CheckOutcome;
            }
            const passed =
              ran.success.code !== null &&
              check.successExitCodes.includes(Number(ran.success.code));
            return {
              outcome: passed ? "passed" : "failed",
              detail: [`exit code ${ran.success.code ?? "none"}`, ...output].join("\n"),
            } satisfies CheckOutcome;
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              outcome: "error",
              detail: `The check could not run: ${errorMessage(cause)}`,
            } satisfies CheckOutcome),
          ),
        );
      },
    ),
    readWorkspaceFile: (workflow, relativePath, maxBytes) =>
      readCallerFile(workflow.threadId, relativePath, maxBytes),
    stopAgent: Effect.fn("OrchestratorMcpService.stopWorkflowAgent")(
      function* (workflow, taskId, childThreadId, why) {
        const commandId = CommandId.make(`command:workflow-stall:${taskId}`);
        const reason =
          why === "timed_out"
            ? "The agent passed its attempt's time budget, so its workflow stopped it."
            : "The agent recorded no activity for too long, so its workflow starts it again.";
        yield* threadManagement
          .dispatch({ type: "thread.stop", commandId, threadId: childThreadId, reason })
          .pipe(Effect.mapError(threadManagementFailure));
        yield* threadManagement
          .stopDelegatedTasks({ threadId: childThreadId, commandId, reason })
          .pipe(Effect.mapError(threadManagementFailure));
      },
    ),
    awaitAgent: Effect.fn("OrchestratorMcpService.awaitWorkflowAgent")(
      function* (workflow, taskId, onUpdate) {
        const scope = workflowScopes.get(workflow.workflowId);
        if (scope === undefined) {
          return yield* failure("orchestration_error", "The workflow is not running here.");
        }
        // Capture the global cursor before reading either thread, so late commits are replayed.
        const afterSequence = yield* threadManagement
          .getThreadEventSequence(scope.thread.threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        const read = Effect.fn("OrchestratorMcpService.readWorkflowAgent")(function* () {
          const task = yield* readTask(scope, taskId);
          const child = yield* threadManagement
            .getThreadRecords(task.childThreadId, ["runs", "attempts", "providerTurns"])
            .pipe(Effect.mapError(threadManagementFailure));
          const { runs, providerTurns } = workflowTaskRecords(taskId, child);
          const lastRun = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
          const parent = yield* threadManagement
            .getThreadRecords(scope.thread.threadId, ["subagents"])
            .pipe(Effect.mapError(threadManagementFailure));
          const recorded = parent.subagents.find((member) => member.id === taskId);
          const timing = workflowExecutionTiming(
            runs.map((run) => ({
              startedAt: run.startedAt === null ? null : DateTime.toEpochMillis(run.startedAt),
              completedAt:
                run.completedAt === null ? null : DateTime.toEpochMillis(run.completedAt),
            })),
            task.status === "running" || task.status === "waiting"
              ? yield* Clock.currentTimeMillis
              : undefined,
          );
          const outcome = {
            timing,
            status: task.status,
            summary: task.summary,
            cancelledByServerRestart: lastRun?.cancelledByServerRestart === true,
            outcomeCategory: workflowAgentOutcomeCategory({ status: task.status, started: true }),
            usage: aggregateWorkflowUsage(
              providerTurns.length === 0 ? [undefined] : providerTurns.map(workflowTurnUsage),
            ),
            ...(task.structuredResult === undefined
              ? {}
              : { structuredResult: task.structuredResult }),
            ...(task.structuredResultError === undefined
              ? {}
              : { structuredResultError: task.structuredResultError }),
          };
          return {
            outcome,
            settled:
              isTerminalTaskStatus(task.status) &&
              recorded !== undefined &&
              isTerminalTaskStatus(recorded.status) &&
              // Adapters persist final usage before the terminal that ends the run.
              // Ingestion/interrupt failures and legacy rows can leave an open turn
              // with no event producer. The run is authoritative; its counts stay partial.
              runs.every(
                (run) =>
                  run.completedAt !== null ||
                  (ThreadManagementService.isTerminalRunStatus(run.status) &&
                    run.startedAt === null),
              ),
          };
        });
        const initial = yield* read();
        onUpdate(initial.outcome);
        if (initial.settled) return initial.outcome;
        const task = yield* readTask(scope, taskId);
        const settled = yield* Stream.mergeAll(
          [
            threadManagement
              .streamStoredEventsFrom({
                threadId: scope.thread.threadId,
                afterSequence,
                eventType: "subagent.updated",
              })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
                ),
              ),
            ...(["run.updated", "provider-turn.updated"] as const).map((eventType) =>
              threadManagement.streamStoredEventsFrom({
                threadId: task.childThreadId,
                afterSequence,
                eventType,
              }),
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Stream.mapError(threadManagementFailure),
          Stream.mapEffect(read),
          Stream.tap((snapshot) => Effect.sync(() => onUpdate(snapshot.outcome))),
          Stream.filter((snapshot) => snapshot.settled),
          Stream.runHead,
        );
        if (Option.isNone(settled))
          return yield* failure(
            "orchestration_error",
            "The child event stream ended before settlement.",
          );
        return settled.value.outcome;
      },
    ),
  });

  type GraphReview = ReturnType<typeof reviewGraph> & {
    targets: OrchestratorMcpGraphReviewResult["targets"];
    expandedGraph: unknown | null;
  };
  // Input hashes of recent reviews by digest, so a refused start can name the files that changed.
  const reviewedGraphInputs = new Map<string, GraphReview["inputs"]>();
  const REVIEWED_GRAPHS_KEPT = 256;

  /** Reviews a graph against the files in the caller's checkout as they are now. */
  const reviewCallerGraph = Effect.fn("OrchestratorMcpService.reviewCallerGraph")(function* (
    parent: CallerProjection,
    graph: unknown,
    workerTarget: OrchestratorMcpTarget | undefined,
  ) {
    const threadId = parent.thread.id;
    const parsed = parseGraph(graph);
    const presets = yield* loadWorkflowPresets;
    let concreteGraph = parsed.ok ? parsed.graph : undefined;
    const hashes: Record<string, GraphReview["inputs"][string]> = {};
    const targets: OrchestratorMcpGraphReviewResult["targets"][number][] = [];
    const targetBlockers: string[] = [];
    const resolveGraphTarget = Effect.fn("OrchestratorMcpService.resolveGraphTarget")(
      function* (value: unknown, _label: string) {
        const target =
          value === undefined
            ? undefined
            : yield* decodeWorkflowTarget(value).pipe(
                Effect.mapError(() => failure("invalid_request", "Invalid target.")),
              );
        const resolved = yield* resolveTargetRechecking({
          parent,
          target,
          providers: yield* loadProviders,
        });
        const selection = resolved.modelSelection;
        // Graph approval needs a known concrete assignment, including inherited models.
        const providers = yield* loadProviders;
        const model = providers
          .find((provider) => provider.instanceId === selection.instanceId)
          ?.models.find((model) => model.slug === selection.model);
        if (model === undefined) {
          return yield* failure(
            "model_unavailable",
            `Model ${selection.model} is not advertised by provider ${selection.instanceId}.`,
          );
        }
        // Dispatch receives these inherited values explicitly, so validate them too.
        const invalid = invalidOptionSelections(
          selection.options ?? [],
          model.capabilities?.optionDescriptors,
        );
        if (invalid.length > 0)
          return yield* failure(
            "invalid_request",
            `Model ${selection.model} on provider ${selection.instanceId} rejected options: ${invalid.join(" ")}`,
          );
        return concreteWorkflowTarget(selection);
      },
      (effect, _value, label) =>
        effect.pipe(
          Effect.catch((error) => {
            targetBlockers.push(`${label}: ${error.message}`);
            return Effect.succeed(undefined);
          }),
        ),
    );
    if (parsed.ok) {
      const nodes: Record<string, (typeof parsed.graph.nodes)[string]> = {};
      for (const [nodeId, node] of Object.entries(parsed.graph.nodes)) {
        const selected = selectWorkflowTarget(node, workerTarget, presets);
        if (selected.error !== undefined) targetBlockers.push(`${nodeId}: ${selected.error}`);
        const target =
          selected.error === undefined
            ? yield* resolveGraphTarget(selected.target, nodeId)
            : undefined;
        let verify = node.verify;
        let judgmentTarget: OrchestratorMcpTarget | undefined;
        if (verify?.type === "judgment") {
          judgmentTarget = yield* resolveGraphTarget(verify.target ?? target, `${nodeId} judgment`);
          verify = { ...verify, target: judgmentTarget };
        }
        if (target !== undefined)
          targets.push({
            nodeId,
            source: selected.source,
            target,
            ...(judgmentTarget === undefined ? {} : { judgmentTarget }),
          });
        const { model: _legacyModel, preset: _preset, ...concreteNode } = node;
        nodes[nodeId] = { ...concreteNode, target, ...(verify === undefined ? {} : { verify }) };
      }
      concreteGraph = { ...parsed.graph, nodes };
      // A file several nodes read is read once, under the largest bound; review checks each.
      const bounds = new Map<string, number>();
      for (const node of Object.values(parsed.graph.nodes)) {
        for (const input of node.inputs) {
          if (input.kind !== "workspace_snapshot") continue;
          bounds.set(input.path, Math.max(bounds.get(input.path) ?? 0, input.maxBytes));
        }
      }
      for (const [filePath, maxBytes] of [...bounds].toSorted(([a], [b]) => a.localeCompare(b))) {
        const file = yield* readCallerFile(threadId, filePath, maxBytes);
        hashes[filePath] =
          file.status === "found"
            ? { sha256: file.sha256, sizeBytes: file.sizeBytes }
            : file.status;
      }
    }
    const reviewed = reviewGraph(concreteGraph ?? graph, hashes);
    const review: GraphReview = {
      ...reviewed,
      targets,
      expandedGraph:
        targetBlockers.length === 0 && reviewed.blockers.length === 0
          ? (concreteGraph ?? null)
          : null,
      blockers: [...reviewed.blockers, ...targetBlockers],
      digest: targetBlockers.length > 0 ? null : reviewed.digest,
    };
    if (review.digest !== null) {
      reviewedGraphInputs.delete(review.digest);
      reviewedGraphInputs.set(review.digest, review.inputs);
      if (reviewedGraphInputs.size > REVIEWED_GRAPHS_KEPT) {
        reviewedGraphInputs.delete(reviewedGraphInputs.keys().next().value!);
      }
    }
    const compiled =
      concreteGraph !== undefined && review.blockers.length === 0
        ? {
            source: GRAPH_DRIVER_SCRIPT,
            args: { graph: concreteGraph, inputs: review.inputs },
            plan: graphPlan(concreteGraph),
            title: concreteGraph.name ?? "Graph",
          }
        : undefined;
    return { review, compiled };
  });

  /** The input files whose hashes differ from an earlier review, or undefined if it is unknown. */
  const changedGraphInputs = (
    acceptedDigest: string,
    current: GraphReview["inputs"],
  ): ReadonlyArray<string> | undefined => {
    const accepted = reviewedGraphInputs.get(acceptedDigest);
    if (accepted === undefined) return undefined;
    return [...new Set([...Object.keys(accepted), ...Object.keys(current)])]
      .filter((file) => JSON.stringify(accepted[file]) !== JSON.stringify(current[file]))
      .toSorted();
  };

  const graphReviewResult = (review: GraphReview): OrchestratorMcpGraphReviewResult => ({
    digest: review.digest,
    ready: review.digest !== null && review.blockers.length === 0,
    targets: review.targets,
    expandedGraph: review.expandedGraph,
    layers: review.layers,
    writeConflicts: review.writeConflicts,
    inputs: Object.entries(review.inputs).map(([filePath, hash]) =>
      typeof hash === "string"
        ? { path: filePath, status: hash, sha256: null, sizeBytes: null }
        : { path: filePath, status: "found", sha256: hash.sha256, sizeBytes: hash.sizeBytes },
    ),
    blockers: review.blockers,
  });

  /**
   * Starts a workflow row for the caller and launches its script; workflows and graphs share it.
   * Only a reviewed graph passes a plan, so a script cannot declare graph nodes or outcomes.
   */
  const startWorkflow = Effect.fn("OrchestratorMcpService.startWorkflow")(function* (
    scope: McpThreadInvocationScope,
    parent: CallerProjection,
    input: OrchestratorMcpWorkflowStartInput,
    plan?: OrchestrationV2WorkflowPlan,
  ) {
    const parentRun = yield* requireDelegatingRun(scope, parent);
    const compileError = yield* Effect.promise(() => checkWorkflowScript(input.script));
    if (compileError !== null) {
      return yield* failure(
        "invalid_request",
        `The workflow script does not compile: ${compileError}`,
      );
    }
    const key = yield* requestKey(input.clientRequestId);
    const commandId = stableCommandId({ scope, requestKey: key, operation: "workflow-start" });
    const workflowId = NodeId.make(String(commandId).replace(/^command:/, "workflow:"));
    const workflowPresets = yield* loadWorkflowPresets;
    const snapshotTarget = Effect.fn("OrchestratorMcpService.snapshotWorkflowTarget")(function* (
      target: OrchestratorMcpTarget,
    ) {
      return yield* resolveTargetRechecking({
        parent,
        target,
        providers: yield* loadProviders,
      }).pipe(
        Effect.map((resolved) => ({ target: concreteWorkflowTarget(resolved.modelSelection) })),
        Effect.catch((error) => Effect.succeed({ error: error.message })),
      );
    });
    const presetTargets: Record<string, typeof WorkflowTargetSnapshot.Type> = Object.create(null);
    for (const preset of workflowPresets.presets) {
      presetTargets[preset.id] = yield* snapshotTarget(preset.target);
    }
    // Defaults must not depend on catalog order after a restart. Keep failure until
    // an agent actually selects the default: its own target can still override it.
    const workerTargetSnapshot =
      input.workerTarget === undefined ? undefined : yield* snapshotTarget(input.workerTarget);
    const afterSequence = yield* threadManagement
      .getThreadEventSequence(scope.thread.threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    yield* threadManagement
      .dispatch({
        type: "workflow.start",
        createdBy: "agent",
        creationSource: "mcp",
        commandId,
        threadId: scope.thread.threadId,
        runId: parentRun.id,
        workflowId,
        title: input.title ?? "Workflow",
        script: storedWorkflowScript(input.script, {
          callerSelection: parent.thread.modelSelection,
          workflowPresets,
          presetTargets,
          ...(input.args === undefined ? {} : { args: input.args }),
          ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
          ...(input.workerTarget === undefined ? {} : { workerTarget: input.workerTarget }),
          ...(workerTargetSnapshot === undefined ? {} : { workerTargetSnapshot }),
          ...(plan === undefined ? {} : { plan }),
        }),
      })
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Unable to start the workflow: ${errorMessage(error)}`),
        ),
      );
    const started = findWorkflow(yield* loadProjection(scope.thread.threadId), workflowId);
    if (started === undefined) {
      return yield* failure("orchestration_error", "The workflow did not start.");
    }
    if (started.status === "running" && !workflowRunner.isRunning(workflowId)) {
      yield* resumeWorkflow(started, workflowScope(scope, workflowId), afterSequence);
    }
    return yield* workflowResult(yield* loadProjection(scope.thread.threadId), started);
  });

  const findWorkflow = (
    projection: Pick<OrchestrationV2ThreadProjection, "subagents">,
    workflowId: NodeId,
  ) =>
    projection.subagents.find(
      (task) =>
        task.id === workflowId &&
        task.origin === "app_owned" &&
        task.workflow !== undefined &&
        task.childThreadId === null,
    );

  const storedBudget = (prompt: string) => {
    try {
      return parseStoredWorkflowScript(prompt).budgetTokens;
    } catch {
      return undefined;
    }
  };

  const workflowResult = Effect.fn("OrchestratorMcpService.workflowResult")(function* (
    projection: Pick<OrchestrationV2ThreadProjection, "subagents">,
    workflow: OrchestrationV2Subagent,
  ) {
    const members = new Map(
      projection.subagents
        .filter((task) => task.parentNodeId === workflow.id)
        .map((task) => [task.id as string, task]),
    );
    const agents = workflow.workflow?.agents ?? [];
    const records = yield* Effect.forEach(
      [...members.values()],
      (member) =>
        Effect.gen(function* () {
          const childRecords =
            member.childThreadId === null
              ? null
              : yield* threadManagement
                  .getThreadRecords(member.childThreadId, ["runs", "attempts", "providerTurns"])
                  .pipe(Effect.mapError(threadManagementFailure));
          const child = childRecords === null ? null : workflowTaskRecords(member.id, childRecords);
          return {
            member,
            child,
            usage:
              child === null || child.providerTurns.length === 0
                ? [undefined]
                : child.providerTurns.map(workflowTurnUsage),
          };
        }),
      { concurrency: 8 },
    );
    const usage = aggregateWorkflowUsage(records.flatMap((record) => record.usage));
    const epoch = (value: DateTime.Utc | null | undefined) =>
      value == null ? null : DateTime.toEpochMillis(value);
    const edge = (values: ReadonlyArray<number | null>, latest = false) => {
      const known = values.filter((value) => value !== null);
      return known.length === 0 ? null : latest ? Math.max(...known) : Math.min(...known);
    };
    return {
      workflowId: workflow.id,
      status:
        workflow.status === "completed" ||
        workflow.status === "failed" ||
        workflow.status === "cancelled" ||
        workflow.status === "interrupted"
          ? workflow.status
          : "running",
      name: workflow.workflow?.name ?? workflow.title,
      phases: (workflow.workflow?.phases ?? []).map((phase) => phase.title),
      agents: agents.map((agent) => {
        const member = agent.agentId === undefined ? undefined : members.get(agent.agentId);
        // A task can finish and still fail its check; the workflow's own record decides.
        const status =
          member === undefined || (agent.state === "failed" && member.status === "completed")
            ? agent.state
            : member.status === "completed" ||
                member.status === "failed" ||
                member.status === "cancelled" ||
                member.status === "interrupted"
              ? member.status
              : member.status === "pending" || member.status === "idle"
                ? "queued"
                : "running";
        const ids = agent.attemptTaskIds ?? (agent.agentId === undefined ? [] : [agent.agentId]);
        const attempts = records.filter((record) => ids.includes(record.member.id));
        const runs = attempts.flatMap((record) => record.child?.runs ?? []);
        const turns = attempts.flatMap((record) => record.child?.providerTurns ?? []);
        const terminal = status !== "queued" && status !== "running";
        return {
          usage: aggregateWorkflowUsage([
            ...attempts.flatMap((record) => record.usage),
            // Older rows retained only the latest attempt. Its known usage is a lower bound.
            ...(ids.length < (agent.attempt ?? 0) + 1 ? [undefined] : []),
          ]),
          outcomeCategory: !terminal
            ? null
            : (agent.outcomeCategory ??
              workflowAgentOutcomeCategory({
                status,
                started: member !== undefined,
                checkFailed:
                  agent.verification?.outcome === "failed" ||
                  agent.verification?.outcome === "error",
              })),
          timings: {
            createdAt: edge(attempts.map((record) => epoch(record.member.startedAt))),
            runStartedAt: edge(runs.map((run) => epoch(run.startedAt))),
            providerTurnStartedAt: edge(turns.map((turn) => epoch(turn.startedAt))),
            providerTurnEndedAt: edge(
              turns.map((turn) => epoch(turn.completedAt)),
              true,
            ),
            completedAt: edge(
              attempts.map((record) => epoch(record.member.completedAt)),
              true,
            ),
            runnerSettledAt: agent.runnerSettledAt ?? null,
          },
          index: agent.index,
          label: agent.label,
          phase: agent.phaseTitle ?? null,
          status,
          taskId: member?.id ?? null,
          childThreadId: agent.childThreadId ?? null,
          model: agent.model ?? null,
          result: agent.result ?? null,
          verification:
            agent.verification === undefined
              ? null
              : { ...agent.verification, detail: agent.verification.detail ?? null },
        };
      }),
      progress: workflow.progress ?? null,
      usage,
      tokensUsed: usage.totalTokens,
      budgetTokens: storedBudget(workflow.prompt) ?? null,
      result: workflow.result,
    } satisfies OrchestratorMcpWorkflowResult;
  });

  // Agents act with the starting thread's authority, which comes from the thread itself;
  // the session that started the workflow is gone after a restart, so only the thread,
  // the namespace and the capability are real here.
  const resumedWorkflowScope = (row: OrchestrationV2Subagent): McpThreadInvocationScope => ({
    environmentId: EnvironmentId.make("environment:workflow-resume"),
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
    requestNamespace: `workflow:${row.id}`,
    thread: {
      threadId: row.threadId,
      providerSessionId: "workflow-resume",
      providerInstanceId: row.providerInstanceId,
    },
    client: undefined,
  });

  const resumeWorkflow = Effect.fn("OrchestratorMcpService.resumeWorkflow")(function* (
    row: OrchestrationV2Subagent,
    scope = resumedWorkflowScope(row),
    afterSequence = 0,
  ) {
    const stored = yield* Effect.try({
      try: () => parseStoredWorkflowScript(row.prompt),
      catch: () => "unreadable" as const,
    }).pipe(Effect.option);
    const plan =
      stored._tag === "Some" && stored.value.plan !== undefined
        ? decodeWorkflowPlan(stored.value.plan)
        : Option.none();
    const callerSelection =
      stored._tag === "Some" && stored.value.callerSelection !== undefined
        ? decodeWorkflowCallerSelection(stored.value.callerSelection)
        : Option.none();
    const workerTargetSnapshot =
      stored._tag === "Some" && stored.value.workerTargetSnapshot !== undefined
        ? decodeWorkerTargetSnapshot(stored.value.workerTargetSnapshot)
        : Option.none();
    const workflowPresets =
      stored._tag === "Some" && stored.value.workflowPresets !== undefined
        ? decodeWorkflowPresets(stored.value.workflowPresets)
        : Option.none();
    const presetTargets =
      stored._tag === "Some" && stored.value.presetTargets !== undefined
        ? decodePresetTargets(stored.value.presetTargets)
        : Option.none();
    if (
      stored._tag === "None" ||
      (stored.value.plan !== undefined && Option.isNone(plan)) ||
      (stored.value.callerSelection !== undefined && Option.isNone(callerSelection)) ||
      (stored.value.workerTargetSnapshot !== undefined && Option.isNone(workerTargetSnapshot)) ||
      (stored.value.workflowPresets !== undefined && Option.isNone(workflowPresets)) ||
      (stored.value.presetTargets !== undefined && Option.isNone(presetTargets))
    ) {
      yield* threadManagement
        .dispatch({
          type: "workflow.complete",
          commandId: CommandId.make(`command:workflow-complete:${row.id}`),
          threadId: row.threadId,
          workflowId: row.id,
          status: "failed",
          result: "The workflow could not resume: its stored arguments are unreadable.",
        })
        .pipe(Effect.ignore);
      return false;
    }
    workflowScopes.set(row.id, scope);
    // Replaying the thread's task updates from the start tells the script which of
    // its agents already finished.
    yield* workflowRunner.launch({
      workflowId: row.id,
      ...(row.workflow === undefined ? {} : { previousWorkflow: row.workflow }),
      threadId: row.threadId,
      source: stored.value.source,
      args: stored.value.args,
      ...(Option.isSome(workflowPresets) ? { workflowPresets: workflowPresets.value } : {}),
      ...(Option.isSome(presetTargets) ? { presetTargets: presetTargets.value } : {}),
      ...(Option.isSome(workerTargetSnapshot) && "target" in workerTargetSnapshot.value
        ? { workerTarget: workerTargetSnapshot.value.target }
        : stored.value.workerTarget === undefined
          ? {}
          : { workerTarget: stored.value.workerTarget }),
      ...(Option.isSome(workerTargetSnapshot) && "error" in workerTargetSnapshot.value
        ? { workerTargetError: workerTargetSnapshot.value.error }
        : {}),
      ...(Option.isSome(callerSelection) ? { callerSelection: callerSelection.value } : {}),
      ...(stored.value.budgetTokens === undefined
        ? {}
        : { budgetTokens: stored.value.budgetTokens }),
      ...(Option.isSome(plan) ? { plan: plan.value } : {}),
      afterSequence,
    });
    return true;
  });

  const resumeWorkflows = Effect.gen(function* () {
    let resumed = 0;
    for (const threadId of yield* threadManagement.getAppWorkflowThreadIds) {
      const { subagents } = yield* threadManagement.getThreadRecords(threadId, ["subagents"]);
      for (const row of subagents) {
        if (
          row.origin !== "app_owned" ||
          row.workflow === undefined ||
          row.childThreadId !== null ||
          row.status !== "running" ||
          workflowRunner.isRunning(row.id)
        ) {
          continue;
        }
        if (yield* resumeWorkflow(row)) resumed += 1;
      }
    }
    return resumed;
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Unable to resume workflows after a restart", { cause }).pipe(Effect.as(0)),
    ),
  );

  // Workflows a stop left running resume once recovery has settled the agents the
  // stop cancelled, so those count as cancelled by the restart.
  const startup = yield* Effect.serviceOption(ServerRuntimeStartup.ServerRuntimeStartup);
  if (startup._tag === "Some") {
    yield* startup.value.awaitCommandReady.pipe(
      Effect.andThen(resumeWorkflows),
      Effect.ignore,
      Effect.forkDetach,
    );
  }
  yield* Effect.addFinalizer(() => workflowRunner.detachAll);

  const stopWorkflowById = Effect.fn("OrchestratorMcpService.stopWorkflowById")(function* (
    scope: McpThreadInvocationScope,
    workflowId: NodeId,
  ) {
    yield* threadManagement
      .stopWorkflow({ threadId: scope.thread.threadId, subagentId: workflowId })
      .pipe(
        Effect.catchIf(
          (error) => error.reason === "not-running",
          () => Effect.void,
        ),
        Effect.mapError((error) => failure("orchestration_error", error.message)),
      );
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(
    function* (scope: McpThreadInvocationScope, taskId: NodeId, _timeoutMs: number) {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // Sequences are global, so one cursor taken before the first read
      // replays anything either thread records after it.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      return yield* Stream.mergeAll(
        TASK_WAKE_EVENTS.map(({ thread, eventType }) =>
          threadManagement.streamStoredEventsFrom({
            threadId: thread === "parent" ? scope.thread.threadId : initial.childThreadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter(endsTaskWait),
        Stream.runHead,
      );
    },
    (effect, _scope, _taskId, timeoutMs) =>
      effect.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten)),
  );

  const scheduledTaskRunModes = Effect.fn("OrchestratorMcpService.scheduledTaskRunModes")(
    function* (task: ScheduledTask) {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    },
  );

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Its webhook URL starts runs, so only a caller that may start one sees it: never a client
   * approved for read-only access, and a thread caller only with a live turn, at modes covering
   * every mode the task runs at.
   */
  const summarizeScheduledTask = Effect.fn("OrchestratorMcpService.summarizeScheduledTask")(
    function* (
      scope: McpInvocationScope,
      caller: {
        readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
        readonly limits: {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        };
      },
      task: ScheduledTask,
    ) {
      const live =
        caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    },
  );

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = Effect.fn("OrchestratorMcpService.loadScheduledTask")(function* (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.fn.Return<ScheduledTask, OrchestratorMcpFailure> {
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
        ),
      );
    const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
    if (task === undefined) {
      return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
    }
    for (const modes of yield* scheduledTaskRunModes(task)) {
      yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
    }
    return task;
  });

  return OrchestratorMcpService.of({
    resumeWorkflows,
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      yield* assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (parent !== undefined && parent.thread.projectId === projectId);
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a T3 thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
      const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
      const title =
        input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        workspaceStrategy: scheduledTaskWorkspaceStrategy(bindToCurrentThread),
        modelSelection,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
        // Scope the idempotency key by provider session so two callers
        // reusing the same clientRequestId cannot collide on one task row.
        ...(input.clientRequestId === undefined
          ? {}
          : {
              commandId: stableCommandId({
                scope,
                requestKey: input.clientRequestId,
                operation: "schedule-task",
              }),
            }),
      };
      const { task } = yield* scheduledTasks
        .upsert(upsertInput)
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not schedule task: ${error.message}`),
          ),
        );
      return yield* summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    listScheduledTasks: Effect.fn("OrchestratorMcpService.listScheduledTasks")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        return {
          tasks: yield* Effect.forEach(
            tasks.filter((task) => projectId === undefined || task.projectId === projectId),
            (task) => summarizeScheduledTask(scope, { parent, limits }, task),
          ),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a T3 thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Rebinding changes where runs execute, so the workspace strategy must
        // follow: unbinding a root-strategy task would otherwise run loose
        // prompts in the shared project checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : scheduledTaskWorkspaceStrategy(input.bindToCurrentThread);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      },
    ),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      },
    ),
    requestSecret: Effect.fn("OrchestratorMcpService.requestSecret")(function* (scope, input) {
      const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "request_secret");
      const threadId = threadScope.thread.threadId;
      const run = ThreadManagementService.latestActiveRun(parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== threadScope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Asking for a secret requires an active run owned by this MCP provider session.",
        );
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const key = yield* requestKey(input.clientRequestId);
      const turnItemId = TurnItemId.make(
        `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
      );
      const record = (secretStatus: "pending" | "cancelled") =>
        threadManagement
          .dispatch({
            type: "secret_request.record",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: `secret-${secretStatus}`,
            }),
            threadId: threadId,
            runId,
            nodeId,
            turnItemId,
            label: input.label,
            reason: input.reason,
            ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
            secretStatus,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Could not record the secret request: ${errorMessage(error)}`,
              ),
            ),
          );
      yield* record("pending");
      // Only this call can hand the agent its ref, so the card must not
      // outlive it: a timeout, a failed wait or an aborted call closes it as
      // cancelled.
      const closeCard = record("cancelled").pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not close a secret request card", { error: error.message }),
        ),
      );

      const answered = yield* Effect.gen(function* () {
        while (true) {
          const projection = yield* threadManagement
            .getThreadRecords(threadId, ["runs", "turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to read the secret request: ${errorMessage(error)}`,
                ),
              ),
            );
          const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
          if (item?.type === "secret_request" && item.secretStatus !== "pending") {
            return item.secretStatus;
          }
          const current = projection.runs.find((candidate) => candidate.id === runId);
          if (
            current === undefined ||
            ThreadManagementService.isTerminalRunStatus(current.status)
          ) {
            yield* record("cancelled");
            return "cancelled" as const;
          }
          yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
        }
      }).pipe(
        Effect.timeoutOption(
          Duration.millis(
            Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
          ),
        ),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
      );
      if (Option.isNone(answered)) yield* closeCard;
      const status = Option.isSome(answered)
        ? answered.value
        : yield* threadManagement
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.map((records) => {
                const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
                return item?.type === "secret_request" &&
                  (item.secretStatus === "saved" || item.secretStatus === "declined")
                  ? item.secretStatus
                  : ("timed_out" as const);
              }),
              Effect.orElseSucceed(() => "timed_out" as const),
            );
      yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
      if (status !== "saved") return { status };
      const secretRef = yield* secretRequests.savedRef({ threadId: threadId, turnItemId });
      if (Option.isNone(secretRef)) {
        return yield* failure(
          "orchestration_error",
          "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
        );
      }
      return { status, secretRef: secretRef.value };
    }),

    capabilities: Effect.fn("OrchestratorMcpService.capabilities")(function* (scope, input = {}) {
      const { parent, limits } = yield* loadCaller(scope);
      const providers = yield* loadProviders;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inherited = parent?.thread.modelSelection;
      const searchTerms = input.search?.toLowerCase().split(/\s+/) ?? [];
      return {
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: inherited?.instanceId ?? null,
        inheritedModel: inherited?.model ?? null,
        inheritedOptions: inherited?.options ?? [],
        workflowPresets: settings.workflowPresets,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: providers.map((provider) => {
          const constraints = providerConstraints(
            provider,
            orchestrationCapableInstanceIds.has(provider.instanceId),
          );
          const { listed, omitted } = listCapabilityModels({
            provider,
            preferences: settings.providerModelPreferences?.[provider.instanceId],
            searchTerms,
            isPinned: (model) =>
              model.isCustom ||
              (inherited?.instanceId === provider.instanceId && inherited.model === model.slug) ||
              (settings.favorites ?? []).some(
                (favorite) =>
                  favorite.provider === provider.instanceId && favorite.model === model.slug,
              ),
          });
          return {
            providerInstanceId: provider.instanceId,
            driverKind: provider.driver,
            displayName: provider.displayName ?? null,
            models: listed.map((model) => {
              const options = model.capabilities?.optionDescriptors ?? [];
              return {
                id: model.slug,
                ...(model.name.toLowerCase() === model.slug.toLowerCase()
                  ? {}
                  : { label: model.name }),
                ...(options.length === 0 ? {} : { options: options.map(capabilityModelOption) }),
              };
            }),
            ...(omitted === 0 ? {} : { omittedModels: omitted }),
            ...(provider.supportedRuntimeModes === undefined ||
            provider.supportedRuntimeModes.length === 0
              ? {}
              : { runtimeModes: [...provider.supportedRuntimeModes] }),
            canRunChildTask: constraints.length === 0,
            canRunCrossProviderChildTask: constraints.length === 0,
            constraints: [...constraints],
          };
        }),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 20,
        },
      };
    }),
    delegateTask: Effect.fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {
      const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
      const parentRun = yield* requireDelegatingRun(scope, parent);
      const providers = yield* loadProviders;
      const key = yield* requestKey(input.clientRequestId);
      const prepared = yield* prepareDelegation({
        scope,
        parent,
        providers,
        item: input,
        requestKey: key,
        parentCommit: yield* makeParentCommitResolver(parent),
      });
      const { taskId } = yield* dispatchDelegation({
        scope,
        parentRun,
        prepared,
        // Async delegations wake the parent on every child terminal; wait
        // delegations deliver through the blocking tool call, so a wake is
        // only needed if the parent settled first (timeout, disconnect).
        completionWake: input.mode === "wait" ? "settled_only" : "always",
      });

      if (input.mode !== "wait") {
        return yield* readTask(scope, taskId, false, true);
      }
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const waited = yield* waitForTask(scope, taskId, timeoutMs);
      if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
        return waited.value;
      }
      // An incomplete wait gives up delivery: upgrade so a later terminal
      // wakes the parent even mid-turn.
      yield* threadManagement
        .dispatch({
          type: "delegated_task.wake-policy",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "delegate-task-wake-policy",
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          completionWake: "always",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome:
                error._tag === "OrchestratorCommandPreviouslyRejectedError"
                  ? "previously_rejected"
                  : "dispatch_failed",
              error,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome: "defect",
              cause,
            }),
          ),
        );
      return yield* readTask(scope, taskId, Option.isNone(waited), true);
    }),
    delegateTasks: Effect.fn("OrchestratorMcpService.delegateTasks")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_tasks");
        const parentRun = yield* requireDelegatingRun(scope, parent);
        const providers = yield* loadProviders;
        const batchKey = yield* requestKey(input.clientRequestId);
        const parentCommit = yield* makeParentCommitResolver(parent);
        // Every task is checked before any starts, so a bad entry starts nothing.
        const prepared = yield* Effect.forEach(input.tasks, (item, index) =>
          prepareDelegation({
            scope,
            parent,
            providers,
            item,
            requestKey: item.clientRequestId ?? `${batchKey}:${index}`,
            parentCommit,
          }).pipe(
            Effect.mapError((error) => failure(error.code, `tasks[${index}]: ${error.message}`)),
          ),
        );
        const tasks: Array<OrchestratorMcpDelegatedTaskStart> = [];
        for (const [index, item] of prepared.entries()) {
          const started = yield* dispatchDelegation({
            scope,
            parentRun,
            prepared: item,
            completionWake: "always",
          }).pipe(
            Effect.mapError((error) =>
              failure(
                error.code,
                `tasks[${index}]: ${error.message} Tasks before it started; retrying with the same clientRequestId starts only the rest.`,
              ),
            ),
          );
          tasks.push({
            taskId: started.taskId,
            childThreadId: started.childThreadId,
            status: started.queued ? "queued" : "running",
            providerInstanceId: item.target.modelSelection.instanceId,
            model: item.target.modelSelection.model,
          });
        }
        return { tasks };
      },
    ),
    workflowStart: Effect.fn("OrchestratorMcpService.workflowStart")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "workflow_start");
        return yield* startWorkflow(scope, parent, input);
      },
    ),
    graphReview: Effect.fn("OrchestratorMcpService.graphReview")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "graph_review");
      yield* requireCapability(scope);
      const { review } = yield* reviewCallerGraph(
        yield* loadProjection(scope.thread.threadId),
        input.graph,
        input.workerTarget,
      );
      return graphReviewResult(review);
    }),
    graphStart: Effect.fn("OrchestratorMcpService.graphStart")(function* (callerScope, input) {
      const { scope, parent } = yield* loadThreadCaller(callerScope, "graph_start");
      const { review, compiled } = yield* reviewCallerGraph(
        parent,
        input.graph,
        input.workerTarget,
      );
      if (review.blockers.length > 0 || compiled === undefined) {
        return yield* failure(
          "invalid_request",
          `The graph has blockers: ${review.blockers.join("; ")}`,
        );
      }
      if (review.digest !== input.acceptedDigest) {
        const changed = changedGraphInputs(input.acceptedDigest, review.inputs);
        return yield* failure(
          "invalid_request",
          changed === undefined
            ? // Reviews live in memory, so a restart forgets them; the digest alone cannot say what changed.
              "Review not found: no review with that digest is on record (reviews do not survive a server restart), and the graph or its input files no longer match it. Run graph_review again."
            : changed.length > 0
              ? `Input files changed since review: ${changed.join(", ")}. Review the graph again.`
              : "The graph changed since review (digest mismatch); review it again.",
        );
      }
      return yield* startWorkflow(
        scope,
        parent,
        {
          script: compiled.source,
          args: compiled.args,
          title: input.title ?? compiled.title,
          ...(input.budgetTokens === undefined ? {} : { budgetTokens: input.budgetTokens }),
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        },
        compiled.plan,
      );
    }),
    workflowStatus: Effect.fn("OrchestratorMcpService.workflowStatus")(
      function* (callerScope, input) {
        const scope = yield* requireThreadScope(callerScope, "workflow_status");
        yield* requireCapability(scope);
        const projection = yield* loadProjection(scope.thread.threadId);
        const workflow = findWorkflow(projection, input.workflowId);
        if (workflow === undefined) {
          return yield* failure(
            "task_not_found",
            `Workflow ${input.workflowId} does not belong to thread ${scope.thread.threadId}.`,
          );
        }
        return yield* workflowResult(projection, workflow);
      },
    ),
    workflowStop: Effect.fn("OrchestratorMcpService.workflowStop")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "workflow_stop");
      yield* requireCapability(scope);
      if (
        findWorkflow(yield* loadProjection(scope.thread.threadId), input.workflowId) === undefined
      ) {
        return yield* failure(
          "task_not_found",
          `Workflow ${input.workflowId} does not belong to thread ${scope.thread.threadId}.`,
        );
      }
      yield* stopWorkflowById(scope, input.workflowId);
      const projection = yield* loadProjection(scope.thread.threadId);
      return yield* workflowResult(projection, findWorkflow(projection, input.workflowId)!);
    }),
    taskWait: Effect.fn("OrchestratorMcpService.taskWait")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "task_wait");
      const taskIds = [...new Set(input.taskIds)];
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const streamError = (error: unknown) =>
        failure("orchestration_error", `Unable to watch delegated tasks: ${errorMessage(error)}`);
      // Taken before the first reads, so an update between a read and the
      // stream's start is replayed rather than missed.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const latest = new Map<NodeId, OrchestratorMcpDelegateTaskResult>();
      const read = (taskId: NodeId) =>
        readTask(scope, taskId, false, true).pipe(
          Effect.tap((result) => Effect.sync(() => latest.set(taskId, result))),
        );
      const isReady = (taskId: NodeId) => {
        const result = latest.get(taskId);
        return result !== undefined && endsTaskWait(result);
      };
      const satisfied = () =>
        input.mode === "any" ? taskIds.some(isReady) : taskIds.every(isReady);
      yield* Effect.forEach(taskIds, read, { discard: true });
      // Status changes reach this thread's subagent rows; questions and
      // approvals arrive as runtime requests on each child thread.
      const taskByChild = new Map(
        taskIds.map((taskId) => [latest.get(taskId)!.childThreadId as string, taskId]),
      );
      const updates = Stream.mergeAll(
        [
          threadManagement
            .streamStoredEventsFrom({
              threadId: scope.thread.threadId,
              afterSequence,
              // Workflows cannot be waited on here (readTask refuses them), so only delegated
              // task rows matter; filtering keeps transcript events out of this stream.
              eventType: "subagent.updated",
            })
            .pipe(
              Stream.map((stored) =>
                stored.event.type === "subagent.updated" ? stored.event.payload.id : undefined,
              ),
            ),
          ...[...taskByChild].map(([childThreadId, taskId]) =>
            threadManagement
              .streamStoredEventsFrom({
                threadId: ThreadId.make(childThreadId),
                afterSequence,
                eventType: "runtime-request.updated",
              })
              .pipe(Stream.map(() => taskId)),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const timedOut = satisfied()
        ? false
        : Option.isNone(
            yield* updates.pipe(
              Stream.mapError(streamError),
              Stream.filter(
                (taskId): taskId is NodeId =>
                  taskId !== undefined && taskIds.includes(taskId) && !isReady(taskId),
              ),
              Stream.mapEffect(read),
              Stream.filter(satisfied),
              Stream.runHead,
              Effect.timeoutOption(Duration.millis(timeoutMs)),
              Effect.map(Option.flatten),
            ),
          );
      return {
        ready: taskIds.filter(isReady).map((taskId) => {
          const result = latest.get(taskId)!;
          return {
            taskId,
            childThreadId: result.childThreadId,
            status: result.status,
            summary: result.summary,
            ...(result.structuredResult === undefined
              ? {}
              : { structuredResult: result.structuredResult }),
            ...(result.structuredResultError === undefined
              ? {}
              : { structuredResultError: result.structuredResultError }),
            hasPendingQuestion: result.hasPendingQuestion,
            pendingApproval: result.pendingApproval,
          };
        }),
        pending: taskIds
          .filter((taskId) => !isReady(taskId))
          .map((taskId) => {
            const result = latest.get(taskId)!;
            return { taskId, status: result.status, workState: result.workState };
          }),
        timedOut,
      } satisfies OrchestratorMcpTaskWaitResult;
    }),
    taskStatus: Effect.fn("OrchestratorMcpService.taskStatus")(function* (callerScope, taskId) {
      const scope = yield* requireThreadScope(callerScope, "task_status");
      return yield* readTask(scope, taskId, false, true);
    }),
    cancelTask: Effect.fn("OrchestratorMcpService.cancelTask")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "task_cancel");
      const owner = yield* loadProjection(scope.thread.threadId);
      if (findWorkflow(owner, input.taskId) !== undefined) {
        yield* stopWorkflowById(scope, input.taskId);
        const stopped = findWorkflow(yield* loadProjection(scope.thread.threadId), input.taskId);
        return {
          taskId: input.taskId,
          status:
            stopped?.status === "completed" || stopped?.status === "failed"
              ? stopped.status
              : "cancelled",
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      const current = yield* readTask(scope, input.taskId);
      const key = yield* requestKey(input.clientRequestId);
      const parentProjection = yield* loadProjection(scope.thread.threadId);
      // Cancelling stops the child and every task under it, each a write to a
      // thread its user may have raised above the parent's modes since it was
      // delegated. All of them are checked before anything is stopped.
      const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<void, OrchestratorMcpFailure> {
        const shell = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (shell !== null && shell.deletedAt === null) {
          yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
          yield* resolveInteractionMode(
            parentProjection.thread.interactionMode,
            shell.interactionMode,
          );
        }
        const { subagents } = yield* threadManagement
          .getThreadRecords(threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const task of subagents) {
          if (task.origin === "app_owned" && task.childThreadId !== null) {
            yield* assertStoppable(task.childThreadId);
          }
        }
      });
      yield* assertStoppable(current.childThreadId);
      const parentTask = parentProjection.subagents.find(
        (task) => task.id === input.taskId && task.origin === "app_owned",
      );
      const disposeCompletionDelivery =
        parentTask?.completionDelivery?.state === "disposed"
          ? Effect.void
          : threadManagement
              .dispatch({
                type: "delegated_task.completion-delivery.dispose",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: "cancel-task-completion-delivery",
                }),
                parentThreadId: scope.thread.threadId,
                taskId: input.taskId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                  ),
                ),
              );
      const stopChild = Effect.gen(function* () {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
        const reason = input.reason;
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: current.childThreadId,
            stopDelegatedTasks: false,
            ...(reason === undefined ? {} : { reason }),
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
        yield* threadManagement
          .stopDelegatedTasks({ threadId: current.childThreadId, commandId, reason })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
              ),
            ),
          );
        const stopped = yield* threadManagement
          .getThreadRecords(current.childThreadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const run of stopped.runs) {
          if (
            run.status !== "queued" ||
            (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
          )
            continue;
          // Stop preserves the queue for Resume. Cancelling a task must also
          // remove that task's queued turn, including a previously held one.
          yield* threadManagement
            .dispatch({
              type: "queued-run.cancel",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `cancel-task-queued-run:${run.id}`,
              }),
              threadId: current.childThreadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
        }
      });
      // Checked above; a user raising one of these threads meanwhile is
      // caught again under that thread's lock, which leaves it running.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stopWithinLimit = stopChild.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: parentProjection.thread.runtimeMode,
          interactionMode: parentProjection.thread.interactionMode,
          refused,
        }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail(
              refusal === undefined
                ? error
                : failure(
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                    `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                  ),
            ),
          ),
        ),
      );
      // A follow-up that lost its child run (#19002) stays running on the parent, while its
      // status here comes from the child's last run. Stop on the parent cancels that task.
      const cancelOrphan = Effect.gen(function* () {
        if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
          return false;
        yield* threadManagement
          .dispatch({
            type: "subagent.stop",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "cancel-task-orphan",
            }),
            threadId: scope.thread.threadId,
            runId: parentTask.runId,
            subagentId: parentTask.id,
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const { subagents } = yield* threadManagement
          .getThreadRecords(scope.thread.threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
      });
      if (isTerminalTaskStatus(current.status)) {
        // The child can still run work for another turn, so it is stopped either way.
        yield* stopWithinLimit;
        const cancelled = yield* cancelOrphan;
        yield* disposeCompletionDelivery;
        return {
          taskId: input.taskId,
          status: cancelled ? "cancelled" : current.status,
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      const child = yield* loadProjection(current.childThreadId);
      if (
        current.workState !== "waiting_for_children" &&
        ThreadManagementService.latestActiveRun(child) === undefined &&
        !child.runs.some(
          (run) =>
            run.status === "queued" &&
            (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
        )
      ) {
        if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" };
        return yield* failure(
          "task_not_cancellable",
          `Delegated task ${input.taskId} has no interruptible child run.`,
        );
      }
      yield* stopWithinLimit;
      yield* disposeCompletionDelivery.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
            taskId: input.taskId,
            cause,
          }),
        ),
      );
      return {
        taskId: input.taskId,
        status: "cancel_requested",
      };
    }),
    createThreads: Effect.fn("OrchestratorMcpService.createThreads")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
        const parentRun = ThreadManagementService.latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const isRetryOfAcceptedCreation = yield* threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* assertTargetEnabledForProject(parent, commandId, target);
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "record-created-thread",
                    index,
                  }),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      },
    ),
    listThreads: Effect.fn("OrchestratorMcpService.listThreads")(function* (scope, input) {
      const { parent } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      const projectThreads = yield* threadManagement
        .listProjectThreads({
          projectId,
          includeSubagents: input.includeSubagents !== false,
        })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
          ),
        );
      const nowMs = yield* Clock.currentTimeMillis;
      const statuses = input.statuses === undefined ? null : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const filtered = projectThreads
        .filter(
          (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
        )
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
      return {
        projectId,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.map((shell) => listItemFromShell(shell, nowMs)),
        nextCursor,
        total: filtered.length,
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(function* (scope, input) {
      const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
      const view = input.view ?? "messages";
      const afterPosition = input.afterPosition ?? -1;
      const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
      const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
      const timeline = yield* threadManagement
        .getTimelinePage(input.threadId, {
          afterPosition,
          limit,
          view,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const page = timeline.items;
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const row of page) {
        if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
        const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
        ids.push(row.item.messageId);
        messageIdsByThread.set(row.sourceThreadId, ids);
      }
      const sourceMessages = yield* Effect.forEach(
        [...messageIdsByThread],
        ([threadId, messageIds]) =>
          threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
            Effect.map((records) => [threadId, records.messages] as const),
            Effect.mapError(threadManagementFailure),
          ),
        { concurrency: 1 },
      );
      const messagesByThreadId = new Map(sourceMessages);
      const returnedRunIds = new Set(
        page.filter((row) => row.sourceThreadId === target.thread.id).map((row) => row.item.runId),
      );
      const tasks =
        parent === undefined ? [] : directAppOwnedChildTasks(parent, target, returnedRunIds);
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        tasks.length > 0 &&
        (input.textOffset ?? 0) === 0
      ) {
        for (const task of tasks) {
          const transfer = taskResultTransfer(parent, target, task);
          const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
          const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
          const resultRecords = yield* threadManagement
            .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: resultRunIds,
              turnItemRunIds: resultRunIds,
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesTerminalTaskResult({
              parent,
              page,
              task,
              target: { ...target, ...resultRecords },
              maxChars,
            })
          ) {
            yield* readTask(
              scope as McpThreadInvocationScope,
              task.id,
              false,
              true,
              "thread-read-acknowledge",
            );
          }
        }
      }
      return {
        thread: threadDetail(target, timeline.totalItems, shell, yield* Clock.currentTimeMillis),
        recentRuns: target.runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
          .map(threadRun),
        items: page.map((row) =>
          timelineItem({
            row,
            maxChars,
            messagesByThreadId,
            ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
          }),
        ),
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: timeline.hasMore,
      } satisfies OrchestratorMcpThreadReadResult;
    }),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

      const mode = input.mode ?? "auto";
      const key = yield* requestKey(input.clientRequestId);
      const messageId = stableOperationMessageId({
        scope,
        requestKey: key,
        operation: "thread-send",
      });
      const result = yield* threadManagement
        .sendToThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-send",
          }),
          threadId: input.threadId,
          ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
          messageId,
          text: input.message,
          attachments: [],
          mode,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to send to thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                ),
          ),
        );
      return {
        threadId: input.threadId,
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      } satisfies OrchestratorMcpThreadSendResult;
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const { target } = yield* loadScopedThread(scope, input.threadId);
      const result = yield* threadManagement
        .waitForThread({
          projectId: target.thread.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          timeoutMs: Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          ),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status: result.run === null ? "idle" : runOutcome(result.run),
        timedOut: result.timedOut,
      } satisfies OrchestratorMcpThreadWaitResult;
    }),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      const key = yield* requestKey(input.clientRequestId);
      const result = yield* threadManagement
        .interruptThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-interrupt",
          }),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                ),
          ),
        );
      if (result.type === "no_active_run") {
        return {
          threadId: input.threadId,
          runId: null,
          status: "no_active_run",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
      } satisfies OrchestratorMcpThreadInterruptResult;
    }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | ServerSettings.ServerSettingsService
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
> = Layer.effect(OrchestratorMcpService, make).pipe(Layer.provide(ProcessRunner.layer));

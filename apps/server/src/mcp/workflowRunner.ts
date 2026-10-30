/**
 * Runs T3 workflows: a sandboxed script whose agent() calls become ordinary
 * delegated tasks of the calling thread, owned by the workflow row instead of a
 * live run. The row's `workflow` field carries progress; the orchestrator
 * delivers one completion when the runner reports the script's outcome.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- agent keys are hashed synchronously inside QuickJS host callbacks.
import * as NodeCrypto from "node:crypto";
import { mergeWorkflowPatch, workflowPatches } from "@t3tools/shared/workflowUpdate";
import { workflowRecordedUsage } from "@t3tools/shared/workflowBudget";

import type { workflowExecutionTiming } from "./workflowUsage.ts";
import {
  CommandId,
  type NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  OrchestrationV2WorkflowNodeOutcome,
  type OrchestrationV2WorkflowPlan,
  OrchestratorMcpDelegateTasksItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type OrchestratorMcpFailure,
  type ThreadId,
  type WorkflowAgentOutcomeCategory,
  type OrchestratorMcpWorkflowUsage,
  type ModelSelection,
  type WorkflowPresets,
  type WorkflowPresetTarget,
  type OrchestratorMcpTarget,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { freshCommandId, isCommandIdSpent } from "../orchestration-v2/WorkflowCommandRetry.ts";
import {
  type CheckOutcome,
  type FileRef,
  fileInstructions,
  type ProducedFile,
  type WorkspaceFile,
  type FileScopes,
  parseCheck,
  parseFileRefs,
  parseScopes,
  type ProcessCheck,
  scopeInstructions,
  scopesOverlap,
  type WorkflowCheck,
  withoutProducer,
} from "./workflowChecks.ts";
import {
  boundText,
  completionResult,
  taskOutputAt,
  HANDOFF_SUMMARY_BYTES,
  resultContract,
  type HandoffInput,
} from "./workflowHandoff.ts";
import {
  type AgentAttemptHost,
  type MutableAgent,
  agentAttemptKey,
  runAttempts,
  TERMINAL_TASK_STATUSES,
} from "./workflowAgentAttempts.ts";
import { GRAPH_DRIVER_SCRIPT } from "./workflowGraph.ts";
import { MAX_AGENT_ATTEMPTS, MAX_AGENTS_PER_WORKFLOW } from "./workflowLimits.ts";
import { WorkflowPhases } from "./workflowPhases.ts";
import { workflowPlannedIdentity } from "./workflowPlannedIdentity.ts";
import { runWorkflowScript, type WorkflowScriptHost } from "./workflowScript.ts";
import { stopStalledAgents, type WaitingAgent } from "./workflowSweep.ts";

/** Per-attempt deadlines: at least a minute, at most the omx graph's "long" budget of 6 h. */
const MIN_ATTEMPT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPT_TIMEOUT_MS = 6 * 60 * 60_000;
const STALL_SWEEP_INTERVAL = "30 seconds";
const PREVIEW_LIMIT = 500;
/** A failed workflow.complete is sent again after a pause that doubles from 1 s up to 30 s. */
const COMPLETION_RETRY_MIN_MS = 1_000;
const COMPLETION_RETRY_MAX_MS = 30_000;

export interface WorkflowContext {
  readonly workflowId: NodeId;
  readonly threadId: ThreadId;
  readonly source: string;
  readonly args: unknown;
  readonly workerTarget?: unknown;
  readonly workerTargetError?: string;
  readonly workflowPresets?: WorkflowPresets;
  readonly presetTargets?: Readonly<
    Record<string, { readonly target: OrchestratorMcpTarget } | { readonly error: string }>
  >;
  readonly callerSelection?: ModelSelection;
  /** New agents stop starting once recorded child usage reaches this limit. */
  readonly budgetTokens?: number;
  /** Stored event sequence before the workflow row was created. */
  readonly afterSequence: number;
  /** The reviewed graph's plan; only then may the script tag agents and record node outcomes. */
  readonly plan?: OrchestrationV2WorkflowPlan;
  readonly previousWorkflow?: OrchestrationV2SubagentWorkflow;
}

export interface WorkflowPreference {
  readonly presetId: string;
  readonly presetName: string;
  readonly entries: ReadonlyArray<WorkflowPresetTarget>;
}

/**
 * Whether two profile entries are the same choice: provider instance, model and options. An
 * entry without `options` inherits the caller's, so it is not the same as one with `options: []`.
 */
export function sameWorkflowPresetTarget(
  a: WorkflowPresetTarget,
  b: WorkflowPresetTarget,
): boolean {
  if (a.providerInstanceId !== b.providerInstanceId || a.model !== b.model) return false;
  const left = a.options;
  const right = b.options;
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (option, index) => option.id === right[index]!.id && option.value === right[index]!.value,
    )
  );
}

/** A profile's model preference order: its primary target, then its fallbacks. */
export function presetPreference(preset: WorkflowPresets["presets"][number]): WorkflowPreference {
  return {
    presetId: preset.id,
    presetName: preset.name,
    entries: [preset.target, ...(preset.fallbacks ?? [])],
  };
}

/**
 * Select one whole request before the provider resolver applies caller inheritance. A preset
 * without a frozen snapshot also reports its `preference` order, whose first entry is `target`;
 * a snapshot is the resolved choice and carries no order, so a resume never re-reads one.
 */
export function selectWorkflowTarget(
  own: {
    readonly target?: unknown;
    readonly model?: string | undefined;
    readonly preset?: unknown;
  },
  workerTarget?: unknown,
  presets?: WorkflowPresets,
  snapshots?: WorkflowContext["presetTargets"],
): {
  readonly target: unknown;
  readonly plannedTarget?: unknown;
  readonly source: "target" | "model" | "preset" | "workerTarget" | "defaultPreset" | "caller";
  readonly error?: string;
  readonly preference?: WorkflowPreference;
} {
  if (own.target !== undefined) return { target: own.target, source: "target" };
  if (own.model !== undefined) return { target: { model: own.model }, source: "model" };
  if (own.preset !== undefined && (typeof own.preset !== "string" || !own.preset.trim())) {
    return {
      target: undefined,
      source: "preset",
      error: "Workflow preset must be a non-empty id.",
    };
  }
  const presetId =
    own.preset ?? (workerTarget === undefined ? presets?.defaultPresetId : undefined);
  if (presetId !== undefined && presetId !== null) {
    const source = own.preset !== undefined ? "preset" : "defaultPreset";
    const preset = presets?.presets.find((preset) => preset.id === presetId);
    if (preset === undefined)
      return {
        target: undefined,
        source,
        error: `Workflow preset ${String(presetId)} was not found.`,
      };
    const snapshot = snapshots?.[preset.id];
    if (snapshot !== undefined)
      return {
        target: "target" in snapshot ? snapshot.target : undefined,
        plannedTarget: preset.target,
        source,
        ...("error" in snapshot ? { error: snapshot.error } : {}),
      };
    return { target: preset.target, source, preference: presetPreference(preset) };
  }
  if (workerTarget !== undefined) return { target: workerTarget, source: "workerTarget" };
  return { target: undefined, source: "caller" };
}

export interface WorkflowAgentStart {
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
  readonly model: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}

export interface WorkflowAgentOutcome {
  readonly timing?: ReturnType<typeof workflowExecutionTiming> | undefined;
  readonly status: string;
  readonly summary: string | null;
  readonly structuredResult?: unknown;
  readonly structuredResultError?: string;
  /** The server stopped or restarted under it, so a new attempt is not a repeat of a judgment. */
  readonly cancelledByServerRestart: boolean;
  readonly outcomeCategory: WorkflowAgentOutcomeCategory | null;
  readonly usage: OrchestratorMcpWorkflowUsage;
}

/** Terminal task facts shared by live reads and persisted status after restart.
 * Deadlines and check judgments are owned by the runner and persisted on its entry.
 */
export function workflowAgentOutcomeCategory(input: {
  readonly status: string;
  readonly started: boolean;
  readonly checkFailed?: boolean;
}): WorkflowAgentOutcomeCategory | null {
  if (!TERMINAL_TASK_STATUSES.has(input.status)) return null;
  if (!input.started) return "never_started";
  if (input.status === "cancelled" || input.status === "interrupted") return "cancelled";
  if (input.checkFailed) return "check_failed";
  return input.status === "completed" ? "completed" : "provider_error";
}

/** What agent(prompt, { report: true }) resolves to, failed or not. */
interface AgentReport {
  readonly ok: boolean;
  readonly result: unknown;
  readonly attempts: number;
  readonly outputs: Readonly<Record<string, ProducedFile>>;
  readonly verification: {
    readonly type: string;
    readonly outcome: string;
    readonly attempts: number;
    readonly detail: string | null;
  } | null;
  readonly reason: string | null;
}

export interface WorkflowRunnerDeps {
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  /** Derives the dispatcher's task identity without preparing or starting the delegation. */
  readonly agentTaskId: (workflow: WorkflowContext, requestKey: string) => NodeId | undefined;
  /** Recovers a logical request key only from a canonical task ID in this workflow's namespace. */
  readonly agentRequestKey: (workflow: WorkflowContext, taskId: string) => string | undefined;
  readonly spawnAgent: (
    workflow: WorkflowContext,
    item: OrchestratorMcpDelegateTasksItem,
    requestKey: string,
  ) => Effect.Effect<WorkflowAgentStart, OrchestratorMcpFailure>;
  readonly awaitAgent: (
    workflow: WorkflowContext,
    taskId: NodeId,
    onUpdate: (outcome: WorkflowAgentOutcome) => void,
  ) => Effect.Effect<WorkflowAgentOutcome, OrchestratorMcpFailure>;
  /** Whether an agent with this retry key was already started, by this run or an earlier one. */
  readonly agentStarted: (
    workflow: WorkflowContext,
    requestKey: string,
  ) => Effect.Effect<boolean, OrchestratorMcpFailure>;
  /** Whether agents of this workflow may run commands: the caller must run in full access. */
  readonly canRunCommands: (
    workflow: WorkflowContext,
  ) => Effect.Effect<boolean, OrchestratorMcpFailure>;
  /**
   * Runs a process check in the agent's workspace; `result` backs the {{result}} token and
   * `files` maps `input:<id>` and `output:<id>` tokens to workspace-relative paths.
   */
  readonly runCommandCheck: (
    workflow: WorkflowContext,
    childThreadId: ThreadId,
    check: ProcessCheck,
    result: string,
    files: Readonly<Record<string, string>>,
  ) => Effect.Effect<CheckOutcome, OrchestratorMcpFailure>;
  /** Reads and hashes a workspace-relative file in the caller's checkout, at most `maxBytes`. */
  readonly readWorkspaceFile: (
    workflow: WorkflowContext,
    path: string,
    maxBytes: number,
  ) => Effect.Effect<WorkspaceFile, OrchestratorMcpFailure>;
  /**
   * Stores an agent's answer as a new file in a folder the server owns, outside every checkout, and
   * returns its absolute path. A checker is a sibling of the agent it judges and cannot read that
   * agent's task, so a cut copy of the answer points here instead. Each call makes its own file.
   */
  readonly writeCheckerResult: (
    workflow: WorkflowContext,
    taskId: NodeId,
    text: string,
  ) => Effect.Effect<string, OrchestratorMcpFailure>;
  /** Removes the one file `writeCheckerResult` made at `path`; never a folder or another file. */
  readonly removeCheckerResult: (
    workflow: WorkflowContext,
    path: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  readonly stopAgent: (
    workflow: WorkflowContext,
    taskId: NodeId,
    childThreadId: ThreadId,
    why: "stalled" | "timed_out",
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

const decodeItem = Schema.decodeUnknownExit(OrchestratorMcpDelegateTasksItem);

const runnerTimeMillis = () => Effect.runSync(Clock.currentTimeMillis);

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function stringOption(options: Readonly<Record<string, unknown>>, key: string) {
  const value = options[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasRecordedTask(agent: OrchestrationV2WorkflowAgent): boolean {
  return (
    agent.agentId !== undefined ||
    (agent.attemptTaskIds?.length ?? 0) > 0 ||
    (agent.attemptHistory?.length ?? 0) > 0
  );
}

const decodeNodeOutcome = Schema.decodeUnknownExit(OrchestrationV2WorkflowNodeOutcome);

/** The command that settles the workflow row with the script's outcome. */
type WorkflowCompletion = Extract<
  Parameters<WorkflowRunnerDeps["threads"]["dispatch"]>[0],
  { readonly type: "workflow.complete" }
>;

/** One script run. Plain promises, because QuickJS host calls are callback based. */
class WorkflowSession {
  readonly abort = new AbortController();
  private name: string | undefined;
  private readonly phases: WorkflowPhases;
  private currentPhase: string | undefined;
  private readonly agents: Array<MutableAgent> = [];
  private nextAgentIndex: number;
  private progress: string | undefined;
  private readonly occurrences = new Map<string, number>();
  private readonly nodeOutcomes: Record<string, OrchestrationV2WorkflowNodeOutcome> = {};
  private readonly waiting = new Map<string, WaitingAgent>();
  private readonly stalled = new Set<string>();
  private readonly timedOut = new Set<string>();
  private budgetExhausted = false;
  private sent: OrchestrationV2SubagentWorkflow = { phases: [], agents: [] };
  private sentProgress: string | undefined;
  private updateError: unknown;
  private readonly writeHolds = new Map<number, ReadonlyArray<string>>();
  private readonly scopeWaiters = new Set<() => void>();
  private updating: Promise<void> | undefined;
  private updatePending = false;
  private readonly workflow: WorkflowContext;
  private readonly deps: WorkflowRunnerDeps;
  private readonly attempts: AgentAttemptHost;

  constructor(workflow: WorkflowContext, deps: WorkflowRunnerDeps) {
    this.workflow = workflow;
    this.phases = new WorkflowPhases(workflow.previousWorkflow?.phases);
    this.nextAgentIndex =
      Math.max(-1, ...(workflow.previousWorkflow?.agents ?? []).map((agent) => agent.index)) + 1;
    this.deps = deps;
    this.sent = workflow.previousWorkflow ?? this.sent;
    this.budgetExhausted = workflow.previousWorkflow?.budget?.exhausted ?? false;
    this.attempts = {
      workflow,
      deps,
      signal: this.abort.signal,
      waiting: this.waiting,
      stalled: this.stalled,
      timedOut: this.timedOut,
      spentTokens: () => this.recordedUsage().spent ?? 0,
      markBudgetExhausted: () => {
        this.budgetExhausted = true;
      },
      setProgress: (message) => {
        this.progress = truncate(message, PREVIEW_LIMIT);
      },
      scheduleUpdate: () => this.scheduleUpdate(),
      runAgent: (request) => this.runAgent(request),
    };
  }

  /** Agents being waited on, for the stall sweep. */
  waitingAgents() {
    return [...this.waiting.entries()];
  }

  markStalled(taskId: string): void {
    this.stalled.add(taskId);
  }

  markTimedOut(taskId: string): void {
    this.timedOut.add(taskId);
  }

  /** Finishes once the workflow is stopped or the server detaches this runner. */
  readonly stopped = Effect.callback<void>((resume) => {
    const signal = this.abort.signal;
    if (signal.aborted) return resume(Effect.void);
    const onAbort = () => resume(Effect.void);
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", onAbort));
  });

  /** Stopping the coordinator also releases every child settlement subscription. */
  observe(task: OrchestrationV2Subagent): void {
    if (task.id === this.workflow.workflowId && task.status !== "running") this.abort.abort();
  }

  observeWorkflowStatus(id: NodeId, status: OrchestrationV2Subagent["status"] | undefined): void {
    if (id === this.workflow.workflowId && status !== undefined && status !== "running")
      this.abort.abort();
  }

  /**
   * Runs the script once and returns the command that settles its row, or nothing when the row
   * is already final. Sending the command is the caller's job, so a failed send never reruns it.
   */
  async run(): Promise<WorkflowCompletion | undefined> {
    let outcome = await runWorkflowScript({
      source: this.workflow.source,
      args: this.workflow.args,
      signal: this.abort.signal,
      host: this.host(),
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({
        ok: false as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    // Stopped by Stop or the thread's own stop: the row is already final.
    if (this.abort.signal.aborted) return undefined;
    if (this.phases.failOpen() && outcome.ok)
      outcome = { ok: false, message: "Await every progress.phase() before the script returns." };
    try {
      await this.flush();
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    return {
      type: "workflow.complete",
      commandId: CommandId.make(`command:workflow-complete:${this.workflow.workflowId}`),
      threadId: this.workflow.threadId,
      workflowId: this.workflow.workflowId,
      status: outcome.ok ? "completed" : "failed",
      result: completionResult(outcome, {
        workflowId: this.workflow.workflowId,
        // Only the current graph driver stores per-node provenance, so only its record is
        // compacted. A graph started under an older driver keeps its full record on resume.
        graph: this.workflow.plan !== undefined && this.workflow.source === GRAPH_DRIVER_SCRIPT,
      }),
    };
  }

  private host(): WorkflowScriptHost {
    return {
      agent: (request) => this.agent(request),
      log: (message) => {
        this.progress = truncate(message, PREVIEW_LIMIT);
        this.scheduleUpdate();
      },
      phase: (title) => {
        this.currentPhase = title;
        this.phases.declare(title);
        this.scheduleUpdate();
      },
      progress: {
        start: (title, total) => {
          const index = this.phases.start(
            title,
            total,
            this.agents.flatMap((agent) =>
              agent.judgmentFor === undefined && agent.phaseIndex !== undefined
                ? [agent.phaseIndex]
                : [],
            ),
          );
          this.scheduleUpdate();
          return index;
        },
        close: (index, state) => {
          this.phases.close(index, state);
          this.scheduleUpdate();
        },
      },
      budget: () => ({
        total: this.workflow.budgetTokens ?? null,
        spent: this.recordedUsage().spent ?? 0,
      }),
      meta: (meta) => {
        const record = asRecord(meta);
        if (typeof record.name === "string") this.name = record.name;
        if (Array.isArray(record.phases)) {
          for (const phase of record.phases) {
            const title = asRecord(phase).title;
            if (typeof title === "string" && title.trim().length > 0)
              this.phases.declare(title.trim(), asRecord(phase).total);
          }
        }
        this.scheduleUpdate();
      },
      ...(this.workflow.plan === undefined
        ? {}
        : { node: (key: string, outcome: unknown) => this.recordNode(key, outcome) }),
    };
  }

  private recordedUsage() {
    return workflowRecordedUsage([
      ...(this.workflow.previousWorkflow?.agents ?? []),
      ...this.agents,
    ]);
  }

  /** The plan node a script names, refusing names outside a reviewed graph's plan. */
  private planNodeKey(key: unknown, caller: string): string {
    const plan = this.workflow.plan;
    if (plan === undefined) {
      throw new Error(
        `${caller} takes a graph node only in a workflow started from a reviewed graph.`,
      );
    }
    if (typeof key !== "string" || !plan.nodes.some((node) => node.key === key)) {
      throw new Error(`${caller} got node ${JSON.stringify(key)}, which is not in this graph.`);
    }
    return key;
  }

  private recordNode(key: string, outcome: unknown): void {
    const nodeKey = this.planNodeKey(key, "node()");
    const decoded = decodeNodeOutcome(outcome);
    if (Exit.isFailure(decoded)) {
      throw new Error("node() needs an outcome with status passed, failed or skipped.");
    }
    const { reason } = decoded.value;
    this.nodeOutcomes[nodeKey] =
      reason === undefined
        ? decoded.value
        : { ...decoded.value, reason: truncate(reason, PREVIEW_LIMIT) };
    this.scheduleUpdate();
  }

  /**
   * The script's agent(): the result, or null when the agent failed. With `report: true`
   * it always resolves to an AgentReport, so a graph can record why a node failed.
   */
  private async agent(request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
    readonly phaseIndex?: number;
    readonly keyLabel?: string | null;
    readonly judgmentFor?: OrchestrationV2WorkflowAgent["judgmentFor"];
  }): Promise<unknown> {
    const ran = await this.runAgent(request);
    if (request.options.report !== true) return ran.value;
    const { entry, value } = ran;
    const completed = entry.state === "completed" && value !== null;
    const withOutputs = completed && ran.declaresOutputs ? asRecord(value) : undefined;
    return {
      ok: completed,
      result: withOutputs === undefined ? (completed ? value : null) : (withOutputs.result ?? null),
      attempts: entry.agentId === undefined ? 0 : (entry.attempt ?? 0) + 1,
      outputs: (withOutputs?.outputs ?? {}) as AgentReport["outputs"],
      verification:
        entry.verification === undefined
          ? null
          : { ...entry.verification, detail: entry.verification.detail ?? null },
      reason: completed
        ? null
        : entry.state === "completed"
          ? "The agent finished without a usable result."
          : (entry.result ?? "The agent failed."),
    } satisfies AgentReport;
  }

  private async runAgent(request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
    readonly phaseIndex?: number;
    /** The label its retry key uses, when not the script's own; null keys it by content alone. */
    readonly keyLabel?: string | null;
    readonly judgmentFor?: OrchestrationV2WorkflowAgent["judgmentFor"];
  }): Promise<{
    readonly value: unknown;
    readonly entry: MutableAgent;
    readonly declaresOutputs: boolean;
  }> {
    if (this.agents.length >= MAX_AGENTS_PER_WORKFLOW) {
      throw new Error(`This workflow reached its limit of ${MAX_AGENTS_PER_WORKFLOW} agents.`);
    }
    const options = request.options;
    // Kept out of the retry key: the node a call runs does not change what it asks for.
    const graphNodeKey =
      options.node === undefined ? undefined : this.planNodeKey(options.node, "agent()");
    if (this.abort.signal.aborted) throw new Error("The workflow was stopped.");
    const boundPhase =
      request.phaseIndex === undefined
        ? undefined
        : this.phases.member(
            request.phaseIndex,
            this.agents.filter(
              (agent) => agent.phaseIndex === request.phaseIndex && agent.judgmentFor === undefined,
            ).length,
          );
    const phase = boundPhase?.title ?? stringOption(options, "phase") ?? this.currentPhase;
    const phaseRow = phase === undefined ? undefined : this.phases.declare(phase);
    if (
      boundPhase === undefined &&
      request.judgmentFor === undefined &&
      phaseRow?.progress !== undefined
    )
      throw new Error("Use bar.agent() to join a progress phase.");
    const label = stringOption(options, "label") ?? `agent ${this.agents.length + 1}`;
    const model = stringOption(options, "model");
    const {
      target,
      source,
      error,
      plannedTarget = target,
    } = selectWorkflowTarget(
      { target: options.target, model, preset: options.preset },
      this.workflow.workerTarget,
      this.workflow.workflowPresets,
      this.workflow.presetTargets,
    );
    let check: WorkflowCheck | undefined;
    let scopes: FileScopes | undefined;
    let inputs: ReadonlyArray<FileRef> = [];
    let outputs: ReadonlyArray<FileRef> = [];
    let attemptTimeoutMs: number | undefined;
    let invalid: string | undefined =
      error ?? (source === "workerTarget" ? this.workflow.workerTargetError : undefined);
    try {
      if (options.verify !== undefined) check = parseCheck(options.verify);
      if (options.scopes !== undefined) scopes = parseScopes(options.scopes);
      if (options.inputs !== undefined) inputs = parseFileRefs(options.inputs, "inputs");
      if (options.outputs !== undefined) outputs = parseFileRefs(options.outputs, "outputs");
      if (options.attemptTimeoutMs !== undefined) {
        const value = options.attemptTimeoutMs;
        if (
          typeof value !== "number" ||
          !Number.isInteger(value) ||
          value < MIN_ATTEMPT_TIMEOUT_MS ||
          value > MAX_ATTEMPT_TIMEOUT_MS
        ) {
          throw new Error(
            `attemptTimeoutMs must be a whole number from ${MIN_ATTEMPT_TIMEOUT_MS} to ${MAX_ATTEMPT_TIMEOUT_MS}.`,
          );
        }
        attemptTimeoutMs = value;
      }
      const outputId = check?.type === "structured" ? check.outputId : undefined;
      if (outputId !== undefined && !outputs.some((output) => output.id === outputId)) {
        throw new Error(`verify.outputId "${outputId}" is not one of this agent's outputs.`);
      }
      // The runner reads declared files in the caller's checkout, which a worktree agent never writes.
      if (inputs.length + outputs.length > 0 && options.isolation === "worktree") {
        throw new Error('inputs and outputs need the shared checkout, not isolation "worktree".');
      }
    } catch (error) {
      invalid = error instanceof Error ? error.message : String(error);
    }
    // Keyed by content rather than call order, so a resumed script maps each call
    // back to the same task even when concurrent calls start in a different order.
    const digest = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          phase ?? null,
          // A generated label numbers calls in start order, which a resume can change.
          request.keyLabel !== undefined
            ? request.keyLabel
            : (stringOption(options, "label") ?? null),
          request.prompt,
          options.schema ?? null,
          target ?? null,
          options.isolation ?? null,
          // Only present when used, so scripts without them keep their keys.
          ...(check === undefined ? [] : [{ verify: check }]),
          ...(scopes === undefined ? [] : [{ scopes }]),
          ...(inputs.length === 0 ? [] : [{ inputs: inputs.map(withoutProducer) }]),
          ...(outputs.length === 0 ? [] : [{ outputs }]),
          ...(attemptTimeoutMs === undefined ? [] : [{ attemptTimeoutMs }]),
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    const occurrence = this.occurrences.get(digest) ?? 0;
    this.occurrences.set(digest, occurrence + 1);
    const requestKey = `wf-${digest}-${occurrence}`;
    const promptPreview = truncate(request.prompt, PREVIEW_LIMIT);
    const previousAgents = this.workflow.previousWorkflow?.agents ?? [];
    const legacyTasks = previousAgents.filter(
      (agent) => agent.requestKey === undefined && hasRecordedTask(agent),
    );
    const taskIds = new Set<string>();
    if (legacyTasks.length > 0) {
      for (let attempt = 0; attempt < MAX_AGENT_ATTEMPTS; attempt += 1) {
        const taskId = this.deps.agentTaskId(this.workflow, agentAttemptKey(requestKey, attempt));
        if (taskId === undefined)
          throw new Error(`Cannot establish workflow agent identity for "${label}".`);
        taskIds.add(taskId);
      }
    }
    const matches = previousAgents.filter(
      (agent) =>
        agent.requestKey === requestKey ||
        (agent.agentId !== undefined && taskIds.has(agent.agentId)) ||
        agent.attemptTaskIds?.some((id) => taskIds.has(id)) ||
        agent.attemptHistory?.some((attempt) => taskIds.has(attempt.taskId)),
    );
    if (
      matches.length > 1 ||
      matches.some(
        (agent) =>
          (agent.requestKey !== undefined && agent.requestKey !== requestKey) ||
          this.agents.some((claimed) => claimed.index === agent.index),
      )
    )
      throw new Error(`Ambiguous workflow agent identity for "${label}".`);
    const previous =
      matches[0] ??
      // Legacy placeholders have no task to reattach; reuse an unclaimed matching display slot.
      previousAgents.find(
        (agent) =>
          agent.requestKey === undefined &&
          !hasRecordedTask(agent) &&
          agent.phaseIndex === phaseRow?.index &&
          agent.graphNodeKey === graphNodeKey &&
          agent.prompt === promptPreview &&
          (stringOption(options, "label") === undefined || agent.label === label) &&
          agent.judgmentFor?.agentIndex === request.judgmentFor?.agentIndex &&
          agent.judgmentFor?.attempt === request.judgmentFor?.attempt &&
          !this.agents.some((claimed) => claimed.index === agent.index),
      );
    if (
      previous === undefined &&
      legacyTasks.some((agent) => {
        if (this.agents.some((claimed) => claimed.index === agent.index)) return false;
        const keys = new Set(
          [
            ...(agent.agentId === undefined ? [] : [agent.agentId]),
            ...(agent.attemptTaskIds ?? []),
            ...(agent.attemptHistory?.map((attempt) => attempt.taskId) ?? []),
          ].map((id) => this.deps.agentRequestKey(this.workflow, id)),
        );
        return keys.size !== 1 || keys.has(undefined) || keys.has(requestKey);
      })
    )
      throw new Error(`Cannot establish workflow agent identity for "${label}".`);
    const plannedIdentity =
      previous?.plannedIdentity ??
      this.workflow.plan?.nodes.find((node) => node.key === graphNodeKey)?.plannedIdentity ??
      workflowPlannedIdentity(plannedTarget);
    const entry: MutableAgent = {
      index: previous?.index ?? this.nextAgentIndex++,
      requestKey,
      label,
      ...(graphNodeKey === undefined ? {} : { graphNodeKey }),
      ...(request.judgmentFor === undefined ? {} : { judgmentFor: request.judgmentFor }),
      state: "queued",
      ...(plannedIdentity === undefined ? {} : { plannedIdentity }),
      ...(phaseRow === undefined ? {} : { phaseIndex: phaseRow.index, phaseTitle: phaseRow.title }),
      prompt: promptPreview,
    };
    this.agents.push(entry);
    this.scheduleUpdate();
    const done = (value: unknown) => ({ value, entry, declaresOutputs: outputs.length > 0 });
    const settle = (status: "completed" | "failed", result: string | null) => {
      entry.state = status;
      entry.runnerSettledAt = runnerTimeMillis();
      const category = workflowAgentOutcomeCategory({
        status,
        started: entry.agentId !== undefined,
      });
      if (category !== null) entry.outcomeCategory ??= category;
      if (result !== null && result.trim().length > 0) {
        entry.result = boundText(
          result,
          HANDOFF_SUMMARY_BYTES,
          entry.agentId === undefined ? undefined : taskOutputAt(entry.agentId),
        );
      }
      this.scheduleUpdate();
    };

    // A graph node's final message becomes the summary the next agent and the coordinator read.
    const contract =
      graphNodeKey !== undefined || outputs.length > 0
        ? resultContract({
            hasSchema: options.schema !== undefined,
            hasOutputs: outputs.length > 0,
          })
        : "";
    const itemFor = (feedback: string) =>
      decodeItem({
        task: `${request.prompt}${scopes === undefined ? "" : scopeInstructions(scopes)}${fileInstructions(this.withSummaries(inputs), outputs)}${contract}${feedback}`,
        title: truncate(label, 500),
        ...(target === undefined ? {} : { target }),
        ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.schema === undefined ? {} : { resultSchema: options.schema }),
      });
    if (invalid !== undefined || Exit.isFailure(itemFor(""))) {
      settle("failed", `agent "${label}" has invalid options${invalid ? `: ${invalid}` : "."}`);
      return done(null);
    }
    if (
      check?.type === "structured" &&
      check.outputId === undefined &&
      options.schema === undefined
    ) {
      settle(
        "failed",
        `agent "${label}": a structured check needs a schema for the result, or an outputId.`,
      );
      return done(null);
    }
    if (
      check?.type === "process" &&
      !(await Effect.runPromise(
        this.deps.canRunCommands(this.workflow).pipe(Effect.orElseSucceed(() => false)),
      ))
    ) {
      settle(
        "failed",
        `agent "${label}": a process check runs a command, which needs the calling thread in full-access mode.`,
      );
      return done(null);
    }
    // Agents sharing a checkout never write the same files at once; an output is a write.
    const writes = [...(scopes?.write ?? []), ...outputs.map((output) => output.path)];
    const holdsWrites = writes.length > 0 && options.isolation !== "worktree";
    if (holdsWrites) await this.acquireWrites(entry.index, writes, label);
    try {
      return done(
        await runAttempts(this.attempts, {
          request,
          options,
          entry,
          label,
          phase,
          target,
          requestKey,
          check,
          inputs,
          outputs,
          attemptTimeoutMs,
          itemFor,
          settle,
        }),
      );
    } finally {
      if (holdsWrites) this.releaseWrites(entry.index);
    }
  }

  /** Each input from a graph node with the stored result of the agent that ran it. */
  private withSummaries(inputs: ReadonlyArray<FileRef>): ReadonlyArray<HandoffInput> {
    return inputs.map((ref) => ({
      ...ref,
      summary:
        ref.from === undefined
          ? undefined
          : this.agents.find(
              (agent) => agent.graphNodeKey === ref.from && agent.judgmentFor === undefined,
            )?.result,
    }));
  }

  private async acquireWrites(index: number, paths: ReadonlyArray<string>, label: string) {
    while ([...this.writeHolds.values()].some((held) => scopesOverlap(held, paths))) {
      this.progress = truncate(
        `agent "${label}" waits for files another agent is changing.`,
        PREVIEW_LIMIT,
      );
      this.scheduleUpdate();
      await new Promise<void>((resolve) => this.scopeWaiters.add(resolve));
    }
    this.writeHolds.set(index, paths);
  }

  private releaseWrites(index: number) {
    this.writeHolds.delete(index);
    const waiters = [...this.scopeWaiters];
    this.scopeWaiters.clear();
    for (const wake of waiters) wake();
  }

  private snapshot(): OrchestrationV2SubagentWorkflow {
    return {
      ...(this.name === undefined ? {} : { name: this.name }),
      phases: this.phases.snapshot(),
      agents: this.agents.map((agent) => ({ ...agent })),
      ...(this.workflow.budgetTokens === undefined
        ? {}
        : { budget: { limit: this.workflow.budgetTokens, exhausted: this.budgetExhausted } }),
      ...(this.workflow.plan === undefined
        ? {}
        : { plan: this.workflow.plan, nodeOutcomes: { ...this.nodeOutcomes } }),
    };
  }

  private dispatch(
    command: Parameters<WorkflowRunnerDeps["threads"]["dispatch"]>[0],
  ): Promise<void> {
    return Effect.runPromise(this.deps.threads.dispatch(command).pipe(Effect.asVoid));
  }

  private async update(): Promise<void> {
    const patches = workflowPatches(this.sent, this.snapshot());
    if (patches.length === 0 && this.progress !== this.sentProgress)
      patches.push({ kind: "patch" });
    for (const patch of patches) {
      const progress = this.progress;
      await this.dispatch({
        type: "workflow.update",
        commandId: CommandId.make(`command:workflow-update:${NodeCrypto.randomUUID()}`),
        threadId: this.workflow.threadId,
        workflowId: this.workflow.workflowId,
        workflow: patch,
        ...(progress === undefined ? {} : { progress }),
      });
      this.sent = mergeWorkflowPatch(this.sent, patch);
      this.sentProgress = progress;
    }
  }

  // One row update in flight at a time; changes made meanwhile ride the next one,
  // so a burst of agent state changes costs one or two writes.
  private scheduleUpdate(): void {
    if (this.abort.signal.aborted || this.updateError !== undefined) return;
    if (this.updating !== undefined) {
      this.updatePending = true;
      return;
    }
    this.updating = this.update()
      .catch((error: unknown) => {
        this.updateError = error;
      })
      .finally(() => {
        this.updating = undefined;
        if (this.updatePending) {
          this.updatePending = false;
          this.scheduleUpdate();
        }
      });
  }

  private async flush(): Promise<void> {
    while (this.updating !== undefined) await this.updating;
    if (this.updateError !== undefined) throw this.updateError;
    await this.update();
  }
}

export const makeWorkflowRunner = (deps: WorkflowRunnerDeps) => {
  const running = new Map<NodeId, WorkflowSession>();

  // Whether the workflow's row still needs its completion. A failed read says nothing either way.
  const completionRowState = (completion: WorkflowCompletion) =>
    deps.threads.getThreadRecords(completion.threadId, ["subagents"]).pipe(
      Effect.map(({ subagents }) =>
        subagents.find((row) => row.id === completion.workflowId)?.status === "running"
          ? ("running" as const)
          : ("settled" as const),
      ),
      Effect.catchCause(() => Effect.succeed("unknown" as const)),
    );

  // Sends the script's outcome until the row is settled, stopped or detached; only the send is
  // repeated, never the script. The runner stays registered meanwhile, so nothing resumes the row.
  // Domain-wise the command is safe to send again: a row takes one completion, and its single
  // commit plans the one parent wake.
  const complete = Effect.fn("WorkflowRunner.complete")(function* (
    session: WorkflowSession,
    completion: WorkflowCompletion,
  ) {
    let commandId = completion.commandId;
    let pauses = 0;
    // Checked before every try: a try that wakes as the runner is detached or the row stopped
    // must not send a completion.
    while (!session.abort.signal.aborted) {
      // A started try is never interrupted. Its own commit publishes the row's final event, which
      // stops this runner, and cutting the dispatcher off after the commit would lose the wake.
      const exit = yield* deps.threads
        .dispatch({ ...completion, commandId })
        .pipe(Effect.asVoid, Effect.uninterruptible, Effect.exit);
      if (Exit.isSuccess(exit)) return;
      yield* Effect.logWarning("Unable to record a workflow's completion", {
        workflowId: completion.workflowId,
        commandId,
        cause: exit.cause,
      });
      const row = yield* completionRowState(completion);
      if (row === "settled") return;
      const refusal = Exit.findErrorOption(exit);
      // A stored rejection answers its id for good. The row is known to be running, so a fresh id
      // cannot complete it twice, and nothing else is waiting on the old id.
      if (row === "running" && refusal._tag === "Some" && isCommandIdSpent(refusal.value)) {
        commandId = yield* freshCommandId(completion.commandId);
        continue;
      }
      pauses += 1;
      const pause = Math.min(COMPLETION_RETRY_MIN_MS * 2 ** (pauses - 1), COMPLETION_RETRY_MAX_MS);
      const jitter = yield* Random.nextBetween(0.8, 1.2);
      yield* Effect.sleep(Math.round(pause * jitter)).pipe(Effect.raceFirst(session.stopped));
    }
  });

  const run = Effect.fn("WorkflowRunner.run")(function* (
    session: WorkflowSession,
    workflow: WorkflowContext,
  ) {
    // Member tasks report through subagent rows; the workflow row's own status changes (a stop)
    // arrive as workflow patches. One filtered stream each keeps transcript events out.
    const events = (eventType: "subagent.updated" | "workflow.updated") =>
      deps.threads.streamStoredEventsFrom({
        threadId: workflow.threadId,
        afterSequence: workflow.afterSequence,
        eventType,
      });
    const watcher = yield* Stream.merge(
      events("subagent.updated"),
      events("workflow.updated"),
    ).pipe(
      Stream.runForEach((stored) =>
        Effect.sync(() => {
          if (stored.event.type === "subagent.updated") session.observe(stored.event.payload);
          if (stored.event.type === "workflow.updated")
            session.observeWorkflowStatus(stored.event.payload.id, stored.event.payload.status);
        }),
      ),
      Effect.ignore,
      Effect.forkChild,
    );
    const sweep = yield* Effect.sleep(STALL_SWEEP_INTERVAL).pipe(
      Effect.andThen(stopStalledAgents(deps, session, workflow)),
      Effect.forever,
      Effect.forkChild,
    );
    const completion = yield* Effect.promise(() => session.run());
    if (completion !== undefined) yield* complete(session, completion);
    yield* Fiber.interrupt(sweep);
    yield* Fiber.interrupt(watcher);
  });

  return {
    isRunning: (workflowId: NodeId) => running.has(workflowId),
    /**
     * Ends every script without settling its workflow, as a server stop does: the rows
     * stay running, and the next start resumes them.
     */
    detachAll: Effect.sync(() => {
      for (const session of running.values()) session.abort.abort();
    }),
    /** Starts the script once per process; a retried start finds it running. */
    launch: (workflow: WorkflowContext) =>
      Effect.suspend(() => {
        if (running.has(workflow.workflowId)) return Effect.void;
        const session = new WorkflowSession(workflow, deps);
        running.set(workflow.workflowId, session);
        return run(session, workflow).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("A workflow runner stopped unexpectedly", {
              workflowId: workflow.workflowId,
              cause,
            }),
          ),
          Effect.ensuring(Effect.sync(() => running.delete(workflow.workflowId))),
          Effect.forkDetach,
          Effect.asVoid,
        );
      }),
  };
};

export type WorkflowRunner = ReturnType<typeof makeWorkflowRunner>;

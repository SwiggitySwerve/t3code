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
  checkFeedback,
  type FileRef,
  fileInstructions,
  inputProblem,
  outputFiles,
  type ProducedFile,
  type WorkspaceFile,
  type FileScopes,
  JUDGMENT_RESULT_SCHEMA,
  judgmentOutcome,
  judgmentPrompt,
  parseCheck,
  parseFileRefs,
  parseScopes,
  type ProcessCheck,
  runStructuredCheck,
  structuredOutputCheck,
  scopeInstructions,
  scopesOverlap,
  type WorkflowCheck,
} from "./workflowChecks.ts";
import { MAX_AGENT_ATTEMPTS, MAX_AGENTS_PER_WORKFLOW } from "./workflowLimits.ts";
import { runWorkflowScript, type WorkflowScriptHost } from "./workflowScript.ts";
import { stopStalledAgents, type WaitingAgent } from "./workflowSweep.ts";

/**
 * An agent whose thread records nothing for this long is stopped and started again.
 * Generous, because a long tool call can be silent; `stallTimeoutMs` overrides it.
 */
const DEFAULT_STALL_MS = 20 * 60_000;
const MIN_STALL_MS = 60_000;
/** Per-attempt deadlines: at least a minute, at most the omx graph's "long" budget of 6 h. */
const MIN_ATTEMPT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPT_TIMEOUT_MS = 6 * 60 * 60_000;
const STALL_SWEEP_INTERVAL = "30 seconds";
const RESULT_TEXT_LIMIT = 2_000;
const WORKFLOW_RESULT_LIMIT = 16_000;
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
 * chosen without a frozen snapshot also reports its `preference` order (review, workflow start);
 * `target` is always its first entry, all a script with no snapshot uses. A snapshot is the
 * resolved choice with no order, so a resume never re-reads a preset.
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
  readonly stopAgent: (
    workflow: WorkflowContext,
    taskId: NodeId,
    childThreadId: ThreadId,
    why: "stalled" | "timed_out",
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

const decodeItem = Schema.decodeUnknownExit(OrchestratorMcpDelegateTasksItem);

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

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

function numberOption(options: Readonly<Record<string, unknown>>, key: string) {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function failureMessage<A>(exit: Exit.Exit<A, OrchestratorMcpFailure>, fallback: string): string {
  const failure = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
  return failure?._tag === "Some" ? failure.value.message : fallback;
}

const decodeNodeOutcome = Schema.decodeUnknownExit(OrchestrationV2WorkflowNodeOutcome);

/** The command that settles the workflow row with the script's outcome. */
type WorkflowCompletion = Extract<
  Parameters<WorkflowRunnerDeps["threads"]["dispatch"]>[0],
  { readonly type: "workflow.complete" }
>;

type MutableAgent = {
  -readonly [Key in keyof OrchestrationV2WorkflowAgent]: OrchestrationV2WorkflowAgent[Key];
};

/** One script run. Plain promises, because QuickJS host calls are callback based. */
class WorkflowSession {
  readonly abort = new AbortController();
  private name: string | undefined;
  private readonly phases: Array<string> = [];
  private currentPhase: string | undefined;
  private readonly agents: Array<MutableAgent> = [];
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

  constructor(workflow: WorkflowContext, deps: WorkflowRunnerDeps) {
    this.workflow = workflow;
    this.deps = deps;
    this.sent = workflow.previousWorkflow ?? this.sent;
    this.budgetExhausted = workflow.previousWorkflow?.budget?.exhausted ?? false;
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
      result: outcome.ok
        ? truncate(JSON.stringify(outcome.value ?? null, null, 2), WORKFLOW_RESULT_LIMIT)
        : truncate(`The workflow failed: ${outcome.message}`, WORKFLOW_RESULT_LIMIT),
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
        this.addPhase(title);
        this.scheduleUpdate();
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
            if (typeof title === "string" && title.trim().length > 0) this.addPhase(title.trim());
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
    const phase = stringOption(options, "phase") ?? this.currentPhase;
    if (phase !== undefined) this.addPhase(phase);
    const label = stringOption(options, "label") ?? `agent ${this.agents.length + 1}`;
    const model = stringOption(options, "model");
    const { target, source, error } = selectWorkflowTarget(
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
          ...(inputs.length === 0 ? [] : [{ inputs }]),
          ...(outputs.length === 0 ? [] : [{ outputs }]),
          ...(attemptTimeoutMs === undefined ? [] : [{ attemptTimeoutMs }]),
        ]),
      )
      .digest("hex")
      .slice(0, 24);
    const occurrence = this.occurrences.get(digest) ?? 0;
    this.occurrences.set(digest, occurrence + 1);
    const entry: MutableAgent = {
      index: this.agents.length,
      label,
      ...(graphNodeKey === undefined ? {} : { graphNodeKey }),
      ...(request.judgmentFor === undefined ? {} : { judgmentFor: request.judgmentFor }),
      state: "queued",
      ...(phase === undefined ? {} : { phaseIndex: this.phases.indexOf(phase), phaseTitle: phase }),
      prompt: truncate(request.prompt, PREVIEW_LIMIT),
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
        entry.result = truncate(result, RESULT_TEXT_LIMIT);
      }
      this.scheduleUpdate();
    };

    const itemFor = (feedback: string) =>
      decodeItem({
        task: `${request.prompt}${scopes === undefined ? "" : scopeInstructions(scopes)}${fileInstructions(inputs, outputs)}${feedback}`,
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
        await this.runAttempts({
          request,
          options,
          entry,
          label,
          phase,
          target,
          digest,
          occurrence,
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

  private async runAttempts(input: {
    readonly request: {
      readonly prompt: string;
      readonly options: Readonly<Record<string, unknown>>;
    };
    readonly options: Readonly<Record<string, unknown>>;
    readonly entry: MutableAgent;
    readonly label: string;
    readonly phase: string | undefined;
    readonly target: unknown;
    readonly digest: string;
    readonly occurrence: number;
    readonly check: WorkflowCheck | undefined;
    readonly inputs: ReadonlyArray<FileRef>;
    readonly outputs: ReadonlyArray<FileRef>;
    readonly attemptTimeoutMs: number | undefined;
    readonly itemFor: (feedback: string) => ReturnType<typeof decodeItem>;
    readonly settle: (status: "completed" | "failed", result: string | null) => void;
  }): Promise<unknown> {
    const {
      request,
      options,
      entry,
      label,
      phase,
      target,
      digest,
      occurrence,
      check,
      inputs,
      outputs,
      attemptTimeoutMs,
      itemFor,
      settle,
    } = input;
    const files = Object.fromEntries([
      ...inputs.map((ref) => [`input:${ref.id}`, ref.path] as const),
      ...outputs.map((ref) => [`output:${ref.id}`, ref.path] as const),
    ]);
    let feedback = "";
    for (let attempt = 0; ; attempt += 1) {
      const item = itemFor(feedback);
      if (Exit.isFailure(item)) {
        settle("failed", `agent "${label}" has invalid options.`);
        return null;
      }
      const key = `wf-${digest}-${occurrence}${attempt === 0 ? "" : `-r${attempt}`}`;
      const budget = this.workflow.budgetTokens;
      // An agent the budget allowed before a restart is re-attached, not refused.
      if (
        budget !== undefined &&
        (this.recordedUsage().spent ?? 0) >= budget &&
        !(await Effect.runPromise(
          this.deps.agentStarted(this.workflow, key).pipe(Effect.orElseSucceed(() => false)),
        ))
      ) {
        this.budgetExhausted = true;
        const message = `The workflow's budget of ${budget} tokens is spent (${this.recordedUsage().spent ?? 0} recorded). New agents will not start; already-running agents may exceed this budget.`;
        settle("failed", message);
        throw new Error(message);
      }
      // An input that changed since the script pinned it would make the work answer another question.
      const inputIssue = await inputProblem(inputs, (ref) => this.readFile(ref));
      if (inputIssue !== undefined) {
        settle("failed", `agent "${label}": ${inputIssue}`);
        return null;
      }
      const started = await Effect.runPromiseExit(
        this.deps.spawnAgent(this.workflow, item.value, key),
      );
      if (Exit.isFailure(started)) {
        settle("failed", failureMessage(started, "The agent could not start."));
        return null;
      }
      entry.agentId = started.value.taskId;
      entry.attemptTaskIds = [...new Set([...(entry.attemptTaskIds ?? []), started.value.taskId])];
      const recordAttempt = (outcome?: WorkflowAgentOutcome) => {
        const history = (entry.attemptHistory ?? []).filter(
          (record) => record.taskId !== started.value.taskId,
        );
        entry.attemptHistory = [
          ...history,
          {
            taskId: started.value.taskId,
            childThreadId: started.value.childThreadId,
            attempt,
            providerInstanceId: started.value.providerInstanceId,
            ...(started.value.model === null ? {} : { model: started.value.model }),
            state:
              outcome !== undefined && TERMINAL_TASK_STATUSES.has(outcome.status)
                ? (outcome.status as "completed" | "failed" | "cancelled" | "interrupted")
                : "running",
            usageStatus: outcome?.usage.status ?? "unavailable",
            ...(outcome?.usage.totalTokens == null
              ? {}
              : { totalTokens: outcome.usage.totalTokens }),
            timingComplete: false,
            ...outcome?.timing,
          },
        ];
      };
      recordAttempt();
      delete entry.outcomeCategory;
      entry.childThreadId = started.value.childThreadId;
      if (started.value.model !== null) entry.model = started.value.model;
      else delete entry.model;
      entry.providerInstanceId = started.value.providerInstanceId;
      entry.driver = started.value.driver;
      if (attempt > 0) entry.attempt = attempt;
      entry.state = "running";
      this.scheduleUpdate();
      this.waiting.set(started.value.taskId, {
        childThreadId: started.value.childThreadId,
        stallMs: Math.max(
          MIN_STALL_MS,
          numberOption(options, "stallTimeoutMs") ?? DEFAULT_STALL_MS,
        ),
        ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
      });
      const outcome = await Effect.runPromiseExit(
        this.deps.awaitAgent(this.workflow, started.value.taskId, (current) => {
          if (this.abort.signal.aborted) return;
          if (TERMINAL_TASK_STATUSES.has(current.status)) this.waiting.delete(started.value.taskId);
          recordAttempt(current);
          this.scheduleUpdate();
        }),
        { signal: this.abort.signal },
      );
      this.waiting.delete(started.value.taskId);
      if (this.abort.signal.aborted) return null;
      if (Exit.isFailure(outcome)) {
        settle("failed", failureMessage(outcome, "The agent's result could not be read."));
        return null;
      }
      const { status, summary, structuredResult, structuredResultError } = outcome.value;
      recordAttempt(outcome.value);
      const knownTokens = (entry.attemptHistory ?? []).flatMap((record) =>
        record.totalTokens === undefined ? [] : [record.totalTokens],
      );
      if (knownTokens.length > 0)
        entry.totalTokens = knownTokens.reduce((sum, count) => sum + count, 0);
      if (outcome.value.outcomeCategory !== null)
        entry.outcomeCategory = outcome.value.outcomeCategory;
      if (status !== "completed" && this.timedOut.has(started.value.taskId)) {
        const passed = `passed its time budget of ${attemptTimeoutMs} ms and was stopped`;
        if (attempt + 1 < MAX_AGENT_ATTEMPTS) {
          feedback = `\n\nYour previous attempt ${passed}. Work more directly and finish within the budget.`;
          this.progress = truncate(`agent "${label}" ${passed}; starting it again.`, PREVIEW_LIMIT);
          continue;
        }
        entry.outcomeCategory = "timed_out";
        settle("failed", `Every attempt ${passed}.`);
        return null;
      }
      if (status !== "completed") {
        const retry =
          attempt + 1 < MAX_AGENT_ATTEMPTS &&
          (status === "failed" ||
            ((status === "cancelled" || status === "interrupted") &&
              (outcome.value.cancelledByServerRestart || this.stalled.has(started.value.taskId))));
        if (retry) {
          this.progress = truncate(
            `agent "${label}" ended ${status}; starting it again.`,
            PREVIEW_LIMIT,
          );
          continue;
        }
        settle("failed", summary ?? `The agent ended ${status}.`);
        return null;
      }
      const value = options.schema === undefined ? summary : (structuredResult ?? null);
      // Missing or oversized outputs fail before any other check, which would read them.
      let produced: Readonly<Record<string, ProducedFile>> | undefined;
      let checkType: WorkflowCheck["type"] | "outputs" | undefined;
      let checked: CheckOutcome | undefined;
      // A result asked to match a schema that does not is a failed structured check, so
      // passing another check cannot hand the script a missing result.
      if (options.schema !== undefined && structuredResultError !== undefined) {
        checkType = "structured";
        checked = { outcome: "failed", detail: structuredResultError };
      } else if (outputs.length > 0) {
        const found = await outputFiles(outputs, (ref) => this.readFile(ref));
        if ("files" in found) produced = found.files;
        checkType = "outputs";
        checked = found.outcome;
      }
      if (check !== undefined && (checked === undefined || checked.outcome === "passed")) {
        checkType = check.type;
        checked = await this.runCheck({
          check,
          judgmentFor: {
            agentIndex: entry.index,
            attempt,
            ...(entry.graphNodeKey === undefined ? {} : { graphNodeKey: entry.graphNodeKey }),
          },
          prompt: request.prompt,
          label,
          phase,
          target,
          childThreadId: started.value.childThreadId,
          summary,
          structuredResult,
          structuredResultError,
          files,
          outputs,
          isolation: options.isolation,
        });
      }
      const returned = (result: unknown) =>
        produced === undefined ? result : { result, outputs: produced };
      if (checked === undefined || checkType === undefined) {
        settle("completed", summary);
        return returned(value);
      }
      entry.verification = {
        type: checkType,
        outcome: checked.outcome,
        attempts: attempt + 1,
        ...(checked.detail.trim().length === 0
          ? {}
          : { detail: truncate(checked.detail, RESULT_TEXT_LIMIT) }),
      };
      if (checked.outcome === "passed") {
        settle("completed", summary);
        return returned(value);
      }
      // A failed check is a judgment on the work, so the agent tries again with what the
      // check saw. A check that could not run is not, and retrying the agent would not fix it.
      if (checked.outcome === "failed" && attempt + 1 < MAX_AGENT_ATTEMPTS) {
        feedback = checkFeedback(checkType, checked);
        this.progress = truncate(
          `agent "${label}" failed its ${checkType} check; starting it again.`,
          PREVIEW_LIMIT,
        );
        entry.state = "running";
        this.scheduleUpdate();
        continue;
      }
      entry.outcomeCategory = "check_failed";
      settle(
        "failed",
        `Its ${checkType} check ${checked.outcome === "error" ? "could not run" : "failed"}: ${checked.detail}`,
      );
      return null;
    }
  }

  private readFile(ref: FileRef): Promise<WorkspaceFile | string> {
    return Effect.runPromise(
      this.deps
        .readWorkspaceFile(this.workflow, ref.path, ref.maxBytes)
        .pipe(
          Effect.catch((failure) =>
            Effect.succeed(`${ref.path} could not be read: ${failure.message}`),
          ),
        ),
    );
  }

  private async runCheck(input: {
    readonly check: WorkflowCheck;
    readonly judgmentFor: NonNullable<OrchestrationV2WorkflowAgent["judgmentFor"]>;
    readonly prompt: string;
    readonly label: string;
    readonly phase: string | undefined;
    readonly target: unknown;
    readonly childThreadId: ThreadId;
    readonly summary: string | null;
    readonly structuredResult: unknown;
    readonly structuredResultError: string | undefined;
    readonly files: Readonly<Record<string, string>>;
    readonly outputs: ReadonlyArray<FileRef>;
    readonly isolation: unknown;
  }): Promise<CheckOutcome> {
    const { check } = input;
    const output =
      check.type === "structured" && check.outputId !== undefined
        ? input.outputs.find((ref) => ref.id === check.outputId)
        : undefined;
    if (check.type === "structured" && output !== undefined) {
      return structuredOutputCheck(check, output, (ref) => this.readFile(ref));
    }
    if (check.type === "structured") {
      return input.structuredResultError !== undefined
        ? { outcome: "failed", detail: input.structuredResultError }
        : runStructuredCheck(check, input.structuredResult);
    }
    const resultText =
      input.summary ??
      (input.structuredResult === undefined ? "" : JSON.stringify(input.structuredResult));
    if (check.type === "process") {
      // Stopping the workflow interrupts the check, which ends its process.
      const ran = await Effect.runPromiseExit(
        this.deps.runCommandCheck(
          this.workflow,
          input.childThreadId,
          check,
          resultText,
          input.files,
        ),
        { signal: this.abort.signal },
      );
      return Exit.isFailure(ran)
        ? { outcome: "error", detail: failureMessage(ran, "The check could not run.") }
        : ran.value;
    }
    // An agent of its own, so it is independent of the work it judges and shows in the workflow.
    const target = check.target ?? input.target;
    const verdict = await this.runAgent({
      prompt: judgmentPrompt({
        task: input.prompt,
        result: resultText,
        rubric: check.rubric,
        workspaceVisible: input.isolation !== "worktree",
      }),
      // Its prompt already pins the work it judges; a generated worker label would not.
      keyLabel: null,
      judgmentFor: input.judgmentFor,
      options: {
        label: `check ${input.label}`,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
        ...(target === undefined ? {} : { target }),
        schema: JUDGMENT_RESULT_SCHEMA,
      },
    });
    const outcome = judgmentOutcome(verdict.value);
    verdict.entry.judgmentOutcome = outcome.outcome;
    this.scheduleUpdate();
    return outcome;
  }

  private addPhase(title: string): void {
    if (!this.phases.includes(title)) this.phases.push(title);
  }

  private snapshot(): OrchestrationV2SubagentWorkflow {
    return {
      ...(this.name === undefined ? {} : { name: this.name }),
      phases: this.phases.map((title, index) => ({ index, title })),
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

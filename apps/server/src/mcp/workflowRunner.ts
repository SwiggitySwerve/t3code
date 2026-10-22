/**
 * Runs T3 workflows: a sandboxed script whose agent() calls become ordinary
 * delegated tasks of the calling thread, owned by the workflow row instead of a
 * live run. The row's `workflow` field carries progress; the orchestrator
 * delivers one completion when the runner reports the script's outcome.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- agent keys are hashed synchronously inside QuickJS host callbacks.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2WorkflowAgent,
  OrchestratorMcpDelegateTasksItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type OrchestratorMcpFailure,
  type ThreadId,
  type WorkflowAgentOutcomeCategory,
  type OrchestratorMcpWorkflowUsage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  type CheckOutcome,
  checkFeedback,
  type FileRef,
  fileInstructions,
  type FileScopes,
  JUDGMENT_RESULT_SCHEMA,
  judgmentOutcome,
  judgmentPrompt,
  parseCheck,
  parseFileRefs,
  parseScopes,
  type ProcessCheck,
  runStructuredCheck,
  scopeInstructions,
  scopesOverlap,
  type WorkflowCheck,
} from "./workflowChecks.ts";
import { runWorkflowScript, type WorkflowScriptHost } from "./workflowScript.ts";

/** Claude Code's documented per-run ceiling. */
const MAX_AGENTS_PER_WORKFLOW = 1000;
/** A failed agent, or one a server restart cancelled, runs again up to this many times in all. */
const MAX_AGENT_ATTEMPTS = 3;
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

export interface WorkflowContext {
  readonly workflowId: NodeId;
  readonly threadId: ThreadId;
  readonly source: string;
  readonly args: unknown;
  /** New agents stop starting once finished agents used this many tokens. */
  readonly budgetTokens?: number;
  /** Stored event sequence before the workflow row was created. */
  readonly afterSequence: number;
}

export interface WorkflowAgentStart {
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
  readonly model: string | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
}

export interface WorkflowAgentOutcome {
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

/** A workspace file as the runner found it; `too_large` once it passes the caller's bound. */
export type WorkspaceFile =
  | {
      readonly status: "found";
      readonly sha256: string;
      readonly sizeBytes: number;
      /** The bytes read as UTF-8. */
      readonly text: string;
    }
  | { readonly status: "missing" }
  | { readonly status: "too_large"; readonly sizeBytes: number };

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

/** An output an agent wrote, as returned to the script. */
interface ProducedFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface WorkflowRunnerDeps {
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly spawnAgent: (
    workflow: WorkflowContext,
    item: OrchestratorMcpDelegateTasksItem,
    requestKey: string,
  ) => Effect.Effect<WorkflowAgentStart, OrchestratorMcpFailure>;
  readonly readAgent: (
    workflow: WorkflowContext,
    taskId: NodeId,
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

interface WaitingAgent {
  readonly childThreadId: ThreadId;
  readonly stallMs: number;
  readonly attemptTimeoutMs?: number;
  /** The thread's last recorded update, and when this runner first saw it. */
  lastUpdatedAt?: number;
  seenAt?: number;
  /** When this runner first saw the attempt, if its thread records no run start. */
  firstSeenAt?: number;
  /** Its deadline passed and the runner asked it to stop. */
  timedOut?: boolean;
}

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
  private readonly terminal = new Set<string>();
  private readonly waiting = new Map<string, WaitingAgent>();
  private readonly stalled = new Set<string>();
  private readonly timedOut = new Set<string>();
  private spentTokens = 0;
  private readonly writeHolds = new Map<number, ReadonlyArray<string>>();
  private readonly scopeWaiters = new Set<() => void>();
  private readonly waiters = new Map<string, () => void>();
  private updating: Promise<void> | undefined;
  private updatePending = false;
  private readonly workflow: WorkflowContext;
  private readonly deps: WorkflowRunnerDeps;

  constructor(workflow: WorkflowContext, deps: WorkflowRunnerDeps) {
    this.workflow = workflow;
    this.deps = deps;
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

  /** Members and the row itself report through the thread's subagent updates. */
  observe(task: OrchestrationV2Subagent): void {
    if (task.id === this.workflow.workflowId) {
      if (task.status !== "running") this.abort.abort();
      return;
    }
    if (!TERMINAL_TASK_STATUSES.has(task.status) || task.result === null) return;
    this.terminal.add(task.id);
    this.waiters.get(task.id)?.();
    this.waiters.delete(task.id);
  }

  async run(): Promise<void> {
    const outcome = await runWorkflowScript({
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
    if (this.abort.signal.aborted) return;
    await this.flush();
    await this.dispatch({
      type: "workflow.complete",
      commandId: CommandId.make(`command:workflow-complete:${this.workflow.workflowId}`),
      threadId: this.workflow.threadId,
      workflowId: this.workflow.workflowId,
      status: outcome.ok ? "completed" : "failed",
      result: outcome.ok
        ? truncate(JSON.stringify(outcome.value ?? null, null, 2), WORKFLOW_RESULT_LIMIT)
        : truncate(`The workflow failed: ${outcome.message}`, WORKFLOW_RESULT_LIMIT),
    });
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
      budget: () => ({ total: this.workflow.budgetTokens ?? null, spent: this.spentTokens }),
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
    };
  }

  /**
   * The script's agent(): the result, or null when the agent failed. With `report: true`
   * it always resolves to an AgentReport, so a graph can record why a node failed.
   */
  private async agent(request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
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
  }): Promise<{
    readonly value: unknown;
    readonly entry: MutableAgent;
    readonly declaresOutputs: boolean;
  }> {
    if (this.agents.length >= MAX_AGENTS_PER_WORKFLOW) {
      throw new Error(`This workflow reached its limit of ${MAX_AGENTS_PER_WORKFLOW} agents.`);
    }
    const options = request.options;
    const phase = stringOption(options, "phase") ?? this.currentPhase;
    if (phase !== undefined) this.addPhase(phase);
    const label = stringOption(options, "label") ?? `agent ${this.agents.length + 1}`;
    const model = stringOption(options, "model");
    const target = options.target ?? (model === undefined ? undefined : { model });
    let check: WorkflowCheck | undefined;
    let scopes: FileScopes | undefined;
    let inputs: ReadonlyArray<FileRef> = [];
    let outputs: ReadonlyArray<FileRef> = [];
    let attemptTimeoutMs: number | undefined;
    let invalid: string | undefined;
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
          label,
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
        this.spentTokens >= budget &&
        !(await Effect.runPromise(
          this.deps.agentStarted(this.workflow, key).pipe(Effect.orElseSucceed(() => false)),
        ))
      ) {
        const message = `The workflow's budget of ${budget} tokens is spent (${this.spentTokens} used).`;
        settle("failed", message);
        throw new Error(message);
      }
      // An input that changed since the script pinned it would make the work answer another question.
      const inputProblem = await this.inputProblem(inputs);
      if (inputProblem !== undefined) {
        settle("failed", `agent "${label}": ${inputProblem}`);
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
      entry.attemptTaskIds = [...(entry.attemptTaskIds ?? []), started.value.taskId];
      delete entry.outcomeCategory;
      entry.childThreadId = started.value.childThreadId;
      if (started.value.model !== null) entry.model = started.value.model;
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
      await this.waitForTask(started.value.taskId);
      this.waiting.delete(started.value.taskId);
      const outcome = await Effect.runPromiseExit(
        this.deps.readAgent(this.workflow, started.value.taskId),
      );
      if (Exit.isFailure(outcome)) {
        settle("failed", failureMessage(outcome, "The agent's result could not be read."));
        return null;
      }
      const { status, summary, structuredResult, structuredResultError } = outcome.value;
      this.spentTokens += outcome.value.usage.totalTokens ?? 0;
      if (outcome.value.usage.totalTokens !== null) {
        entry.totalTokens = (entry.totalTokens ?? 0) + outcome.value.usage.totalTokens;
      }
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
      if (outputs.length > 0) {
        const found = await this.outputFiles(outputs);
        if ("files" in found) produced = found.files;
        checkType = "outputs";
        checked = found.outcome;
      }
      if (check !== undefined && (checked === undefined || checked.outcome === "passed")) {
        checkType = check.type;
        checked = await this.runCheck({
          check,
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
        });
      }
      const returned = (result: unknown) =>
        produced === undefined ? result : { result, outputs: produced };
      if (checked === undefined || checkType === undefined) {
        settle("completed", summary);
        if (options.schema !== undefined && structuredResultError !== undefined) {
          entry.outcomeCategory = "check_failed";
          this.progress = truncate(`agent "${label}": ${structuredResultError}`, PREVIEW_LIMIT);
          return null;
        }
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

  /** Why the declared inputs cannot be used as they are, or undefined when they can. */
  private async inputProblem(inputs: ReadonlyArray<FileRef>): Promise<string | undefined> {
    for (const input of inputs) {
      const found = await this.readFile(input);
      if (typeof found === "string") return `input ${input.id}: ${found}`;
      if (found.status === "missing") return `input ${input.id} (${input.path}) does not exist.`;
      if (found.status === "too_large") {
        return `input ${input.id} (${input.path}) is larger than its ${input.maxBytes}-byte bound.`;
      }
      if (input.sha256 !== undefined && found.sha256 !== input.sha256) {
        return `input ${input.id} (${input.path}) changed: expected sha256 ${input.sha256}, found ${found.sha256}.`;
      }
    }
    return undefined;
  }

  /** The written outputs, or the check outcome that says which are missing or too large. */
  private async outputFiles(
    outputs: ReadonlyArray<FileRef>,
  ): Promise<
    | { readonly outcome: CheckOutcome; readonly files: Readonly<Record<string, ProducedFile>> }
    | { readonly outcome: CheckOutcome }
  > {
    const files: Record<string, ProducedFile> = {};
    const problems: Array<string> = [];
    for (const output of outputs) {
      const found = await this.readFile(output);
      if (typeof found === "string") {
        return { outcome: { outcome: "error", detail: `output ${output.id}: ${found}` } };
      }
      if (found.status === "missing") {
        problems.push(`output ${output.id} (${output.path}) was not written.`);
      } else if (found.status === "too_large") {
        problems.push(
          `output ${output.id} (${output.path}) is larger than its ${output.maxBytes}-byte bound.`,
        );
      } else {
        files[output.id] = { path: output.path, sha256: found.sha256, sizeBytes: found.sizeBytes };
      }
    }
    if (problems.length > 0) return { outcome: { outcome: "failed", detail: problems.join("\n") } };
    const written = outputs.map((output) => `${output.id} ${files[output.id]!.sha256}`);
    return { outcome: { outcome: "passed", detail: written.join("\n") }, files };
  }

  private async runCheck(input: {
    readonly check: WorkflowCheck;
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
  }): Promise<CheckOutcome> {
    const { check } = input;
    const output =
      check.type === "structured" && check.outputId !== undefined
        ? input.outputs.find((ref) => ref.id === check.outputId)
        : undefined;
    if (check.type === "structured" && output !== undefined) {
      const found = await this.readFile(output);
      if (typeof found === "string") return { outcome: "error", detail: found };
      if (found.status !== "found") {
        return { outcome: "failed", detail: `output ${output.id} (${output.path}) is unreadable.` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(found.text);
      } catch (error) {
        return {
          outcome: "failed",
          detail: `output ${output.id} (${output.path}) is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return check.requiredPointers.length + Object.keys(check.equals).length === 0
        ? { outcome: "passed", detail: `output ${output.id} holds JSON.` }
        : runStructuredCheck(check, parsed);
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
      const ran = await Effect.runPromiseExit(
        this.deps.runCommandCheck(
          this.workflow,
          input.childThreadId,
          check,
          resultText,
          input.files,
        ),
      );
      return Exit.isFailure(ran)
        ? { outcome: "error", detail: failureMessage(ran, "The check could not run.") }
        : ran.value;
    }
    // An agent of its own, so it is independent of the work it judges and shows in the workflow.
    const target = check.target ?? input.target;
    const verdict = await this.agent({
      prompt: judgmentPrompt({ task: input.prompt, result: resultText, rubric: check.rubric }),
      options: {
        label: `check ${input.label}`,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
        ...(target === undefined ? {} : { target }),
        schema: JUDGMENT_RESULT_SCHEMA,
      },
    });
    return judgmentOutcome(verdict);
  }

  private waitForTask(taskId: string): Promise<void> {
    return this.terminal.has(taskId)
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.set(taskId, resolve));
  }

  private addPhase(title: string): void {
    if (!this.phases.includes(title)) this.phases.push(title);
  }

  private snapshot(): OrchestrationV2SubagentWorkflow {
    return {
      ...(this.name === undefined ? {} : { name: this.name }),
      phases: this.phases.map((title, index) => ({ index, title })),
      agents: this.agents.map((agent) => ({ ...agent })),
    };
  }

  private dispatch(
    command: Parameters<WorkflowRunnerDeps["threads"]["dispatch"]>[0],
  ): Promise<void> {
    return Effect.runPromise(
      this.deps.threads.dispatch(command).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logDebug("A workflow row update was refused", {
            workflowId: this.workflow.workflowId,
            commandType: command.type,
            cause,
          }),
        ),
      ),
    );
  }

  private update(): Promise<void> {
    return this.dispatch({
      type: "workflow.update",
      commandId: CommandId.make(`command:workflow-update:${NodeCrypto.randomUUID()}`),
      threadId: this.workflow.threadId,
      workflowId: this.workflow.workflowId,
      workflow: this.snapshot(),
      ...(this.progress === undefined ? {} : { progress: this.progress }),
    });
  }

  // One row update in flight at a time; changes made meanwhile ride the next one,
  // so a burst of agent state changes costs one or two writes.
  private scheduleUpdate(): void {
    if (this.abort.signal.aborted) return;
    if (this.updating !== undefined) {
      this.updatePending = true;
      return;
    }
    this.updating = this.update().finally(() => {
      this.updating = undefined;
      if (this.updatePending) {
        this.updatePending = false;
        this.scheduleUpdate();
      }
    });
  }

  private async flush(): Promise<void> {
    while (this.updating !== undefined) await this.updating;
    await this.update();
  }
}

export const makeWorkflowRunner = (deps: WorkflowRunnerDeps) => {
  const running = new Map<NodeId, WorkflowSession>();

  const stopStalledAgents = Effect.fn("WorkflowRunner.stopStalledAgents")(function* (
    session: WorkflowSession,
    workflow: WorkflowContext,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [taskId, agent] of session.waitingAgents()) {
      const shell = yield* deps.threads
        .getThreadShell(agent.childThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null) continue;
      if (agent.timedOut === true) continue;
      if (agent.attemptTimeoutMs !== undefined) {
        // Each attempt is its own thread, so its run's start survives a server restart.
        agent.firstSeenAt ??= now;
        const startedAt = shell.latestRunStartedAt ?? shell.latestRunRequestedAt;
        const recorded = startedAt == null ? undefined : DateTime.toEpochMillis(startedAt);
        // A start stamped later than this runner's clock reads is not trusted.
        const start =
          recorded === undefined || recorded > now
            ? agent.firstSeenAt
            : Math.min(recorded, agent.firstSeenAt);
        if (now - start >= agent.attemptTimeoutMs) {
          agent.timedOut = true;
          session.markTimedOut(taskId);
          yield* deps.stopAgent(workflow, taskId as NodeId, agent.childThreadId, "timed_out").pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Unable to stop a workflow agent past its deadline", {
                taskId,
                cause,
              }),
            ),
          );
          continue;
        }
      }
      // Measured only on this runner's clock: the thread's stamp just has to stop moving.
      const updatedAt = DateTime.toEpochMillis(shell.updatedAt);
      if (agent.seenAt === undefined || agent.lastUpdatedAt !== updatedAt) {
        agent.lastUpdatedAt = updatedAt;
        agent.seenAt = now;
        continue;
      }
      if (now - agent.seenAt < agent.stallMs) continue;
      session.markStalled(taskId);
      yield* deps
        .stopAgent(workflow, taskId as NodeId, agent.childThreadId, "stalled")
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Unable to stop a stalled workflow agent", { taskId, cause }),
          ),
        );
    }
  });

  const run = Effect.fn("WorkflowRunner.run")(function* (
    session: WorkflowSession,
    workflow: WorkflowContext,
  ) {
    const watcher = yield* deps.threads
      .streamStoredEventsFrom({
        threadId: workflow.threadId,
        afterSequence: workflow.afterSequence,
        eventType: "subagent.updated",
      })
      .pipe(
        Stream.runForEach((stored) =>
          Effect.sync(() => {
            if (stored.event.type === "subagent.updated") session.observe(stored.event.payload);
          }),
        ),
        Effect.ignore,
        Effect.forkChild,
      );
    const sweep = yield* Effect.sleep(STALL_SWEEP_INTERVAL).pipe(
      Effect.andThen(stopStalledAgents(session, workflow)),
      Effect.forever,
      Effect.forkChild,
    );
    yield* Effect.promise(() => session.run());
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

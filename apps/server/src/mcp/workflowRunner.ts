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
  type FileScopes,
  JUDGMENT_RESULT_SCHEMA,
  judgmentOutcome,
  judgmentPrompt,
  parseCheck,
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
  /** Tokens its provider turns reported, as an estimate of its cost. */
  readonly tokens: number;
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
  /** Runs a process check in the agent's workspace; `result` backs the {{result}} token. */
  readonly runCommandCheck: (
    workflow: WorkflowContext,
    childThreadId: ThreadId,
    check: ProcessCheck,
    result: string,
  ) => Effect.Effect<CheckOutcome, OrchestratorMcpFailure>;
  readonly stopAgent: (
    workflow: WorkflowContext,
    taskId: NodeId,
    childThreadId: ThreadId,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

const decodeItem = Schema.decodeUnknownExit(OrchestratorMcpDelegateTasksItem);

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

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
  /** The thread's last recorded update, and when this runner first saw it. */
  lastUpdatedAt?: number;
  seenAt?: number;
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
        : `The workflow failed: ${outcome.message}`,
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

  private async agent(request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
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
    let invalid: string | undefined;
    try {
      if (options.verify !== undefined) check = parseCheck(options.verify);
      if (options.scopes !== undefined) scopes = parseScopes(options.scopes);
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
    const settle = (status: "completed" | "failed", result: string | null) => {
      entry.state = status;
      if (result !== null && result.trim().length > 0) {
        entry.result = truncate(result, RESULT_TEXT_LIMIT);
      }
      this.scheduleUpdate();
    };

    const itemFor = (feedback: string) =>
      decodeItem({
        task: `${request.prompt}${scopes === undefined ? "" : scopeInstructions(scopes)}${feedback}`,
        title: truncate(label, 500),
        ...(target === undefined ? {} : { target }),
        ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.schema === undefined ? {} : { resultSchema: options.schema }),
      });
    if (invalid !== undefined || Exit.isFailure(itemFor(""))) {
      settle("failed", `agent "${label}" has invalid options${invalid ? `: ${invalid}` : "."}`);
      return null;
    }
    if (check?.type === "structured" && options.schema === undefined) {
      settle("failed", `agent "${label}": a structured check needs a schema for the result.`);
      return null;
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
      return null;
    }
    // Agents sharing a checkout never write the same files at once.
    const holdsWrites =
      scopes !== undefined && scopes.write.length > 0 && options.isolation !== "worktree";
    if (holdsWrites) await this.acquireWrites(entry.index, scopes!.write, label);
    try {
      return await this.runAttempts({
        request,
        options,
        entry,
        label,
        phase,
        target,
        digest,
        occurrence,
        check,
        itemFor,
        settle,
      });
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
      itemFor,
      settle,
    } = input;
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
      const started = await Effect.runPromiseExit(
        this.deps.spawnAgent(this.workflow, item.value, key),
      );
      if (Exit.isFailure(started)) {
        settle("failed", failureMessage(started, "The agent could not start."));
        return null;
      }
      entry.agentId = started.value.taskId;
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
      this.spentTokens += outcome.value.tokens;
      entry.totalTokens = (entry.totalTokens ?? 0) + outcome.value.tokens;
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
      if (check === undefined) {
        settle("completed", summary);
        if (options.schema === undefined) return summary;
        if (structuredResultError !== undefined) {
          this.progress = truncate(`agent "${label}": ${structuredResultError}`, PREVIEW_LIMIT);
          return null;
        }
        return structuredResult ?? null;
      }
      const checked = await this.runCheck({
        check,
        prompt: request.prompt,
        label,
        phase,
        target,
        childThreadId: started.value.childThreadId,
        summary,
        structuredResult,
        structuredResultError,
      });
      entry.verification = {
        type: check.type,
        outcome: checked.outcome,
        attempts: attempt + 1,
        ...(checked.detail.trim().length === 0
          ? {}
          : { detail: truncate(checked.detail, RESULT_TEXT_LIMIT) }),
      };
      if (checked.outcome === "passed") {
        settle("completed", summary);
        return options.schema === undefined ? summary : (structuredResult ?? null);
      }
      // A failed check is a judgment on the work, so the agent tries again with what the
      // check saw. A check that could not run is not, and retrying the agent would not fix it.
      if (checked.outcome === "failed" && attempt + 1 < MAX_AGENT_ATTEMPTS) {
        feedback = checkFeedback(check, checked);
        this.progress = truncate(
          `agent "${label}" failed its ${check.type} check; starting it again.`,
          PREVIEW_LIMIT,
        );
        entry.state = "running";
        this.scheduleUpdate();
        continue;
      }
      settle(
        "failed",
        `Its ${check.type} check ${checked.outcome === "error" ? "could not run" : "failed"}: ${checked.detail}`,
      );
      return null;
    }
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
  }): Promise<CheckOutcome> {
    const { check } = input;
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
        this.deps.runCommandCheck(this.workflow, input.childThreadId, check, resultText),
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
        .stopAgent(workflow, taskId as NodeId, agent.childThreadId)
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

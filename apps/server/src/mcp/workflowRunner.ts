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
  type OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { runWorkflowScript, type WorkflowScriptHost } from "./workflowScript.ts";

/** Claude Code's documented per-run ceiling. */
const MAX_AGENTS_PER_WORKFLOW = 1000;
const RESULT_TEXT_LIMIT = 2_000;
const WORKFLOW_RESULT_LIMIT = 16_000;
const PREVIEW_LIMIT = 500;
const ARGS_HEADER = "// t3-workflow-args: ";

export interface WorkflowContext {
  readonly workflowId: NodeId;
  readonly threadId: ThreadId;
  readonly source: string;
  readonly args: unknown;
  /** Stored event sequence before the workflow row was created. */
  readonly afterSequence: number;
}

export interface WorkflowAgentStart {
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
  readonly model: string | null;
}

export interface WorkflowAgentOutcome {
  readonly status: string;
  readonly summary: string | null;
  readonly structuredResult?: unknown;
  readonly structuredResultError?: string;
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
}

/** The row stores the script and its args together, so a resumed run sees both. */
export function storedWorkflowScript(source: string, args: unknown): string {
  return args === undefined ? source : `${ARGS_HEADER}${JSON.stringify(args)}\n${source}`;
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

function failureMessage<A>(exit: Exit.Exit<A, OrchestratorMcpFailure>, fallback: string): string {
  const failure = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
  return failure?._tag === "Some" ? failure.value.message : fallback;
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
  private readonly waiters = new Map<string, () => void>();
  private updating: Promise<void> | undefined;
  private updatePending = false;
  private readonly workflow: WorkflowContext;
  private readonly deps: WorkflowRunnerDeps;

  constructor(workflow: WorkflowContext, deps: WorkflowRunnerDeps) {
    this.workflow = workflow;
    this.deps = deps;
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

    const item = decodeItem({
      task: request.prompt,
      title: truncate(label, 500),
      ...(target === undefined ? {} : { target }),
      ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.schema === undefined ? {} : { resultSchema: options.schema }),
    });
    if (Exit.isFailure(item)) {
      settle("failed", `agent "${label}" has invalid options.`);
      return null;
    }
    const started = await Effect.runPromiseExit(
      this.deps.spawnAgent(this.workflow, item.value, `wf-${digest}-${occurrence}`),
    );
    if (Exit.isFailure(started)) {
      settle("failed", failureMessage(started, "The agent could not start."));
      return null;
    }
    entry.agentId = started.value.taskId;
    entry.childThreadId = started.value.childThreadId;
    if (started.value.model !== null) entry.model = started.value.model;
    entry.state = "running";
    this.scheduleUpdate();
    await this.waitForTask(started.value.taskId);
    const outcome = await Effect.runPromiseExit(
      this.deps.readAgent(this.workflow, started.value.taskId),
    );
    if (Exit.isFailure(outcome)) {
      settle("failed", failureMessage(outcome, "The agent's result could not be read."));
      return null;
    }
    const { status, summary, structuredResult, structuredResultError } = outcome.value;
    if (status !== "completed") {
      settle("failed", summary ?? `The agent ended ${status}.`);
      return null;
    }
    settle("completed", summary);
    if (options.schema === undefined) return summary;
    if (structuredResultError !== undefined) {
      this.progress = truncate(`agent "${label}": ${structuredResultError}`, PREVIEW_LIMIT);
      return null;
    }
    return structuredResult ?? null;
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
  const running = new Set<NodeId>();

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
    yield* Effect.promise(() => session.run());
    yield* Fiber.interrupt(watcher);
  });

  return {
    isRunning: (workflowId: NodeId) => running.has(workflowId),
    /** Starts the script once per process; a retried start finds it running. */
    launch: (workflow: WorkflowContext) =>
      Effect.suspend(() => {
        if (running.has(workflow.workflowId)) return Effect.void;
        running.add(workflow.workflowId);
        return run(new WorkflowSession(workflow, deps), workflow).pipe(
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

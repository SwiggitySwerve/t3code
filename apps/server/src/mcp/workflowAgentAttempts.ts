/**
 * One workflow agent's attempts: starts the task, waits for it, runs the agent's check on its
 * result, and starts it again when the work or its check fails. The runner session owns the
 * script, the row updates and the completion; it reaches this module only through
 * `AgentAttemptHost`.
 */
import type {
  NodeId,
  OrchestrationV2WorkflowAgent,
  OrchestratorMcpDelegateTasksItem,
  ThreadId,
  WorkflowAgentTargetSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Schema from "effect/Schema";

import {
  CHECKER_RESULT_FILE_BYTES,
  type CheckOutcome,
  checkFeedback,
  type FileRef,
  inputProblem,
  JUDGMENT_RESULT_SCHEMA,
  judgmentOutcome,
  judgmentPrompt,
  outputFiles,
  type ProducedFile,
  runStructuredCheck,
  structuredOutputCheck,
  type WorkflowCheck,
  type WorkspaceFile,
} from "./workflowChecks.ts";
import {
  boundText,
  fullOutputAt,
  HANDOFF_SUMMARY_BYTES,
  judgedResultFits,
  taskOutputAt,
} from "./workflowHandoff.ts";
import { MAX_AGENT_ATTEMPTS, MAX_INFRA_RETRIES, workAttempts } from "./workflowLimits.ts";
import { attemptTarget, retryMoveText, type RetryTarget } from "./workflowRetries.ts";
import type { WaitingAgent } from "./workflowSweep.ts";
import type {
  WorkflowAgentOutcome,
  WorkflowAgentStart,
  WorkflowContext,
  WorkflowRunnerDeps,
} from "./workflowRunner.ts";

/**
 * An agent whose thread records nothing for this long is stopped and started again.
 * Generous, because a long tool call can be silent; `stallTimeoutMs` overrides it.
 */
const DEFAULT_STALL_MS = 20 * 60_000;
const MIN_STALL_MS = 60_000;

export const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

type AttemptRecord = NonNullable<OrchestrationV2WorkflowAgent["attemptHistory"]>[number];
export type AttemptStopReason = NonNullable<AttemptRecord["stoppedBy"]>;

export type MutableAgent = Pick<OrchestrationV2WorkflowAgent, "index"> & {
  -readonly [
    Key in keyof Omit<OrchestrationV2WorkflowAgent, "index">
  ]: OrchestrationV2WorkflowAgent[Key];
};

export function agentAttemptKey(requestKey: string, attempt: number): string {
  return `${requestKey}${attempt === 0 ? "" : `-r${attempt}`}`;
}

export function agentRequestKey(attemptKey: string): string | undefined {
  const match = /^(wf-[0-9a-f]{24}-(?:0|[1-9][0-9]*))(?:-r([1-9][0-9]*))?$/.exec(attemptKey);
  return match !== null && Number(match[2] ?? 0) < MAX_AGENT_ATTEMPTS ? match[1] : undefined;
}

function numberOption(options: Readonly<Record<string, unknown>>, key: string) {
  const value = options[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The resolved options by id, and the effort among them under either provider's name. */
function resolvedOptions(options: WorkflowAgentStart["options"]) {
  if (options === undefined || options.length === 0) return undefined;
  const byId = Object.fromEntries(options.map((option) => [option.id, option.value]));
  const effort = byId.reasoningEffort ?? byId.effort;
  return { byId, effort: typeof effort === "string" ? effort : undefined };
}

function failureMessage<A>(
  exit: Exit.Exit<A, { readonly message: string }>,
  fallback: string,
): string {
  const failure = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
  return failure?._tag === "Some" ? failure.value.message : fallback;
}

/** What the attempts need from the session that runs the script; the session keeps the rest. */
export interface AgentAttemptHost {
  readonly workflow: WorkflowContext;
  readonly deps: Pick<
    WorkflowRunnerDeps,
    | "spawnAgent"
    | "awaitAgent"
    | "agentStarted"
    | "runCommandCheck"
    | "readWorkspaceFile"
    | "writeCheckerResult"
    | "removeCheckerResult"
  >;
  /** Aborts when the workflow is stopped or the server detaches the runner. */
  readonly signal: AbortSignal;
  /** Attempts being waited on, which the stall sweep reads. */
  readonly waiting: Map<string, WaitingAgent>;
  /** Why the runner stopped an attempt: this run's sweep, else what an earlier run recorded. */
  stoppedBy(taskId: string): AttemptStopReason | undefined;
  /** Tokens the workflow's agents have recorded so far. */
  spentTokens(): number;
  markBudgetExhausted(): void;
  /** The workflow's one-line progress note; the next row update carries it. */
  setProgress(message: string): void;
  scheduleUpdate(): void;
  /** Runs a judge as an agent of its own, so it shows in the workflow. */
  runAgent(request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
    readonly keyLabel: null;
    readonly judgmentFor: NonNullable<OrchestrationV2WorkflowAgent["judgmentFor"]>;
    readonly targetSource?: WorkflowAgentTargetSource | undefined;
  }): Promise<{ readonly value: unknown; readonly entry: MutableAgent }>;
}

export interface AgentAttemptInput {
  readonly request: {
    readonly prompt: string;
    readonly options: Readonly<Record<string, unknown>>;
  };
  readonly options: Readonly<Record<string, unknown>>;
  readonly entry: MutableAgent;
  readonly label: string;
  readonly phase: string | undefined;
  /** The first attempt's target; a judgment check without its own runs on it. */
  readonly target: unknown;
  readonly retries: ReadonlyArray<RetryTarget> | undefined;
  readonly requestKey: string;
  readonly check: WorkflowCheck | undefined;
  readonly inputs: ReadonlyArray<FileRef>;
  readonly outputs: ReadonlyArray<FileRef>;
  readonly attemptTimeoutMs: number | undefined;
  readonly itemFor: (
    feedback: string,
    target: unknown,
  ) => Exit.Exit<OrchestratorMcpDelegateTasksItem, Schema.SchemaError>;
  readonly settle: (status: "completed" | "failed", result: string | null) => void;
}

/**
 * Runs the agent until it passes, fails for good or the workflow stops, and returns the value
 * the script gets (null when the agent failed). The caller settles nothing after it: every
 * outcome is settled here through `input.settle`.
 */
export async function runAttempts(
  host: AgentAttemptHost,
  input: AgentAttemptInput,
): Promise<unknown> {
  const {
    request,
    options,
    entry,
    label,
    phase,
    target,
    retries,
    requestKey,
    check,
    inputs,
    outputs,
    attemptTimeoutMs,
    itemFor,
    settle,
  } = input;
  const allowedWork = workAttempts(retries);
  const files = Object.fromEntries([
    ...inputs.map((ref) => [`input:${ref.id}`, ref.path] as const),
    ...outputs.map((ref) => [`output:${ref.id}`, ref.path] as const),
  ]);
  let feedback = "";
  // Work failures use the agent's attempts; infrastructure faults retry beside them.
  let workFailures = 0;
  let infraFaults = 0;
  // Names the retry target the next attempt moves to, when it moves.
  const onNextTarget = () => {
    const next = attemptTarget(target, retries, workFailures);
    const previous = attemptTarget(target, retries, workFailures - 1);
    return next === previous ? "" : ` ${retryMoveText(previous, next as RetryTarget)}`;
  };
  // A run from before these limits may have started the next attempt already. It is attached
  // again rather than left running with no owner.
  const nextAttemptStarted = async (attempt: number) =>
    attempt + 1 < MAX_AGENT_ATTEMPTS &&
    (await Effect.runPromise(
      host.deps
        .agentStarted(host.workflow, agentAttemptKey(requestKey, attempt + 1))
        .pipe(Effect.orElseSucceed(() => false)),
    ));
  for (let attempt = 0; ; attempt += 1) {
    const item = itemFor(feedback, attemptTarget(target, retries, workFailures));
    if (Exit.isFailure(item)) {
      settle("failed", `agent "${label}" has invalid options.`);
      return null;
    }
    const key = agentAttemptKey(requestKey, attempt);
    const budget = host.workflow.budgetTokens;
    // An agent the budget allowed before a restart is re-attached, not refused.
    if (
      budget !== undefined &&
      host.spentTokens() >= budget &&
      !(await Effect.runPromise(
        host.deps.agentStarted(host.workflow, key).pipe(Effect.orElseSucceed(() => false)),
      ))
    ) {
      host.markBudgetExhausted();
      const message = `The workflow's budget of ${budget} tokens is spent (${host.spentTokens()} recorded). New agents will not start; already-running agents may exceed this budget.`;
      settle("failed", message);
      throw new Error(message);
    }
    // An input that changed since the script pinned it would make the work answer another question.
    const inputIssue = await inputProblem(inputs, (ref) => readFile(host, ref));
    if (inputIssue !== undefined) {
      settle("failed", `agent "${label}": ${inputIssue}`);
      return null;
    }
    const started = await Effect.runPromiseExit(
      host.deps.spawnAgent(host.workflow, item.value, key),
    );
    if (Exit.isFailure(started)) {
      settle("failed", failureMessage(started, "The agent could not start."));
      return null;
    }
    entry.agentId = started.value.taskId;
    entry.attemptTaskIds = [...new Set([...(entry.attemptTaskIds ?? []), started.value.taskId])];
    const resolved = resolvedOptions(started.value.options);
    const { speed } = started.value;
    const recordAttempt = (outcome?: WorkflowAgentOutcome) => {
      const history = (entry.attemptHistory ?? []).filter(
        (record) => record.taskId !== started.value.taskId,
      );
      const stoppedBy = host.stoppedBy(started.value.taskId);
      entry.attemptHistory = [
        ...history,
        {
          taskId: started.value.taskId,
          childThreadId: started.value.childThreadId,
          attempt,
          providerInstanceId: started.value.providerInstanceId,
          ...(started.value.model === null ? {} : { model: started.value.model }),
          ...(resolved?.effort === undefined ? {} : { effort: resolved.effort }),
          ...(resolved === undefined ? {} : { options: resolved.byId }),
          ...(speed === undefined ? {} : { speed }),
          ...(stoppedBy === undefined ? {} : { stoppedBy }),
          state:
            outcome !== undefined && TERMINAL_TASK_STATUSES.has(outcome.status)
              ? (outcome.status as "completed" | "failed" | "cancelled" | "interrupted")
              : "running",
          usageStatus: outcome?.usage.status ?? "unavailable",
          ...(outcome?.usage.totalTokens == null ? {} : { totalTokens: outcome.usage.totalTokens }),
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
    if (resolved === undefined) delete entry.options;
    else entry.options = resolved.byId;
    if (resolved?.effort === undefined) delete entry.effort;
    else entry.effort = resolved.effort;
    entry.providerInstanceId = started.value.providerInstanceId;
    entry.driver = started.value.driver;
    if (attempt > 0) entry.attempt = attempt;
    entry.state = "running";
    host.scheduleUpdate();
    host.waiting.set(started.value.taskId, {
      childThreadId: started.value.childThreadId,
      stallMs: Math.max(MIN_STALL_MS, numberOption(options, "stallTimeoutMs") ?? DEFAULT_STALL_MS),
      ...(attemptTimeoutMs === undefined ? {} : { attemptTimeoutMs }),
    });
    const outcome = await Effect.runPromiseExit(
      host.deps.awaitAgent(host.workflow, started.value.taskId, (current) => {
        if (host.signal.aborted) return;
        if (TERMINAL_TASK_STATUSES.has(current.status)) host.waiting.delete(started.value.taskId);
        recordAttempt(current);
        host.scheduleUpdate();
      }),
      { signal: host.signal },
    );
    host.waiting.delete(started.value.taskId);
    if (host.signal.aborted) return null;
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
    const stopReason = host.stoppedBy(started.value.taskId);
    if (status !== "completed" && stopReason === "timed_out") {
      const passed = `passed its time budget of ${attemptTimeoutMs} ms and was stopped`;
      workFailures += 1;
      if (workFailures < allowedWork || (await nextAttemptStarted(attempt))) {
        feedback = `\n\nYour previous attempt ${passed}. Work more directly and finish within the budget.`;
        host.setProgress(`agent "${label}" ${passed}; starting it again${onNextTarget()}.`);
        continue;
      }
      entry.outcomeCategory = "timed_out";
      settle("failed", `Its last work attempt ${passed}.`);
      return null;
    }
    if (status !== "completed") {
      const fault =
        status === "failed" ||
        ((status === "cancelled" || status === "interrupted") &&
          (outcome.value.cancelledByServerRestart || stopReason === "stalled"));
      if (fault) infraFaults += 1;
      if (
        fault &&
        ((infraFaults <= MAX_INFRA_RETRIES && attempt + 1 < MAX_AGENT_ATTEMPTS) ||
          (await nextAttemptStarted(attempt)))
      ) {
        host.setProgress(`agent "${label}" ended ${status}; starting it again.`);
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
      const found = await outputFiles(outputs, (ref) => readFile(host, ref));
      if ("files" in found) produced = found.files;
      checkType = "outputs";
      checked = found.outcome;
    }
    if (check !== undefined && (checked === undefined || checked.outcome === "passed")) {
      checkType = check.type;
      checked = await runCheck(host, {
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
        taskId: started.value.taskId,
        childThreadId: started.value.childThreadId,
        workerSource: entry.targetSource,
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
        : { detail: boundText(checked.detail, HANDOFF_SUMMARY_BYTES) }),
    };
    if (checked.outcome === "passed") {
      settle("completed", summary);
      return returned(value);
    }
    // A failed check is a judgment on the work, so the agent tries again with what the
    // check saw. A check that could not run is not, and retrying the agent would not fix it.
    if (checked.outcome === "failed") workFailures += 1;
    if (
      checked.outcome === "failed" &&
      (workFailures < allowedWork || (await nextAttemptStarted(attempt)))
    ) {
      feedback = checkFeedback(checkType, checked);
      host.setProgress(
        `agent "${label}" failed its ${checkType} check; starting it again${onNextTarget()}.`,
      );
      entry.state = "running";
      host.scheduleUpdate();
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

function readFile(host: AgentAttemptHost, ref: FileRef): Promise<WorkspaceFile | string> {
  return Effect.runPromise(
    host.deps
      .readWorkspaceFile(host.workflow, ref.path, ref.maxBytes)
      .pipe(
        Effect.catch((failure) =>
          Effect.succeed(`${ref.path} could not be read: ${failure.message}`),
        ),
      ),
  );
}

/**
 * Writes the answer a checker is shown cut as a file it can read, bounded like a declared file; the
 * file's own end says where the whole answer is for the coordinator. Undefined when it cannot be
 * written: the checker then sees the cut marker alone, which says the result is partial.
 */
async function storeCheckerResult(
  host: AgentAttemptHost,
  input: { readonly taskId: NodeId },
  answer: string,
): Promise<string | undefined> {
  const bounded = boundText(answer, CHECKER_RESULT_FILE_BYTES, taskOutputAt(input.taskId));
  return Effect.runPromise(
    host.deps
      .writeCheckerResult(host.workflow, input.taskId, bounded)
      .pipe(Effect.catch(() => Effect.undefined)),
  );
}

async function runCheck(
  host: AgentAttemptHost,
  input: {
    readonly check: WorkflowCheck;
    readonly judgmentFor: NonNullable<OrchestrationV2WorkflowAgent["judgmentFor"]>;
    readonly prompt: string;
    readonly label: string;
    readonly phase: string | undefined;
    readonly target: unknown;
    readonly taskId: NodeId;
    readonly childThreadId: ThreadId;
    readonly workerSource: WorkflowAgentTargetSource | undefined;
    readonly summary: string | null;
    readonly structuredResult: unknown;
    readonly structuredResultError: string | undefined;
    readonly files: Readonly<Record<string, string>>;
    readonly outputs: ReadonlyArray<FileRef>;
    readonly isolation: unknown;
  },
): Promise<CheckOutcome> {
  const { check } = input;
  const output =
    check.type === "structured" && check.outputId !== undefined
      ? input.outputs.find((ref) => ref.id === check.outputId)
      : undefined;
  if (check.type === "structured" && output !== undefined) {
    return structuredOutputCheck(check, output, (ref) => readFile(host, ref));
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
      host.deps.runCommandCheck(host.workflow, input.childThreadId, check, resultText, input.files),
      { signal: host.signal },
    );
    return Exit.isFailure(ran)
      ? { outcome: "error", detail: failureMessage(ran, "The check could not run.") }
      : ran.value;
  }
  // An agent of its own, so it is independent of the work it judges and shows in the workflow.
  const target = check.target ?? input.target;
  // The checker sees a cut copy of a long answer. It cannot read the answer's task, so the whole
  // answer is a file, outside the checkout, for the length of the check; the cut copy points to its
  // absolute path.
  const stored = judgedResultFits(resultText)
    ? undefined
    : await storeCheckerResult(host, input, resultText);
  let verdict: Awaited<ReturnType<AgentAttemptHost["runAgent"]>>;
  try {
    verdict = await host.runAgent({
      prompt: judgmentPrompt({
        task: input.prompt,
        result: resultText,
        ...(stored === undefined ? {} : { fullOutput: fullOutputAt(stored) }),
        rubric: check.rubric,
        workspaceVisible: input.isolation !== "worktree",
      }),
      // Its prompt already pins the work it judges; a generated worker label would not.
      keyLabel: null,
      judgmentFor: input.judgmentFor,
      targetSource: check.target === undefined ? input.workerSource : "target",
      options: {
        label: `check ${input.label}`,
        ...(input.phase === undefined ? {} : { phase: input.phase }),
        ...(target === undefined ? {} : { target }),
        schema: JUDGMENT_RESULT_SCHEMA,
      },
    });
  } catch (error) {
    return {
      outcome: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (stored !== undefined) {
      await Effect.runPromise(
        host.deps.removeCheckerResult(host.workflow, stored).pipe(Effect.ignore),
      );
    }
  }
  // A checker that did not finish gave no verdict; the reason it settled with says why.
  const outcome: CheckOutcome =
    verdict.entry.state === "completed"
      ? judgmentOutcome(verdict.value)
      : { outcome: "error", detail: verdict.entry.result ?? "The checker did not finish." };
  verdict.entry.judgmentOutcome = outcome.outcome;
  host.scheduleUpdate();
  return outcome;
}

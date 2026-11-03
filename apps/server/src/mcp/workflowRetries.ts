/**
 * An agent's `retries`: the targets of its work attempts after the first, in order, as the
 * coordinator wrote them. Each names its provider and model, so T3 never chooses one.
 */
import { modelFamily } from "./workflowAdvisory.ts";
import { MAX_RETRY_TARGETS } from "./workflowLimits.ts";

export interface RetryTarget {
  readonly providerInstanceId: string;
  readonly model: string;
  readonly options?: unknown;
  readonly inheritOptions?: unknown;
}

const RETRY_TARGET_KEYS: ReadonlySet<string> = new Set([
  "providerInstanceId",
  "model",
  "options",
  "inheritOptions",
]);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function parseRetries(value: unknown): ReadonlyArray<RetryTarget> {
  if (!Array.isArray(value)) throw new Error("retries must be an array of targets.");
  if (value.length > MAX_RETRY_TARGETS)
    throw new Error(`retries takes at most ${MAX_RETRY_TARGETS} targets.`);
  return value.map((entry: unknown, index) => {
    const what = `retries[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new Error(`${what} must be a target object.`);
    const rung = entry as Readonly<Record<string, unknown>>;
    const extra = Object.keys(rung).find((key) => !RETRY_TARGET_KEYS.has(key));
    // Every workflow agent runs in the caller's environment, so a retry never moves to another.
    if (extra === "environmentId" || extra === "projectId")
      throw new Error(
        `${what} cannot set ${extra}: workflow agents run in this thread's environment.`,
      );
    if (extra !== undefined)
      throw new Error(
        `${what} takes providerInstanceId, model, options and inheritOptions, not ${extra}.`,
      );
    if (!nonEmpty(rung.providerInstanceId) || !nonEmpty(rung.model))
      throw new Error(
        `${what} needs a providerInstanceId and a model from orchestrator_capabilities.`,
      );
    return {
      providerInstanceId: rung.providerInstanceId.trim(),
      model: rung.model.trim(),
      ...(rung.options === undefined ? {} : { options: rung.options }),
      ...(rung.inheritOptions === undefined ? {} : { inheritOptions: rung.inheritOptions }),
    };
  });
}

/**
 * The target of the work attempt after `workFailures` failed ones. Infrastructure retries do not
 * count, so they repeat their attempt's target; an attempt past the list keeps its last entry.
 */
export function attemptTarget(
  target: unknown,
  retries: ReadonlyArray<RetryTarget> | undefined,
  workFailures: number,
): unknown {
  if (workFailures === 0 || retries === undefined || retries.length === 0) return target;
  return retries[Math.min(workFailures, retries.length) - 1];
}

const recordOf = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;

/** The effort a target's options set, in the list or the record form a target may use. */
function effortOf(options: unknown): string | undefined {
  const byId = new Map<unknown, unknown>(
    Array.isArray(options)
      ? options.map((option: unknown) => [recordOf(option)?.id, recordOf(option)?.value])
      : Object.entries(recordOf(options) ?? {}),
  );
  const effort = byId.get("reasoningEffort") ?? byId.get("effort");
  return typeof effort === "string" ? effort : undefined;
}

/**
 * How progress names the move to a retry target: by its model, or by its effort alone when it
 * keeps the model of the attempt before it.
 */
export function retryMoveText(previous: unknown, next: RetryTarget): string {
  const effort = effortOf(next.options);
  return recordOf(previous)?.model === next.model && effort !== undefined
    ? `at ${effort} effort`
    : `on ${next.model}`;
}

/**
 * A judgment check with no target of its own runs on the agent's first target. When a retry target
 * leaves that model's family, the check needs its own target. Both models are the resolved ones,
 * so a first target that inherits the caller's model is judged by that model.
 */
export function retriesCheckProblem(
  targetModel: string,
  retries: ReadonlyArray<{ readonly model: string }>,
): string | undefined {
  const family = modelFamily(targetModel);
  const other = retries.find((rung) => modelFamily(rung.model) !== family);
  if (other === undefined) return undefined;
  return `retries runs ${other.model} outside the model family of the first target (${targetModel}), so the judgment check needs a target of its own.`;
}

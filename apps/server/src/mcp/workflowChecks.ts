/**
 * Checks and file scopes for workflow agents. The rules follow the omx graph's protected
 * verifiers (~/.agents/graph/omx-upgrade/src/team/protected-verifier.ts): a process check is
 * an argv run without a shell and judged by its exit code; a structured check reads JSON
 * pointers from the agent's structured result; a judgment check asks a separate agent to
 * grade the result against a rubric. Limits match the graph's contract.
 */
import * as NodeUtil from "node:util";

const MAX_CHECK_ARGV_COUNT = 256;
const MAX_CHECK_ARGV_BYTES = 64 * 1024;
const MAX_CHECK_TIMEOUT_MS = 15 * 60_000;
const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_CHECK_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_CHECK_OUTPUT_BYTES = 64 * 1024;
const MAX_RUBRIC_CRITERIA = 20;
const MAX_SCOPE_PATHS = 64;
const FEEDBACK_LIMIT = 4_000;

export interface ProcessCheck {
  readonly type: "process";
  readonly argv: readonly [string, ...string[]];
  /** Workspace-relative directory. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly successExitCodes: ReadonlyArray<number>;
}

export interface StructuredCheck {
  readonly type: "structured";
  /** Reads this declared output file's JSON instead of the agent's structured result. */
  readonly outputId?: string;
  readonly requiredPointers: ReadonlyArray<string>;
  readonly equals: Readonly<Record<string, unknown>>;
}

export interface JudgmentCheck {
  readonly type: "judgment";
  readonly rubric: ReadonlyArray<string>;
  readonly target?: unknown;
}

export type WorkflowCheck = ProcessCheck | StructuredCheck | JudgmentCheck;

export interface CheckOutcome {
  readonly outcome: "passed" | "failed" | "error";
  /** What the check saw, for the agent's next attempt and for the record. */
  readonly detail: string;
}

/** A workspace file an agent reads or must write; `sha256` pins an input's exact bytes. */
export interface FileRef {
  readonly id: string;
  readonly path: string;
  readonly maxBytes: number;
  readonly sha256?: string;
}

export interface FileScopes {
  readonly read: ReadonlyArray<string>;
  readonly write: ReadonlyArray<string>;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function stringList(value: unknown, what: string, max: number): ReadonlyArray<string> {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${what} must be an array of strings.`);
  }
  if (value.length > max) throw new Error(`${what} takes at most ${max} entries.`);
  return value as ReadonlyArray<string>;
}

function boundedInt(value: unknown, what: string, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${what} must be a whole number from 1 to ${max}.`);
  }
  return value;
}

/** A workspace-relative path in one canonical form; throws for absolute or escaping paths. */
function normalizeWorkspacePath(path: string, what: string): string {
  const trimmed = path.trim().replaceAll("\\", "/");
  if (trimmed.length === 0) throw new Error(`${what} must not be empty.`);
  if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`${what} must be relative to the workspace: ${path}`);
  }
  const parts: Array<string> = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new Error(`${what} must stay inside the workspace: ${path}`);
    parts.push(part);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

/** Throws with the reason when the options do not describe a valid check. */
export function parseCheck(value: unknown): WorkflowCheck {
  const record = asRecord(value);
  if (record === undefined) throw new Error("verify must be an object with a type.");
  switch (record.type) {
    case "process": {
      const argv = stringList(record.argv, "verify.argv", MAX_CHECK_ARGV_COUNT);
      if (argv.length === 0 || argv[0]!.trim().length === 0) {
        throw new Error("verify.argv needs the executable as its first entry.");
      }
      if (argv.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0) > MAX_CHECK_ARGV_BYTES) {
        throw new Error(`verify.argv is longer than ${MAX_CHECK_ARGV_BYTES} bytes.`);
      }
      const codes = record.successExitCodes ?? [0];
      if (
        !Array.isArray(codes) ||
        codes.length === 0 ||
        codes.some((code) => typeof code !== "number" || !Number.isInteger(code))
      ) {
        throw new Error("verify.successExitCodes must be a non-empty array of whole numbers.");
      }
      return {
        type: "process",
        argv: argv as unknown as readonly [string, ...string[]],
        cwd: normalizeWorkspacePath(
          typeof record.cwd === "string" ? record.cwd : ".",
          "verify.cwd",
        ),
        timeoutMs: boundedInt(
          record.timeoutMs,
          "verify.timeoutMs",
          DEFAULT_CHECK_TIMEOUT_MS,
          MAX_CHECK_TIMEOUT_MS,
        ),
        maxOutputBytes: boundedInt(
          record.maxOutputBytes,
          "verify.maxOutputBytes",
          DEFAULT_CHECK_OUTPUT_BYTES,
          MAX_CHECK_OUTPUT_BYTES,
        ),
        successExitCodes: codes as ReadonlyArray<number>,
      };
    }
    case "structured": {
      const required = stringList(record.requiredPointers ?? [], "verify.requiredPointers", 256);
      const equals = record.equals === undefined ? {} : asRecord(record.equals);
      if (equals === undefined) throw new Error("verify.equals must map JSON pointers to values.");
      const outputId = record.outputId;
      if (outputId !== undefined && (typeof outputId !== "string" || !FILE_ID.test(outputId))) {
        throw new Error("verify.outputId must name one of the agent's outputs.");
      }
      const pointers = [...required, ...Object.keys(equals)];
      // An output check without pointers still requires the file to hold JSON.
      if (pointers.length === 0 && outputId === undefined) {
        throw new Error("A structured check needs at least one pointer.");
      }
      const bad = pointers.find((pointer) => pointer !== "" && !pointer.startsWith("/"));
      if (bad !== undefined) throw new Error(`"${bad}" is not a JSON pointer.`);
      return {
        type: "structured",
        ...(outputId === undefined ? {} : { outputId }),
        requiredPointers: required,
        equals,
      };
    }
    case "judgment": {
      const rubric = stringList(record.rubric, "verify.rubric", MAX_RUBRIC_CRITERIA);
      if (rubric.length === 0 || rubric.some((criterion) => criterion.trim().length === 0)) {
        throw new Error("verify.rubric needs at least one criterion.");
      }
      return {
        type: "judgment",
        rubric,
        ...(record.target === undefined ? {} : { target: record.target }),
      };
    }
    default:
      throw new Error('verify.type must be "process", "structured" or "judgment".');
  }
}

/** Ids of files, and of graph nodes, which name their outputs the same way. */
export const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_FILE_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_REFS = 32;

/** Throws with the reason when the inputs or outputs are malformed. */
export function parseFileRefs(value: unknown, what: "inputs" | "outputs"): ReadonlyArray<FileRef> {
  if (!Array.isArray(value)) throw new Error(`${what} must be an array.`);
  if (value.length > MAX_FILE_REFS)
    throw new Error(`${what} takes at most ${MAX_FILE_REFS} files.`);
  const refs = value.map((entry, index) => {
    const record = asRecord(entry);
    if (record === undefined || typeof record.id !== "string" || !FILE_ID.test(record.id)) {
      throw new Error(`${what}[${index}] needs an id of letters, digits, dot, dash or underscore.`);
    }
    if (typeof record.path !== "string") throw new Error(`${what}.${record.id} needs a path.`);
    const sha256 = record.sha256;
    if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) {
      throw new Error(`${what}.${record.id}.sha256 must be 64 lowercase hex digits.`);
    }
    return {
      id: record.id,
      path: normalizeWorkspacePath(record.path, `${what}.${record.id}.path`),
      maxBytes: boundedInt(
        record.maxBytes,
        `${what}.${record.id}.maxBytes`,
        DEFAULT_FILE_BYTES,
        MAX_FILE_BYTES,
      ),
      ...(sha256 === undefined ? {} : { sha256 }),
    } satisfies FileRef;
  });
  const ids = refs.map((ref) => ref.id);
  if (new Set(ids).size !== ids.length) throw new Error(`${what} ids must be unique.`);
  return refs;
}

/** The task text that names an agent's input and output files. */
export function fileInstructions(
  inputs: ReadonlyArray<FileRef>,
  outputs: ReadonlyArray<FileRef>,
): string {
  if (inputs.length === 0 && outputs.length === 0) return "";
  const lines = [""];
  if (inputs.length > 0) {
    lines.push("", "Input files (read them; do not change them):");
    for (const input of inputs) {
      lines.push(`- ${input.id}: ${input.path}${input.sha256 ? ` (sha256 ${input.sha256})` : ""}`);
    }
  }
  if (outputs.length > 0) {
    lines.push("", "Output files you must write:");
    for (const output of outputs) {
      lines.push(`- ${output.id}: ${output.path} (at most ${output.maxBytes} bytes)`);
    }
  }
  return lines.join("\n");
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

/** An output an agent wrote, as returned to the script. */
export interface ProducedFile {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

/** Reads a declared file, or says why it could not be read. */
type ReadDeclaredFile = (ref: FileRef) => Promise<WorkspaceFile | string>;

/** Why the declared inputs cannot be used as they are, or undefined when they can. */
export async function inputProblem(
  inputs: ReadonlyArray<FileRef>,
  read: ReadDeclaredFile,
): Promise<string | undefined> {
  for (const input of inputs) {
    const found = await read(input);
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
export async function outputFiles(
  outputs: ReadonlyArray<FileRef>,
  read: ReadDeclaredFile,
): Promise<
  | { readonly outcome: CheckOutcome; readonly files: Readonly<Record<string, ProducedFile>> }
  | { readonly outcome: CheckOutcome }
> {
  const files: Record<string, ProducedFile> = {};
  const problems: Array<string> = [];
  for (const output of outputs) {
    const found = await read(output);
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

/** A structured check of a declared output file's JSON instead of the agent's result. */
export async function structuredOutputCheck(
  check: StructuredCheck,
  output: FileRef,
  read: ReadDeclaredFile,
): Promise<CheckOutcome> {
  const found = await read(output);
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

/** Throws with the reason when the scopes are malformed. */
export function parseScopes(value: unknown): FileScopes {
  const record = asRecord(value);
  if (record === undefined) throw new Error("scopes must be an object with read and write lists.");
  const paths = (key: "read" | "write") =>
    [
      ...new Set(
        stringList(record[key] ?? [], `scopes.${key}`, MAX_SCOPE_PATHS).map((path) =>
          normalizeWorkspacePath(path, `scopes.${key}`),
        ),
      ),
    ].sort();
  return { read: paths("read"), write: paths("write") };
}

/** Whether two sets of normalized write paths touch the same files. */
export function scopesOverlap(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.some((a) =>
    right.some(
      (b) => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`),
    ),
  );
}

/** The instructions an agent with declared scopes receives with its task. */
export function scopeInstructions(scopes: FileScopes): string {
  const lines = ["", "", "File scope for this task:"];
  lines.push(
    scopes.write.length === 0
      ? "- Do not change any files."
      : `- Change files only within: ${scopes.write.join(", ")}.`,
  );
  if (scopes.read.length > 0) lines.push(`- Read from: ${scopes.read.join(", ")}.`);
  return lines.join("\n");
}

function pointerValue(
  root: unknown,
  pointer: string,
): { found: true; value: unknown } | { found: false } {
  if (pointer === "") return { found: true, value: root };
  let value = root;
  for (const encoded of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/.test(encoded)) return { found: false };
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/.test(token) || Number(token) >= value.length) return { found: false };
      value = value[Number(token)];
    } else {
      const record = asRecord(value);
      if (record === undefined || !Object.hasOwn(record, token)) return { found: false };
      value = record[token];
    }
  }
  return { found: true, value };
}

/** Grades a structured result; the result must be JSON the agent's schema already accepted. */
export function runStructuredCheck(check: StructuredCheck, result: unknown): CheckOutcome {
  const problems: Array<string> = [];
  for (const pointer of check.requiredPointers) {
    if (Object.hasOwn(check.equals, pointer)) continue;
    if (!pointerValue(result, pointer).found) problems.push(`${pointer || "(root)"} is missing`);
  }
  for (const [pointer, expected] of Object.entries(check.equals)) {
    const current = pointerValue(result, pointer);
    if (!current.found) problems.push(`${pointer || "(root)"} is missing`);
    else if (!NodeUtil.isDeepStrictEqual(current.value, expected)) {
      problems.push(
        `${pointer || "(root)"} is ${JSON.stringify(current.value)}, expected ${JSON.stringify(expected)}`,
      );
    }
  }
  return problems.length === 0
    ? { outcome: "passed", detail: "Every required value is present and equal." }
    : { outcome: "failed", detail: problems.join("; ") };
}

/** The answer a judgment agent must give. */
export const JUDGMENT_RESULT_SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["passed", "failed"] },
    reasons: { type: "string" },
  },
  required: ["outcome", "reasons"],
} as const;

export function judgmentPrompt(input: {
  readonly task: string;
  readonly result: string;
  readonly rubric: ReadonlyArray<string>;
  /** False when the work happened in a checkout the judge cannot see. */
  readonly workspaceVisible: boolean;
}): string {
  return [
    "You are an independent checker. Another agent did the task below. Judge its result",
    input.workspaceVisible
      ? "against every criterion. Read the workspace if a criterion needs it; do not change files."
      : "against every criterion. It worked in a separate checkout you cannot see, so judge from the result alone and do not read files.",
    "Pass only if every criterion holds; otherwise fail and say which criteria do not hold.",
    "",
    "Task:",
    input.task,
    "",
    "Result:",
    input.result,
    "",
    "Criteria:",
    ...input.rubric.map((criterion, index) => `${index + 1}. ${criterion}`),
  ].join("\n");
}

/** Reads a judgment agent's verdict; anything else is an error, never a pass. */
export function judgmentOutcome(verdict: unknown): CheckOutcome {
  const record = asRecord(verdict);
  if (
    record === undefined ||
    (record.outcome !== "passed" && record.outcome !== "failed") ||
    typeof record.reasons !== "string"
  ) {
    return { outcome: "error", detail: "The checker gave no usable verdict." };
  }
  return { outcome: record.outcome, detail: record.reasons };
}

/** Appended to the task for the next attempt after a failed check. */
export function checkFeedback(
  checkType: WorkflowCheck["type"] | "outputs",
  outcome: CheckOutcome,
): string {
  const detail =
    outcome.detail.length > FEEDBACK_LIMIT
      ? `${outcome.detail.slice(0, FEEDBACK_LIMIT - 1)}…`
      : outcome.detail;
  return [
    "",
    "",
    `Your previous attempt did not pass its ${checkType} check (${outcome.outcome}):`,
    detail,
    "Fix this and complete the task again.",
  ].join("\n");
}

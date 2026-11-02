#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * A free ACP agent that plays workflow workers and checkers with seeded, known quality and cost,
 * so a real coordinator's choices can be scored against ground truth. Run it as a local ACP
 * command: `node workflow-fake-agent.ts --config <fixture.json>`; see `answerPrompt`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

export interface FakeModel {
  /** Chance-of-pass offset: an item passes about half the time when skill equals difficulty. */
  readonly skill: number;
  /** Share of checks this model judges correctly at low effort. */
  readonly accuracy: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Synthetic list prices in dollars per million tokens. */
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export interface FakeEffort {
  readonly skill: number;
  readonly accuracy: number;
  readonly inputScale: number;
  readonly outputScale: number;
}

export const FAKE_MODELS: Readonly<Record<string, FakeModel>> = {
  "claude-fake-small": {
    skill: 0.35,
    accuracy: 0.72,
    inputTokens: 18_000,
    outputTokens: 1_500,
    inputPerMTok: 1,
    outputPerMTok: 5,
  },
  "claude-fake-large": {
    skill: 0.65,
    accuracy: 0.93,
    inputTokens: 26_000,
    outputTokens: 2_500,
    inputPerMTok: 5,
    outputPerMTok: 25,
  },
  "gpt-fake-small": {
    skill: 0.3,
    accuracy: 0.7,
    inputTokens: 16_000,
    outputTokens: 1_500,
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
  },
  "gpt-fake-large": {
    skill: 0.6,
    accuracy: 0.9,
    inputTokens: 24_000,
    outputTokens: 2_500,
    inputPerMTok: 2,
    outputPerMTok: 8,
  },
};

export const FAKE_EFFORTS: Readonly<Record<string, FakeEffort>> = {
  low: { skill: 0, accuracy: 0, inputScale: 1, outputScale: 1 },
  medium: { skill: 0.1, accuracy: 0.03, inputScale: 1.2, outputScale: 1.8 },
  high: { skill: 0.2, accuracy: 0.06, inputScale: 1.5, outputScale: 3 },
};

const DEFAULT_MODEL = "claude-fake-small";
const DEFAULT_EFFORT = "medium";
/** How sharply pass chance falls as difficulty passes skill. */
const SLOPE = 8;
/** An untagged prompt is judged as an item of middling difficulty. */
const UNTAGGED = { id: "untagged", difficulty: 0.5 } as const;

export interface FixtureItem {
  /** 0 (trivial) to 1 (very hard); hidden from the coordinator. */
  readonly difficulty: number;
  readonly title?: string;
  /** Discovery: each round's items, reported one round at a time until all pass. */
  readonly reveals?: ReadonlyArray<ReadonlyArray<string>>;
}

export interface FakeFixture {
  readonly seed: number;
  readonly runId: string;
  readonly secret: string;
  readonly log: string;
  readonly items: Readonly<Record<string, FixtureItem>>;
  readonly models?: Readonly<Record<string, Partial<FakeModel>>>;
  readonly efforts?: Readonly<Record<string, Partial<FakeEffort>>>;
  /** Milliseconds a reply takes, so the UI and stall sweep see a live turn. */
  readonly replyDelayMs?: number;
}

export interface Tables {
  readonly models: Readonly<Record<string, FakeModel>>;
  readonly efforts: Readonly<Record<string, FakeEffort>>;
}

/** The fixture's model and effort tables over the defaults. */
export function tablesOf(fixture: Pick<FakeFixture, "models" | "efforts">): Tables {
  const merge = <T>(
    base: Readonly<Record<string, T>>,
    extra?: Readonly<Record<string, Partial<T>>>,
  ) =>
    Object.fromEntries(
      Object.entries(base).map(([id, value]) => [id, { ...value, ...extra?.[id] }]),
    ) as Record<string, T>;
  return {
    models: merge(FAKE_MODELS, fixture.models),
    efforts: merge(FAKE_EFFORTS, fixture.efforts),
  };
}

/** A uniform number in [0, 1) from a hash of the parts, the same in every process. */
export function uniform(parts: ReadonlyArray<string | number>): number {
  const digest = NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest();
  return digest.readUInt32BE(0) / 4_294_967_296;
}

function modelOf(tables: Tables, model: string): FakeModel {
  return tables.models[model] ?? tables.models[DEFAULT_MODEL]!;
}

function effortOf(tables: Tables, effort: string): FakeEffort {
  return tables.efforts[effort] ?? tables.efforts[DEFAULT_EFFORT]!;
}

/** The chance an item of this difficulty passes on this model and effort. */
export function passProbability(
  tables: Tables,
  model: string,
  effort: string,
  difficulty: number,
): number {
  const capability = modelOf(tables, model).skill + effortOf(tables, effort).skill;
  return 1 / (1 + Math.exp(-SLOPE * (capability - difficulty)));
}

/** The chance a checker on this model and effort judges a result correctly. */
export function checkerAccuracy(tables: Tables, model: string, effort: string): number {
  return Math.min(0.99, modelOf(tables, model).accuracy + effortOf(tables, effort).accuracy);
}

/** Synthetic tokens and dollars for one prompt. A checker reads less and writes a verdict. */
export function promptCost(
  tables: Tables,
  input: {
    readonly model: string;
    readonly effort: string;
    readonly role: "worker" | "checker";
    readonly difficulty: number;
  },
): { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number } {
  const model = modelOf(tables, input.model);
  const effort = effortOf(tables, input.effort);
  const work = input.role === "worker" ? 1 + input.difficulty : 0.5;
  const inputTokens = Math.round(model.inputTokens * effort.inputScale * work);
  const outputTokens = Math.round(model.outputTokens * effort.outputScale * work);
  const costUsd =
    (inputTokens * model.inputPerMTok + outputTokens * model.outputPerMTok) / 1_000_000;
  return { inputTokens, outputTokens, costUsd };
}

export interface WorkDecision {
  readonly id: string;
  readonly difficulty: number;
  readonly attempt: number;
  readonly p: number;
  readonly draw: number;
  readonly pass: boolean;
}

/** Whether one attempt at one item passes: the seeded ground truth. */
export function decideWork(
  tables: Tables,
  input: {
    readonly seed: number;
    readonly id: string;
    readonly attempt: number;
    readonly model: string;
    readonly effort: string;
    readonly difficulty: number;
  },
): WorkDecision {
  const p = passProbability(tables, input.model, input.effort, input.difficulty);
  const draw = uniform(["work", input.seed, input.id, input.attempt, input.model, input.effort]);
  return {
    id: input.id,
    difficulty: input.difficulty,
    attempt: input.attempt,
    p,
    draw,
    pass: draw < p,
  };
}

/** A checker's verdict: right with its accuracy, else the opposite of the truth. */
export function decideVerdict(
  tables: Tables,
  input: {
    readonly seed: number;
    readonly proofs: ReadonlyArray<string>;
    readonly truth: boolean;
    readonly model: string;
    readonly effort: string;
  },
): {
  readonly accuracy: number;
  readonly draw: number;
  readonly correct: boolean;
  readonly passed: boolean;
} {
  const accuracy = checkerAccuracy(tables, input.model, input.effort);
  const draw = uniform(["check", input.seed, ...input.proofs, input.model, input.effort]);
  const correct = draw < accuracy;
  return { accuracy, draw, correct, passed: correct ? input.truth : !input.truth };
}

const PROOF = /fake-proof:([A-Za-z0-9._-]+):(\d+):([0-9a-f]{12})/g;
const TASK_TAG = /\[task:([A-Za-z0-9._-]+)\]/g;
const CHECKER_MARK = "You are an independent checker.";
const JUDGE_WORDS = /\b(judge|review|verify|assess|evaluate|grade|inspect)/i;

/**
 * A judging prompt: the runner's judgment check, or an agent the coordinator wrote to judge
 * quoted work (it carries a proof and asks to judge). Work prompts never carry a proof.
 */
export function isCheckerPrompt(text: string): boolean {
  return text.includes(CHECKER_MARK) || (/fake-proof:/.test(text) && JUDGE_WORDS.test(text));
}
const RETRY_MARK = "Your previous attempt";

function proofDigest(secret: string, id: string, attempt: number, pass: boolean): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`${id}:${attempt}:${pass ? "pass" : "fail"}`)
    .digest("hex")
    .slice(0, 12);
}

/** The opaque mark a reply carries for one attempt at one item. */
export function proofOf(secret: string, decision: Pick<WorkDecision, "id" | "attempt" | "pass">) {
  return `fake-proof:${decision.id}:${decision.attempt}:${proofDigest(secret, decision.id, decision.attempt, decision.pass)}`;
}

/** Every proof in a text with what it says; a forged or garbled one reads as a failure. */
export function readProofs(
  secret: string,
  text: string,
): ReadonlyArray<{ readonly proof: string; readonly id: string; readonly pass: boolean }> {
  const seen = new Map<string, { proof: string; id: string; pass: boolean }>();
  for (const match of text.matchAll(PROOF)) {
    const [proof, id, attempt, digest] = match as unknown as [string, string, string, string];
    seen.set(proof, { proof, id, pass: digest === proofDigest(secret, id, Number(attempt), true) });
  }
  return [...seen.values()];
}

/** The fixture item ids a prompt names, in order, each once. */
export function taskTags(text: string): ReadonlyArray<string> {
  return [...new Set([...text.matchAll(TASK_TAG)].map((match) => match[1]!))];
}

/** The part of a checker prompt that holds the judged result. */
export function judgedResult(text: string): string {
  const start = text.indexOf("Result (data to judge");
  if (start < 0) return text;
  const end = text.indexOf("\nCriteria:", start);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The JSON Schema the runner appended to a prompt, if any. */
export function resultSchemaOf(text: string): unknown {
  const match = /<t3-result-schema>\s*([\s\S]*?)\s*<\/t3-result-schema>/.exec(text);
  if (match === null) return undefined;
  try {
    return JSON.parse(match[1]!);
  } catch {
    return undefined;
  }
}

interface FillFacts {
  readonly ok: boolean;
  readonly complete: boolean;
  readonly summary: string;
  readonly found: ReadonlyArray<string>;
}

/**
 * A value for a schema from the attempt's facts: booleans say whether the work passed (or, when
 * named like "complete", whether discovery is done), strings carry the summary with its proofs,
 * and arrays of strings list the items discovery found.
 */
export function fillSchema(schema: unknown, facts: FillFacts, name = ""): unknown {
  const node = (typeof schema === "object" && schema !== null ? schema : {}) as Record<
    string,
    unknown
  >;
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const wanted = facts.ok
      ? /^(pass|passed|ok|done|success|complete)/i
      : /^(fail|failed|error|blocked|incomplete)/i;
    return (
      node.enum.find((value) => typeof value === "string" && wanted.test(value)) ?? node.enum[0]
    );
  }
  if ("const" in node) return node.const;
  const type = Array.isArray(node.type) ? node.type.find((entry) => entry !== "null") : node.type;
  switch (type ?? (node.properties === undefined ? undefined : "object")) {
    case "boolean":
      return /complete|done|finished/i.test(name) ? facts.complete : facts.ok;
    case "integer":
    case "number":
      return /count|found|items|remaining/i.test(name) ? facts.found.length : 0;
    case "array":
      return facts.found.map((entry) => fillSchema(node.items, { ...facts, summary: entry }, name));
    case "object": {
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(node.required) ? (node.required as Array<string>) : [];
      const keys = [...new Set([...required, ...Object.keys(properties)])];
      return Object.fromEntries(keys.map((key) => [key, fillSchema(properties[key], facts, key)]));
    }
    default:
      return facts.summary;
  }
}

export interface LogLine {
  readonly at: string;
  readonly runId: string;
  readonly seed: number;
  readonly sessionId: string;
  readonly role: "worker" | "checker" | "process-check";
  readonly model: string | null;
  readonly effort: string | null;
  readonly retry: boolean;
  readonly items: ReadonlyArray<WorkDecision | { readonly id: string; readonly pass: boolean }>;
  readonly truth: boolean;
  readonly verdict?: {
    readonly passed: boolean;
    readonly correct: boolean;
    readonly accuracy: number;
  };
  readonly complete?: boolean;
  readonly found?: ReadonlyArray<string>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export function readLog(path: string): ReadonlyArray<LogLine> {
  let text: string;
  try {
    text = NodeFS.readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [];
    try {
      return [JSON.parse(line) as LogLine];
    } catch {
      return [];
    }
  });
}

/** How many earlier worker prompts in this run worked on the item. */
export function attemptOf(log: ReadonlyArray<LogLine>, runId: string, id: string): number {
  return log.filter(
    (line) =>
      line.runId === runId && line.role === "worker" && line.items.some((item) => item.id === id),
  ).length;
}

/** The discovery round an item is on: rounds whose items have all passed in this run. */
export function discoveryRound(
  log: ReadonlyArray<LogLine>,
  runId: string,
  reveals: ReadonlyArray<ReadonlyArray<string>>,
): number {
  const passed = new Set(
    log
      .filter((line) => line.runId === runId && line.role === "worker")
      .flatMap((line) => line.items.filter((item) => item.pass).map((item) => item.id)),
  );
  const round = reveals.findIndex((ids) => !ids.every((id) => passed.has(id)));
  return round < 0 ? reveals.length : round;
}

export interface Reply {
  readonly text: string;
  readonly line: Omit<LogLine, "at" | "sessionId">;
}

/**
 * The answer to one prompt. A worker passes each `[task:<id>]` item with p(model, effort,
 * difficulty), drawn per (seed, item, attempt, model, effort); attempt counts earlier worker
 * prompts on the item in the run. A checker decodes the result's proofs and is right at its rate.
 */
export function answerPrompt(
  fixture: FakeFixture,
  log: ReadonlyArray<LogLine>,
  input: { readonly text: string; readonly model: string; readonly effort: string },
): Reply {
  const tables = tablesOf(fixture);
  const base = {
    runId: fixture.runId,
    seed: fixture.seed,
    model: input.model,
    effort: input.effort,
    retry: input.text.includes(RETRY_MARK),
  };
  const schema = resultSchemaOf(input.text);
  if (isCheckerPrompt(input.text)) {
    const proofs = readProofs(fixture.secret, judgedResult(input.text));
    const truth = proofs.length > 0 && proofs.every((proof) => proof.pass);
    const verdict = decideVerdict(tables, {
      seed: fixture.seed,
      proofs: proofs.map((proof) => proof.proof),
      truth,
      model: input.model,
      effort: input.effort,
    });
    const reasons =
      proofs.length === 0
        ? "The result carries no evidence of the work."
        : verdict.passed
          ? `Every criterion holds for ${proofs.map((proof) => proof.id).join(", ")}.`
          : `The work on ${proofs.map((proof) => proof.id).join(", ")} does not meet the criteria.`;
    const cost = promptCost(tables, { ...input, role: "checker", difficulty: 0 });
    // The runner's judgment schema, or the one a coordinator-written judge was given.
    const value =
      schema === undefined
        ? { outcome: verdict.passed ? "passed" : "failed", reasons }
        : fillSchema(schema, {
            ok: verdict.passed,
            complete: verdict.passed,
            summary: reasons,
            found: [],
          });
    return {
      text: `${reasons}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
      line: {
        ...base,
        role: "checker",
        items: proofs.map((proof) => ({ id: proof.id, pass: proof.pass })),
        truth,
        verdict: { passed: verdict.passed, correct: verdict.correct, accuracy: verdict.accuracy },
        ...cost,
      },
    };
  }
  const tags = taskTags(input.text);
  const items = (tags.length === 0 ? [UNTAGGED.id] : tags).map((id) => ({
    id,
    item: fixture.items[id] ?? { difficulty: UNTAGGED.difficulty },
  }));
  const decisions = items.map(({ id, item }) =>
    decideWork(tables, {
      seed: fixture.seed,
      id,
      attempt: attemptOf(log, fixture.runId, id),
      model: input.model,
      effort: input.effort,
      difficulty: item.difficulty,
    }),
  );
  const truth = decisions.every((decision) => decision.pass);
  // Discovery reports the next round's items once its own attempt passes.
  const found: Array<string> = [];
  let complete = true;
  for (const [index, { item }] of items.entries()) {
    if (item.reveals === undefined) continue;
    const round = discoveryRound(log, fixture.runId, item.reveals);
    if (round >= item.reveals.length) continue;
    complete = false;
    if (decisions[index]!.pass) {
      found.push(
        ...item.reveals[round]!.map(
          (id) => `[task:${id}] ${fixture.items[id]?.title ?? "follow-up item"}`,
        ),
      );
    }
  }
  const proofs = decisions.map((decision) => proofOf(fixture.secret, decision));
  const lines = [
    `Worked on ${items.map(({ id }) => id).join(", ")}.`,
    ...(items.some(({ item }) => item.reveals !== undefined)
      ? [
          complete
            ? "The investigation is complete: nothing else needs doing."
            : found.length > 0
              ? `The investigation is incomplete. These items still need doing:\n${found.map((entry) => `- ${entry}`).join("\n")}`
              : "The investigation is incomplete, and I could not tell what remains.",
        ]
      : []),
    ...proofs,
  ];
  const summary = lines.join("\n");
  const value =
    schema === undefined ? undefined : fillSchema(schema, { ok: truth, complete, summary, found });
  const difficulty = items.reduce((sum, { item }) => sum + item.difficulty, 0);
  return {
    text:
      value === undefined ? summary : `${summary}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    line: {
      ...base,
      role: "worker",
      items: decisions,
      truth,
      ...(items.some(({ item }) => item.reveals !== undefined) ? { complete, found } : {}),
      ...promptCost(tables, { ...input, role: "worker", difficulty }),
    },
  };
}

export function readFixture(path: string): FakeFixture {
  return JSON.parse(NodeFS.readFileSync(path, "utf8")) as FakeFixture;
}

function appendLog(fixture: FakeFixture, line: LogLine): void {
  NodeFS.appendFileSync(fixture.log, `${JSON.stringify(line)}\n`);
}

/** `--verify <file>`: a process check that passes only when every proof in the file passes. */
function verify(configPath: string, resultPath: string): number {
  const fixture = readFixture(configPath);
  const proofs = readProofs(fixture.secret, NodeFS.readFileSync(resultPath, "utf8"));
  const truth = proofs.length > 0 && proofs.every((proof) => proof.pass);
  appendLog(fixture, {
    at: new Date().toISOString(),
    runId: fixture.runId,
    seed: fixture.seed,
    sessionId: "",
    role: "process-check",
    model: null,
    effort: null,
    retry: false,
    items: proofs.map((proof) => ({ id: proof.id, pass: proof.pass })),
    truth,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  });
  if (proofs.length === 0) process.stderr.write("No evidence of the work was found.\n");
  for (const proof of proofs) {
    (proof.pass ? process.stdout : process.stderr).write(
      `${proof.id}: ${proof.pass ? "passes" : "fails its tests"}\n`,
    );
  }
  return truth ? 0 : 1;
}

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: unknown;
}

function effortOption(current: string) {
  return {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: current,
    options: Object.keys(FAKE_EFFORTS).map((value) => ({
      value,
      name: value[0]!.toUpperCase() + value.slice(1),
    })),
  };
}

function promptText(params: Record<string, unknown>): string {
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  return blocks
    .flatMap((block: { type?: unknown; text?: unknown }) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n\n");
}

function runAgent(configPath: string): void {
  const sessions = new Map<string, { model: string; effort: string; cancel?: () => void }>();
  const send = (message: JsonRpcMessage) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const sessionOf = (params: Record<string, unknown>) => {
    const session = sessions.get(String(params.sessionId));
    if (session === undefined) throw new Error(`Unknown session ${String(params.sessionId)}`);
    return session;
  };

  const handleRequest = async (message: JsonRpcMessage): Promise<unknown> => {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          authMethods: [],
          agentInfo: { name: "t3-workflow-fake", version: "1" },
        };
      case "session/new":
      case "session/load": {
        // One agent process per thread, so ids must be unique across processes.
        const sessionId =
          message.method === "session/load" ? String(params.sessionId) : NodeCrypto.randomUUID();
        sessions.set(sessionId, { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT });
        return {
          ...(message.method === "session/new" ? { sessionId } : {}),
          models: {
            currentModelId: DEFAULT_MODEL,
            availableModels: Object.keys(FAKE_MODELS).map((modelId) => ({
              modelId,
              name: modelId,
            })),
          },
          configOptions: [effortOption(DEFAULT_EFFORT)],
        };
      }
      case "session/set_model": {
        const session = sessionOf(params);
        if (!Object.hasOwn(FAKE_MODELS, String(params.modelId))) {
          throw Object.assign(new Error(`Unknown fake model ${String(params.modelId)}`), {
            code: -32602,
          });
        }
        session.model = String(params.modelId);
        return {};
      }
      case "session/set_config_option": {
        const session = sessionOf(params);
        if (params.configId !== "effort" || !Object.hasOwn(FAKE_EFFORTS, String(params.value))) {
          throw Object.assign(new Error(`Unknown option ${String(params.configId)}`), {
            code: -32602,
          });
        }
        session.effort = String(params.value);
        return { configOptions: [effortOption(session.effort)] };
      }
      case "session/prompt": {
        const sessionId = String(params.sessionId);
        const session = sessionOf(params);
        const fixture = readFixture(configPath);
        const reply = answerPrompt(fixture, readLog(fixture.log), {
          text: promptText(params),
          model: session.model,
          effort: session.effort,
        });
        // Logged before the reply, so a later prompt on the item counts this attempt.
        appendLog(fixture, { at: new Date().toISOString(), sessionId, ...reply.line });
        const cancelled = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), fixture.replyDelayMs ?? 300);
          session.cancel = () => {
            clearTimeout(timer);
            resolve(true);
          };
        });
        delete session.cancel;
        if (cancelled) return { stopReason: "cancelled" };
        send({
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: reply.text },
            },
          },
        });
        return { stopReason: "end_turn" };
      }
      case "session/close":
        sessions.get(String(params.sessionId))?.cancel?.();
        sessions.delete(String(params.sessionId));
        return {};
      case "authenticate":
      case "session/set_mode":
        return {};
      default:
        throw Object.assign(new Error(`Method not found: ${message.method}`), { code: -32601 });
    }
  };

  const input = NodeReadline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stderr.write("workflow fake agent ignored a line that is not JSON\n");
      return;
    }
    if (message.method === undefined) return;
    if (message.id === undefined || message.id === null) {
      if (message.method === "session/cancel") {
        sessions.get(String(message.params?.sessionId))?.cancel?.();
      }
      return;
    }
    const id = message.id;
    handleRequest(message).then(
      (result) => send({ id, result }),
      (error: Error & { code?: number }) =>
        send({ id, error: { code: error.code ?? -32603, message: error.message } }),
    );
  });
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (import.meta.main) {
  const configPath = flag("--config");
  if (configPath === undefined) {
    process.stderr.write(
      "usage: workflow-fake-agent.ts --config <fixture.json> [--verify <file>]\n",
    );
    process.exit(2);
  }
  const resultPath = flag("--verify");
  if (resultPath === undefined) runAgent(configPath);
  else process.exit(verify(configPath, resultPath));
}

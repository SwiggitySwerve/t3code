// @effect-diagnostics-next-line nodeBuiltinImport:off -- offline acceptance hashes are synchronous pure inputs.
import * as NodeCrypto from "node:crypto";
import { fileChanges } from "./file-audit.ts";
import {
  acceptanceGraph,
  coordinator,
  defects,
  expectedFiles,
  fixtureFiles,
  judge,
  scenarios,
  secondProvider,
  worker,
  type Scenario,
} from "./fixtures.ts";

type RecordValue = Record<string, unknown>;
export interface FileEvidence {
  content: string;
  sha256: string;
}
export interface AcceptanceFrame {
  phase: string;
  files: Record<string, FileEvidence>;
  thread: unknown;
  workflows: unknown[];
  tasks: unknown[];
  childThreads: unknown[];
  server: { pid: number; commandLine: string };
  fileAudit?: unknown;
}
export interface AcceptanceEvidence {
  version: 1;
  scenario: Scenario;
  runId: string;
  frames: AcceptanceFrame[];
}

export function sha256(content: string): string {
  return NodeCrypto.createHash("sha256").update(content).digest("hex");
}

function record(value: unknown): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Missing or malformed record");
  return value as RecordValue;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Missing or malformed list");
  return value;
}
function same(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((v, i) => same(v, right[i]));
  if (left && right && typeof left === "object" && typeof right === "object") {
    const a = record(left),
      b = record(right);
    return (
      same(Object.keys(a).sort(), Object.keys(b).sort()) &&
      Object.keys(a).every((key) => same(a[key], b[key]))
    );
  }
  return false;
}
function requireFact(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function checkFiles(actual: unknown, expected: Record<string, string>) {
  const files = record(actual);
  requireFact(
    same(Object.keys(files).sort(), Object.keys(expected).sort()),
    "Unexpected, missing or deleted workspace file",
  );
  for (const [path, content] of Object.entries(expected)) {
    const file = record(files[path]);
    requireFact(
      file.content === content && file.sha256 === sha256(content),
      `File content/hash mismatch: ${path}`,
    );
  }
}
function checkTarget(
  task: RecordValue,
  target: typeof coordinator | typeof worker,
  child: RecordValue,
) {
  // App-owned workflow tasks persist routing; their child owns the selected options.
  const selection = record(child.modelSelection);
  requireFact(
    task.providerInstanceId === target.providerInstanceId && task.model === target.model,
    "Provider/model substitution",
  );
  requireFact(
    selection.instanceId === target.providerInstanceId && selection.model === target.model,
    "Selection differs from dispatched target",
  );
  requireFact(
    same(selection.options ?? [], "options" in target ? target.options : []),
    "Worker options changed",
  );
  requireFact(
    child.id === task.childThreadId && child.runtimeMode === "full-access",
    "Missing full-access child thread",
  );
}
function oneWorkflow(frame: AcceptanceFrame): RecordValue {
  requireFact(frame.workflows.length === 1, "Expected exactly one persisted workflow");
  return record(frame.workflows[0]);
}
function startedAt(agent: RecordValue, tasks: RecordValue[]): number {
  const task = tasks.find((task) => task.id === agent.agentId);
  const time = typeof task?.startedAt === "string" ? Date.parse(task.startedAt) : NaN;
  requireFact(Number.isFinite(time), "Missing persisted task start timestamp");
  return time;
}
function checkParallel(agents: RecordValue[], tasks: RecordValue[], a: string, b: string) {
  const first = agents.find((agent) => agent.graphNodeKey === a)!;
  const second = agents.find((agent) => agent.graphNodeKey === b)!;
  for (const agent of [first, second])
    requireFact(typeof agent.runnerSettledAt === "number", "Missing concurrency timestamps");
  requireFact(
    Math.max(startedAt(first, tasks), startedAt(second, tasks)) <
      Math.min(Number(first.runnerSettledAt), Number(second.runnerSettledAt)),
    "Scouts/reviewers did not overlap",
  );
}

function reviewFindings(result: unknown): RecordValue[] {
  requireFact(
    typeof result === "string" && result.length <= 1500,
    "Review result exceeds its bound",
  );
  // Providers may wrap the requested JSON in one fence. Never extract JSON from prose.
  const json = /^```json\s*\n([\s\S]*)\n```$/.exec(result.trim())?.[1] ?? result;
  const report = record(JSON.parse(json));
  requireFact(same(Object.keys(report), ["findings"]), "Unexpected review result fields");
  const findings = list(report.findings).map(record);
  requireFact(findings.length === 1, "Expected one bounded finding per review lens");
  requireFact(
    same(Object.keys(findings[0]!).sort(), ["explanation", "id", "line", "path", "quote"]),
    "Unexpected review finding fields",
  );
  return findings;
}

/** Consumes captured database records and file bytes; no coordinator verdict is an input. */
export function checkAcceptance(input: unknown): { pass: boolean; failures: string[] } {
  try {
    const evidence = record(input);
    requireFact(
      evidence.version === 1 && typeof evidence.runId === "string" && evidence.runId.length > 0,
      "Missing evidence identity/version",
    );
    requireFact(
      scenarios.some((scenario) => scenario === evidence.scenario),
      "Unknown scenario",
    );
    const scenario = evidence.scenario as Scenario;
    const frames = list(evidence.frames).map(
      (value) => record(value) as unknown as AcceptanceFrame,
    );
    const phases =
      scenario === "restart"
        ? ["baseline", "beforeStop", "afterRestart", "final"]
        : ["baseline", "final"];
    requireFact(
      same(
        frames.map((frame) => frame.phase),
        phases,
      ),
      "Missing, duplicate or out-of-order capture phase",
    );
    const baseline = frames[0]!,
      final = frames.at(-1)!;
    checkFiles(baseline.files, fixtureFiles(scenario));
    checkFiles(final.files, expectedFiles(scenario));
    const thread = record(final.thread);
    requireFact(
      thread.runtimeMode === "full-access" && thread.title === evidence.runId,
      "Wrong caller mode or run identity",
    );
    const selection = record(thread.modelSelection);
    requireFact(
      selection.instanceId === coordinator.providerInstanceId &&
        selection.model === coordinator.model,
      "Wrong coordinator target",
    );
    const row = oneWorkflow(final);
    requireFact(row.threadId === thread.id, "Workflow belongs to another thread");
    requireFact(
      row.status === (scenario === "unavailable" ? "failed" : "completed"),
      "Workflow has not reached the expected terminal status",
    );
    const workflow = record(row.workflow),
      outcomes = record(workflow.nodeOutcomes);
    const graph = acceptanceGraph(scenario, [], []);
    const keys = Object.keys(graph.nodes).sort();
    const plan = list(record(workflow.plan).nodes).map(record);
    requireFact(
      same(plan.map((node) => node.key).sort(), keys),
      "Missing or unexpected plan nodes",
    );
    requireFact(same(Object.keys(outcomes).sort(), keys), "Missing or unexpected outcomes");
    const agents = list(workflow.agents).map(record);
    const tasks = final.tasks.map(record);
    const childThreads = final.childThreads.map(record);
    const seen = new Set<unknown>();
    for (const key of keys) {
      const spec = graph.nodes[key]!,
        outcome = record(outcomes[key]);
      const expectedPlan = plan.find((node) => node.key === key)!;
      requireFact(
        same(list(expectedPlan.dependsOn).toSorted(), spec.dependsOn.toSorted()),
        `Changed dependencies: ${key}`,
      );
      const matches = agents.filter((agent) => agent.graphNodeKey === key);
      requireFact(matches.length === 1, `Missing or duplicate agent: ${key}`);
      const agent = matches[0]!;
      if (scenario === "unavailable") {
        requireFact(
          outcome.status === "failed" &&
            outcome.attempts === 0 &&
            agent.state === "failed" &&
            agent.outcomeCategory === "never_started",
          `Unavailable target ran: ${key}`,
        );
        requireFact(
          agent.agentId === undefined && list(agent.attemptTaskIds ?? []).length === 0,
          "Silent substitute task started",
        );
        const reason = String(agent.result ?? "");
        requireFact(
          reason ===
            (key === "missingProvider"
              ? `Provider instance ${spec.target.providerInstanceId} is not registered.`
              : `Model ${spec.target.model} is not advertised by provider ${spec.target.providerInstanceId}.`),
          "Missing explicit unavailable reason",
        );
        continue;
      }
      requireFact(
        outcome.status === "passed" && outcome.attempts === 1 && agent.state === "completed",
        `Node failed, missing, or retried: ${key}`,
      );
      const ids = list(agent.attemptTaskIds);
      requireFact(
        ids.length === 1 && ids[0] === agent.agentId && !seen.has(ids[0]),
        `Duplicate task/write attempt: ${key}`,
      );
      seen.add(ids[0]);
      const task = tasks.find((task) => task.id === agent.agentId);
      requireFact(
        task !== undefined && task.parentNodeId === row.id && task.status === "completed",
        `Missing completed task: ${key}`,
      );
      const child = childThreads.find((child) => child.id === task.childThreadId);
      requireFact(child !== undefined, `Missing child record: ${key}`);
      checkTarget(task, key === "cross" ? secondProvider : worker, child);
      requireFact(
        agent.providerInstanceId === task.providerInstanceId && agent.model === task.model,
        "Workflow and task routing disagree",
      );
      for (const dependency of spec.dependsOn) {
        const previous = agents.find((candidate) => candidate.graphNodeKey === dependency)!;
        requireFact(
          typeof previous.runnerSettledAt === "number" &&
            previous.runnerSettledAt <= startedAt(agent, tasks),
          "Writer/auditor started before dependencies settled",
        );
      }
      if (spec.verify !== undefined) {
        const verification = record(agent.verification);
        requireFact(
          verification.type === spec.verify.type &&
            verification.outcome === "passed" &&
            verification.attempts === 1,
          `Missing independent ${spec.verify.type} check`,
        );
      }
    }
    const extras = agents.filter((agent) => !keys.includes(String(agent.graphNodeKey)));
    if (scenario === "refactor" || scenario === "restart") {
      requireFact(
        extras.length === 1 && extras[0]!.label === "check Independent audit",
        "Missing or unexpected judgment agent",
      );
      const extra = extras[0]!,
        task = tasks.find((task) => task.id === extra.agentId);
      requireFact(
        task !== undefined && task.status === "completed" && task.parentNodeId === row.id,
        "Missing persisted judgment task",
      );
      const child = childThreads.find((child) => child.id === task.childThreadId);
      requireFact(child !== undefined && !seen.has(task.id), "Judgment is not independent");
      checkTarget(task, judge, child);
      requireFact(
        extra.providerInstanceId === task.providerInstanceId && extra.model === task.model,
        "Workflow and judgment task routing disagree",
      );
      requireFact(
        same(extra.attemptTaskIds, [task.id]),
        "Judgment retried or missing attempt identity",
      );
      seen.add(task.id);
      checkParallel(agents, tasks, "scoutA", "scoutB");
    } else requireFact(extras.length === 0, "Unexpected agent");
    requireFact(
      tasks.length === seen.size && tasks.every((task) => seen.has(task.id)),
      "Unrecorded or duplicate child tasks",
    );
    const audit = record(final.fileAudit);
    requireFact(
      typeof audit.startedAt === "number" &&
        typeof audit.endedAt === "number" &&
        audit.startedAt < audit.endedAt,
      "Missing completed filesystem audit",
    );
    requireFact(
      tasks.every(
        (task) =>
          task.startedAt == null || Date.parse(String(task.startedAt)) >= Number(audit.startedAt),
      ),
      "Filesystem audit started after agents",
    );
    requireFact(
      agents.every(
        (agent) =>
          agent.runnerSettledAt === undefined ||
          Number(agent.runnerSettledAt) <= Number(audit.endedAt),
      ),
      "Filesystem audit ended before agents",
    );
    const fileEvents = fileChanges(audit);
    const writer = agents.find((agent) => agent.graphNodeKey === "writer");
    const allowedWrites = graph.nodes.writer?.scopes.write ?? [];
    for (const event of fileEvents) {
      requireFact(
        writer !== undefined &&
          event.metadata.exists &&
          event.metadata.type === "file" &&
          typeof event.time === "number" &&
          event.time >= startedAt(writer, tasks) &&
          event.time <= Number(writer.runnerSettledAt) &&
          typeof event.path === "string" &&
          allowedWrites.includes(event.path),
        "Write outside the sole writer's paths or execution window",
      );
    }
    if (writer)
      for (const path of allowedWrites)
        requireFact(
          fileEvents.some((event) => event.path === path),
          `Missing file-event evidence: ${path}`,
        );
    if (scenario === "review") {
      checkParallel(agents, tasks, "security", "correctness");
      checkParallel(agents, tasks, "correctness", "tests");
      checkParallel(agents, tasks, "security", "tests");
      for (const defect of defects) {
        const agent = agents.find((agent) => agent.graphNodeKey === defect.id)!;
        const findings = reviewFindings(agent.result);
        const sourceLine = fixtureFiles(scenario)[defect.path]!.split("\n")[defect.line - 1]!;
        requireFact(
          findings.some(
            (finding) =>
              finding.id === defect.id &&
              finding.path === defect.path &&
              finding.line === defect.line &&
              typeof finding.quote === "string" &&
              finding.quote.includes(defect.quote) &&
              sourceLine.includes(finding.quote) &&
              typeof finding.explanation === "string" &&
              finding.explanation.length >= 25 &&
              defect.consequence.test(finding.explanation),
          ),
          `Missing cited seeded defect: ${defect.id}`,
        );
      }
    }
    if (scenario === "restart") {
      const before = frames[1]!,
        after = frames[2]!;
      checkFiles(before.files, fixtureFiles(scenario));
      for (const frame of [before, after]) {
        const prior = oneWorkflow(frame);
        requireFact(
          prior.id === row.id && record(frame.thread).id === thread.id,
          "Restart created another workflow/thread",
        );
      }
      const beforeWorkflow = record(oneWorkflow(before).workflow),
        retained = record(beforeWorkflow.nodeOutcomes);
      requireFact(
        record(retained.scoutA).status === "passed" &&
          record(retained.cross).status === "passed" &&
          retained.writer === undefined,
        "Stop was not between completed scouts and the writer",
      );
      const waiting = list(beforeWorkflow.agents)
        .map(record)
        .find((agent) => agent.graphNodeKey === "scoutB");
      requireFact(waiting?.state === "running", "Stop missed the in-flight check");
      for (const frame of [after, final]) {
        const current = record(oneWorkflow(frame).workflow);
        for (const key of ["scoutA", "cross"]) {
          requireFact(
            same(record(current.nodeOutcomes)[key], retained[key]),
            `Completed outcome lost on restart: ${key}`,
          );
          const a = list(beforeWorkflow.agents)
            .map(record)
            .find((agent) => agent.graphNodeKey === key)!;
          const b = list(current.agents)
            .map(record)
            .find((agent) => agent.graphNodeKey === key)!;
          requireFact(
            same(a.attemptTaskIds, b.attemptTaskIds) && a.result === b.result,
            "Completed scout reran after restart",
          );
        }
      }
      requireFact(
        Number.isInteger(before.server.pid) &&
          Number.isInteger(after.server.pid) &&
          before.server.pid > 0 &&
          after.server.pid > 0 &&
          before.server.pid !== after.server.pid,
        "Missing server replacement evidence",
      );
      for (const frame of [before, after])
        requireFact(
          frame.server.commandLine.includes("t3code-devhome") &&
            frame.server.commandLine.includes("13773"),
          "Restart touched the wrong server",
        );
    }
    return { pass: true, failures: [] };
  } catch (error) {
    return { pass: false, failures: [error instanceof Error ? error.message : String(error)] };
  }
}

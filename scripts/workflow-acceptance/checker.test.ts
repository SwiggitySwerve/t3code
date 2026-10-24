import { describe, expect, it } from "vite-plus/test";
import {
  acceptanceGraph,
  coordinator,
  defects,
  expectedFiles,
  fixtureFiles,
  judge,
  scenarios,
  type Scenario,
} from "./fixtures.ts";
import { checkAcceptance, sha256 } from "./checker.ts";
import type { FileAudit, PathMetadata } from "./file-audit.ts";

function fileMetadata(mtimeNs = "1700000000000000000"): PathMetadata {
  return { exists: true, type: "file", size: "100", mtimeNs };
}
function mutation(path: string, time: number) {
  return { path, time, metadata: fileMetadata("1700000000000000001") };
}

type MutableRecord = Record<string, unknown>;
function object(value: unknown): MutableRecord {
  return value as MutableRecord;
}
function evidence(scenario: Scenario) {
  const graph = acceptanceGraph(scenario, ["node", "check"], ["node", "gate"]);
  const agents: MutableRecord[] = [];
  const tasks: MutableRecord[] = [];
  const children: MutableRecord[] = [];
  const outcomes: MutableRecord = {};
  const time = 1700000000000;
  for (const [key, spec] of Object.entries(graph.nodes)) {
    const blocked = scenario === "unavailable";
    const id = `task-${key}`,
      childThreadId = `child-${key}`;
    const offset = key === "writer" ? 300 : key === "audit" ? 600 : 0;
    const defect = defects.find((defect) => defect.id === key);
    const result = defect
      ? JSON.stringify({
          findings: [
            {
              id: defect.id,
              path: defect.path,
              line: defect.line,
              quote: defect.quote,
              explanation:
                defect.id === "security"
                  ? "Untrusted names allow arbitrary shell command injection."
                  : defect.id === "correctness"
                    ? "The result is only tax, twenty dollars, instead of the expected total of 120."
                    : "Comparing the function to itself is a tautology and cannot detect incorrect behavior.",
            },
          ],
        })
      : "Read and verified the fixture files.";
    agents.push({
      graphNodeKey: key,
      index: agents.length,
      label: spec.subject,
      state: blocked ? "failed" : "completed",
      ...(blocked
        ? {
            outcomeCategory: "never_started",
            result:
              key === "missingProvider"
                ? `Provider instance ${spec.target.providerInstanceId} is not registered.`
                : `Model ${spec.target.model} is not advertised by provider ${spec.target.providerInstanceId}.`,
          }
        : {
            agentId: id,
            childThreadId,
            attemptTaskIds: [id],
            providerInstanceId: spec.target.providerInstanceId,
            model: spec.target.model,
            runnerSettledAt: time + offset + 200,
            result,
            ...(spec.verify
              ? { verification: { type: spec.verify.type, outcome: "passed", attempts: 1 } }
              : {}),
          }),
    });
    outcomes[key] = { status: blocked ? "failed" : "passed", attempts: blocked ? 0 : 1 };
    if (!blocked) {
      const modelSelection = {
        instanceId: spec.target.providerInstanceId,
        model: spec.target.model,
        ...("options" in spec.target ? { options: spec.target.options } : {}),
      };
      tasks.push({
        id,
        parentNodeId: "workflow-1",
        status: "completed",
        childThreadId,
        providerInstanceId: spec.target.providerInstanceId,
        model: spec.target.model,
        startedAt: `2023-11-14T22:13:20.${String(offset).padStart(3, "0")}Z`,
      });
      children.push({ id: childThreadId, runtimeMode: "full-access", modelSelection });
    }
  }
  if (scenario === "refactor" || scenario === "restart") {
    agents.push({
      index: agents.length,
      label: "check Independent audit",
      state: "completed",
      agentId: "judgment",
      attemptTaskIds: ["judgment"],
      providerInstanceId: judge.providerInstanceId,
      model: judge.model,
      runnerSettledAt: time + 900,
    });
    const modelSelection = { instanceId: judge.providerInstanceId, model: judge.model };
    tasks.push({
      id: "judgment",
      parentNodeId: "workflow-1",
      status: "completed",
      childThreadId: "judge-child",
      providerInstanceId: judge.providerInstanceId,
      model: judge.model,
      startedAt: null,
    });
    children.push({ id: "judge-child", runtimeMode: "full-access", modelSelection });
  }
  const files = (contents: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(contents).map(([path, content]) => [
        path,
        { content, sha256: sha256(content) },
      ]),
    );
  const frame = (phase: string, contents: Record<string, string>) => ({
    phase,
    files: files(contents),
    thread: {
      id: "parent",
      title: "test-run",
      runtimeMode: "full-access",
      modelSelection: { instanceId: coordinator.providerInstanceId, model: coordinator.model },
    },
    workflows: [
      {
        id: "workflow-1",
        threadId: "parent",
        status: scenario === "unavailable" ? "failed" : "completed",
        workflow: {
          plan: {
            nodes: Object.entries(graph.nodes).map(([key, spec]) => ({
              key,
              dependsOn: spec.dependsOn,
            })),
          },
          agents: structuredClone(agents),
          nodeOutcomes: structuredClone(outcomes),
        },
      },
    ],
    tasks: structuredClone(tasks),
    childThreads: structuredClone(children),
    server: { pid: 100, commandLine: "node serve --base-dir t3code-devhome --port 13773" },
    fileAudit: {
      startedAt: time - 100,
      endedAt: time + 1000,
      initial: Object.fromEntries(Object.keys(contents).map((path) => [path, fileMetadata()])),
      events: (graph.nodes.writer?.scopes.write ?? []).map((path) => mutation(path, time + 350)),
    } satisfies FileAudit,
  });
  const baseline = frame("baseline", fixtureFiles(scenario));
  baseline.workflows = [];
  baseline.tasks = [];
  baseline.childThreads = [];
  const final = frame("final", expectedFiles(scenario));
  const frames = [baseline];
  if (scenario === "restart") {
    const before = frame("beforeStop", fixtureFiles(scenario));
    before.workflows[0]!.status = "running";
    before.workflows[0]!.workflow.nodeOutcomes = { scoutA: outcomes.scoutA, cross: outcomes.cross };
    before.workflows[0]!.workflow.agents = before.workflows[0]!.workflow.agents.filter((agent) =>
      ["scoutA", "scoutB", "cross"].includes(String(agent.graphNodeKey)),
    );
    before.workflows[0]!.workflow.agents.find((agent) => agent.graphNodeKey === "scoutB")!.state =
      "running";
    const after = structuredClone(before);
    after.phase = "afterRestart";
    after.server.pid = 101;
    final.server.pid = 101;
    frames.push(before, after);
  }
  frames.push(final);
  return { version: 1, scenario, runId: "test-run", frames };
}

function finalFrame(run: ReturnType<typeof evidence>) {
  return run.frames.at(-1)!;
}
function workflow(run: ReturnType<typeof evidence>) {
  return finalFrame(run).workflows[0]!.workflow;
}

// Field shapes copied read-only from the isolated dev DB on 2026-10-23.
// Source workflow was failed, with a completed process-checked node. Enums and
// timestamps retain their shape; source identities and text are sanitized. The
// positive case overlays frozen scenario identities, results and timing evidence.
const persistedShape = {
  workflowRow: {
    id: "sanitized",
    threadId: "sanitized",
    runId: "sanitized",
    parentNodeId: "sanitized",
    origin: "app_owned",
    createdBy: "agent",
    driver: "claudeAgent",
    providerInstanceId: "sanitized",
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "sanitized",
    title: "sanitized",
    model: null,
    completionWake: "always",
    completionDelivery: {
      state: "delivered",
      observedByRunId: null,
    },
    status: "failed",
    progress: "sanitized",
    workflow: {
      phases: [
        {
          index: 0,
          title: "sanitized",
        },
        {
          index: 1,
          title: "sanitized",
        },
        {
          index: 2,
          title: "sanitized",
        },
        {
          index: 3,
          title: "sanitized",
        },
      ],
      agents: [],
      plan: {},
      nodeOutcomes: {},
    },
    result: "sanitized",
    startedAt: "2026-10-23T19:51:07.211Z",
    completedAt: "2026-10-23T19:52:38.774Z",
    updatedAt: "2026-10-23T19:52:44.785Z",
  },
  agent: {
    graphNodeKey: "sanitized",
    attemptTaskIds: ["sanitized"],
    outcomeCategory: "completed",
    runnerSettledAt: 1792785111169,
    index: 0,
    label: "sanitized",
    agentId: "sanitized",
    childThreadId: "sanitized",
    state: "completed",
    providerInstanceId: "sanitized",
    driver: "codex",
    phaseIndex: 0,
    phaseTitle: "sanitized",
    model: "sanitized",
    totalTokens: 32873,
    prompt: "sanitized",
    result: "sanitized",
    verification: {
      type: "process",
      outcome: "passed",
      attempts: 1,
      detail: "sanitized",
    },
  },
  task: {
    id: "sanitized",
    threadId: "sanitized",
    runId: "sanitized",
    parentNodeId: "sanitized",
    origin: "app_owned",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: "sanitized",
    providerThreadId: "sanitized",
    childThreadId: "sanitized",
    nativeTaskRef: null,
    prompt: "sanitized",
    title: "sanitized",
    model: "sanitized",
    completionWake: "always",
    completionDelivery: {
      state: "disposed",
      observedByRunId: null,
    },
    status: "completed",
    result: "sanitized",
    startedAt: "2026-10-23T19:51:07.274Z",
    completedAt: "2026-10-23T19:51:11.081Z",
    updatedAt: "2026-10-23T19:51:11.081Z",
  },
  child: {
    createdBy: "agent",
    creationSource: "mcp",
    id: "sanitized",
    projectId: "sanitized",
    title: "sanitized",
    providerInstanceId: "sanitized",
    modelSelection: {
      instanceId: "sanitized",
      model: "sanitized",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    pullRequests: [],
    activeProviderThreadId: "sanitized",
    lineage: {
      workflowId: "sanitized",
      parentThreadId: "sanitized",
      relationshipToParent: "subagent",
      rootThreadId: "sanitized",
    },
    forkedFrom: {
      type: "node",
      nodeId: "sanitized",
    },
    createdAt: "2026-10-23T19:51:07.274Z",
    updatedAt: "2026-10-23T20:22:46.913Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: "2026-10-23T19:51:07.275Z",
    deletedAt: null,
  },
};

describe("frozen workflow acceptance", () => {
  it("accepts persisted review refusal without a workflow, retaining both unavailable targets", () => {
    const run = evidence("unavailable");
    const final = finalFrame(run);
    const graph = acceptanceGraph("unavailable", [], []);
    final.workflows = [];
    const captured = {
      ...final,
      toolCalls: [
        {
          type: "dynamic_tool",
          toolName: "t3-code.graph_review",
          threadId: final.thread.id,
          status: "completed",
          input: { graph },
          output: {
            ready: false,
            digest: null,
            blockers: [
              "missingProvider: Provider instance acceptance-provider-does-not-exist is not registered.",
              "unknownModel: Model acceptance-model-does-not-exist is not advertised by provider cliproxy.",
            ],
          },
        },
      ],
    };
    run.frames[run.frames.length - 1] = captured;
    expect(checkAcceptance(run)).toEqual({ pass: true, failures: [] });
    for (const mutate of [
      (frame: typeof captured) => {
        frame.toolCalls = [];
      },
      (frame: typeof captured) => {
        frame.toolCalls[0]!.output.blockers.pop();
      },
      (frame: typeof captured) => {
        frame.toolCalls[0]!.output.ready = true;
      },
      (frame: typeof captured) => {
        frame.toolCalls[0]!.input.graph.nodes.unknownModel!.target.model = "substitute";
      },
      (frame: typeof captured) => {
        frame.tasks.push({ id: "unexpected-child" });
      },
      (frame: typeof captured) => {
        frame.fileAudit.events.push(mutation("writes.log", 1700000000100));
      },
    ]) {
      const altered = structuredClone(captured);
      mutate(altered);
      expect(checkAcceptance({ ...run, frames: [run.frames[0], altered] }).pass).toBe(false);
    }
  });

  it("accepts a sanitized persisted workflow/task/child record shape", () => {
    const run = evidence("refactor");
    const final = finalFrame(run);
    const flow = final.workflows[0]!;
    final.workflows[0] = {
      ...persistedShape.workflowRow,
      ...flow,
      workflow: { ...persistedShape.workflowRow.workflow, ...flow.workflow },
    };
    const writer = flow.workflow.agents.find((agent) => agent.graphNodeKey === "writer")!;
    Object.assign(writer, { ...persistedShape.agent, ...writer });
    final.tasks = final.tasks.map((task) => ({ ...persistedShape.task, ...task }));
    final.childThreads = final.childThreads.map((child) => ({
      ...persistedShape.child,
      ...child,
      providerInstanceId: object(child.modelSelection).instanceId,
    }));
    expect(final.tasks.every((task) => !("modelSelection" in task))).toBe(true);
    expect(checkAcceptance(run)).toEqual({ pass: true, failures: [] });
  });

  it.each(scenarios)("accepts complete independent evidence: %s", (scenario) => {
    expect(checkAcceptance(evidence(scenario))).toEqual({ pass: true, failures: [] });
  });

  it.each(["providerInstanceId", "model"])("rejects judgment routing substitution: %s", (field) => {
    const run = evidence("refactor");
    workflow(run).agents.find((agent) => agent.label === "check Independent audit")![field] =
      "substitute";
    expect(checkAcceptance(run).pass).toBe(false);
  });

  it.each([null, undefined, "invalid"])(
    "rejects missing concurrency start evidence: %s",
    (startedAt) => {
      const run = evidence("review");
      finalFrame(run).tasks[0]!.startedAt = startedAt;
      expect(checkAcceptance(run).pass).toBe(false);
    },
  );

  it.each(["selection", "mode"])("rejects child %s substitution", (fault) => {
    const run = evidence("review");
    const child = finalFrame(run).childThreads[0]!;
    if (fault === "selection") object(child.modelSelection).model = "substitute";
    else child.runtimeMode = "approval-required";
    expect(checkAcceptance(run).pass).toBe(false);
  });

  it("accepts a bounded JSON fence while retaining cited evidence", () => {
    const run = evidence("review");
    const agent = workflow(run).agents[0]!;
    agent.result = `\`\`\`json\n${agent.result}\n\`\`\``;
    expect(checkAcceptance(run)).toEqual({ pass: true, failures: [] });
  });

  it.each([
    [
      "correctness",
      "The function returns just the tax amount (20 for 100) rather than subtotal plus tax.",
    ],
    ["correctness", "It returns the tax instead of the price including tax, so total(100) is 20."],
    [
      "tests",
      "It compares total(100) to total(100), so it always passes and never checks the expected value 120.",
    ],
    ["tests", "Both sides of the assertion are identical calls, so the test can never fail."],
    [
      "security",
      "Passing user input to execSync enables OS injection with arbitrary code execution.",
    ],
  ])("accepts a concrete %s consequence: %s", (id, explanation) => {
    const run = evidence("review");
    const agent = workflow(run).agents.find((agent) => agent.graphNodeKey === id)!;
    const report = JSON.parse(String(agent.result));
    report.findings[0].explanation = explanation;
    agent.result = JSON.stringify(report);
    expect(checkAcceptance(run)).toEqual({ pass: true, failures: [] });
  });

  it("accepts an access-only notification with unchanged metadata", () => {
    const run = evidence("review");
    const metadata = { exists: true, type: "file", size: "100", mtimeNs: "1700000000000000000" };
    Object.assign(finalFrame(run).fileAudit, {
      initial: { "src/price.cjs": metadata },
      events: [{ path: "src/price.cjs", time: 1700000000050, metadata }],
    });
    expect(checkAcceptance(run)).toEqual({ pass: true, failures: [] });
  });

  it.each([
    ["security", "This line calls execSync using name as one of its arguments."],
    ["correctness", "The subtotal input flows into multiplication on this line."],
    ["tests", "This assertion evaluates both calls at runtime on this line."],
  ])("rejects a %s finding without a consequence", (id, explanation) => {
    const run = evidence("review");
    const agent = workflow(run).agents.find((agent) => agent.graphNodeKey === id)!;
    const report = JSON.parse(String(agent.result));
    report.findings[0].explanation = explanation;
    agent.result = JSON.stringify(report);
    expect(checkAcceptance(run).failures).toEqual([`Missing cited seeded defect: ${id}`]);
  });

  it.each(["addition", "deletion", "directory", "restored temporary file"])(
    "rejects disallowed filesystem mutation: %s",
    (kind) => {
      const run = evidence("review");
      const audit = finalFrame(run).fileAudit;
      const path =
        kind === "deletion" ? "src/price.cjs" : kind === "directory" ? "src" : "scratch.tmp";
      if (kind === "directory")
        audit.initial[path] = { exists: true, type: "directory", size: "0", mtimeNs: "1" };
      audit.events.push({
        path,
        time: 1700000000050,
        metadata:
          kind === "deletion"
            ? { exists: false }
            : kind === "directory"
              ? { exists: true, type: "directory", size: "0", mtimeNs: "2" }
              : fileMetadata(),
      });
      if (kind === "restored temporary file")
        audit.events.push({ path, time: 1700000000060, metadata: { exists: false } });
      expect(checkAcceptance(run).failures).toEqual([
        "Write outside the sole writer's paths or execution window",
      ]);
    },
  );

  it.each(["deletion", "directory"])("rejects %s at an otherwise allowed writer path", (kind) => {
    const run = evidence("refactor");
    const audit = finalFrame(run).fileAudit;
    audit.events[0]!.metadata =
      kind === "deletion"
        ? { exists: false }
        : { exists: true, type: "directory", size: "0", mtimeNs: "1700000000000000001" };
    expect(checkAcceptance(run).failures).toEqual([
      "Write outside the sole writer's paths or execution window",
    ]);
  });

  it.each(["oversized", "extra field", "extra finding"])(
    "rejects unbounded review result: %s",
    (fault) => {
      const run = evidence("review");
      const agent = workflow(run).agents[0]!;
      const report = JSON.parse(String(agent.result));
      if (fault === "oversized") report.findings[0].explanation += "x".repeat(2000);
      if (fault === "extra field") report.findings[0].uncitedClaim = "trusted";
      if (fault === "extra finding") report.findings.push(report.findings[0]);
      agent.result = JSON.stringify(report);
      expect(checkAcceptance(run).pass).toBe(false);
    },
  );

  it("rejects a generic unavailable claim naming the requested target", () => {
    const run = evidence("unavailable");
    workflow(run).agents[0]!.result =
      "Unknown unavailable target acceptance-provider-does-not-exist";
    expect(checkAcceptance(run).pass).toBe(false);
  });

  it.each([
    ["missing bundle", undefined],
    ["empty bundle", {}],
    ["coordinator says pass", { pass: true, result: "all scenarios passed" }],
  ])("rejects %s", (_name, value) => expect(checkAcceptance(value).pass).toBe(false));

  it.each([
    "baseline tampering",
    "content tampering",
    "hash tampering",
    "extra file",
    "deleted file",
    "missing workflow",
    "missing outcomes",
    "missing child",
    "missing task",
    "extra task",
    "target substitution",
    "option substitution",
    "approval mode",
    "missing process check",
    "failed process check",
    "missing judgment",
    "same judge",
    "duplicate writer",
    "reordered writer",
    "serial scouts",
    "wrong dependencies",
    "missing attempt",
  ])("rejects refactor evidence with %s", (fault) => {
    const run = evidence("refactor"),
      final = finalFrame(run),
      flow = workflow(run);
    const agent = (key: string) => flow.agents.find((agent) => agent.graphNodeKey === key)!;
    const task = final.tasks.find((task) => task.id === "task-writer")!;
    switch (fault) {
      case "baseline tampering":
        run.frames[0]!.files["src/label.mjs"]!.content = "tampered";
        break;
      case "content tampering":
        final.files["src/label.mjs"]!.content = "tampered";
        break;
      case "hash tampering":
        final.files["src/label.mjs"]!.sha256 = "0".repeat(64);
        break;
      case "extra file":
        final.files["extra"] = { content: "", sha256: sha256("") };
        break;
      case "deleted file":
        delete final.files["test/behavior.mjs"];
        break;
      case "missing workflow":
        final.workflows = [];
        break;
      case "missing outcomes":
        flow.nodeOutcomes = {};
        break;
      case "missing child":
        final.childThreads = [];
        break;
      case "missing task":
        final.tasks = [];
        break;
      case "extra task":
        final.tasks.push({ ...task, id: "rogue" });
        break;
      case "target substitution":
        task.providerInstanceId = "paid-account";
        break;
      case "option substitution":
        object(
          final.childThreads.find((child) => child.id === task.childThreadId)!.modelSelection,
        ).options = [];
        break;
      case "approval mode":
        final.thread.runtimeMode = "approval-required";
        break;
      case "missing process check":
        delete agent("writer").verification;
        break;
      case "failed process check":
        object(agent("writer").verification).outcome = "failed";
        break;
      case "missing judgment":
        flow.agents = flow.agents.filter((agent) => agent.label !== "check Independent audit");
        break;
      case "same judge":
        flow.agents.find((agent) => agent.label === "check Independent audit")!.agentId =
          "task-writer";
        break;
      case "duplicate writer":
        agent("writer").attemptTaskIds = ["task-writer", "writer-again"];
        break;
      case "reordered writer":
        task.startedAt = "2023-11-14T22:13:20.000Z";
        break;
      case "serial scouts":
        agent("scoutA").runnerSettledAt = 1699999999999;
        break;
      case "wrong dependencies":
        flow.plan.nodes.find((node) => node.key === "writer")!.dependsOn = [];
        break;
      case "missing attempt":
        delete agent("writer").attemptTaskIds;
        break;
    }
    expect(checkAcceptance(run).pass).toBe(false);
  });

  it.each(["line", "quote", "explanation", "missing", "invalid JSON", "write"])(
    "rejects review %s",
    (fault) => {
      const run = evidence("review"),
        agent = workflow(run).agents[0]!;
      if (fault === "write") finalFrame(run).files["src/price.cjs"]!.content = "fixed by reviewer";
      else if (fault === "invalid JSON") agent.result = "I found all defects, trust me.";
      else {
        const report = object(JSON.parse(String(agent.result)));
        const finding = object((report.findings as unknown[])[0]);
        if (fault === "missing") report.findings = [];
        else finding[fault] = fault === "line" ? 1 : "";
        agent.result = JSON.stringify(report);
      }
      expect(checkAcceptance(run).pass).toBe(false);
    },
  );

  it.each(["silent success", "anonymous error", "spawned substitute"])(
    "rejects unavailable %s",
    (fault) => {
      const run = evidence("unavailable"),
        flow = workflow(run),
        agent = flow.agents[0]!;
      if (fault === "silent success")
        flow.nodeOutcomes.missingProvider = { status: "passed", attempts: 1 };
      if (fault === "anonymous error") agent.result = "failed";
      if (fault === "spawned substitute") agent.agentId = "substitute";
      expect(checkAcceptance(run).pass).toBe(false);
    },
  );

  it.each([
    "missing",
    "incomplete",
    "late start",
    "early finish",
    "outside path",
    "scout write",
    "unwitnessed write",
  ])("rejects filesystem audit %s", (fault) => {
    const run = evidence("refactor"),
      final = finalFrame(run);
    const audit = final.fileAudit;
    switch (fault) {
      case "missing":
        object(final).fileAudit = undefined;
        break;
      case "incomplete":
        audit.endedAt = audit.startedAt;
        break;
      case "late start":
        audit.startedAt = 1700000000100;
        break;
      case "early finish":
        audit.endedAt = 1700000000200;
        break;
      case "outside path":
        audit.events.push(mutation("test/behavior.mjs", 1700000000350));
        break;
      case "scout write":
        audit.events[0]!.time = 1700000000050;
        break;
      case "unwitnessed write":
        audit.events = [];
        break;
    }
    expect(checkAcceptance(run).pass).toBe(false);
  });

  it("rejects a reviewer write even when the original bytes were restored", () => {
    const run = evidence("review");
    finalFrame(run).fileAudit.events.push(mutation("src/price.cjs", 1700000000050));
    expect(checkAcceptance(run).pass).toBe(false);
  });

  it.each([
    "missing checkpoint",
    "same server",
    "wrong server",
    "lost outcome",
    "rerun scout",
    "duplicate write",
    "different workflow",
    "no active check",
  ])("rejects restart %s", (fault) => {
    const run = evidence("restart"),
      before = run.frames[1]!,
      after = run.frames[2]!;
    switch (fault) {
      case "missing checkpoint":
        run.frames.splice(1, 1);
        break;
      case "same server":
        after.server.pid = before.server.pid;
        break;
      case "wrong server":
        after.server.commandLine = "installed t3";
        break;
      case "lost outcome":
        after.workflows[0]!.workflow.nodeOutcomes = {};
        break;
      case "rerun scout":
        workflow(run).agents.find((agent) => agent.graphNodeKey === "scoutA")!.attemptTaskIds = [
          "replacement",
        ];
        break;
      case "duplicate write":
        finalFrame(run).files["writes.log"] = {
          content: "writer\nwriter\n",
          sha256: sha256("writer\nwriter\n"),
        };
        break;
      case "different workflow":
        after.workflows[0]!.id = "new-workflow";
        break;
      case "no active check":
        before.workflows[0]!.workflow.agents.find(
          (agent) => agent.graphNodeKey === "scoutB",
        )!.state = "completed";
        break;
    }
    expect(checkAcceptance(run).pass).toBe(false);
  });
});

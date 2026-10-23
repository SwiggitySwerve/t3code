import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  appWorkflowMemberThreads,
  deriveWorkflowGroups,
  resolveAppWorkflowView,
  isWorkflowScriptMessage,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
} from "./subagentRuntime.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number];

function subagent(overrides: Partial<ProjectedSubagent> = {}): ProjectedSubagent {
  return {
    id: "coordinator",
    title: "probe",
    prompt: "export const meta = …",
    model: "claude-opus-5[1m]",
    status: "running" satisfies OrchestrationV2Subagent["status"],
    result: null,
    startedAt: at("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-08-01T10:00:05.000Z"),
    ...overrides,
  };
}

const member = (
  overrides: Partial<OrchestrationV2SubagentWorkflow["agents"][number]> = {},
): OrchestrationV2SubagentWorkflow["agents"][number] => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const groupsOf = (subagents: ReadonlyArray<ProjectedSubagent>) =>
  deriveWorkflowGroups(projectedSubagentsToRuntime(subagents));

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it("uses a settled member's wall-clock completion separately from its execution duration", () => {
    const [, settled] = projectedSubagentsToRuntime([
      subagent({
        status: "completed",
        completedAt: at("2026-08-01T10:00:09.000Z"),
        workflow: {
          phases: [],
          agents: [
            member({
              state: "completed",
              startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
              durationMs: 1500,
              completedAt: Date.UTC(2026, 7, 1, 10, 0, 4, 432),
              totalTokens: 71_141,
              toolCalls: 3,
              prompt: "Reply with exactly: A1",
              result: "A1",
            }),
          ],
        },
      }),
    ]);
    expect(settled?.status).toBe("completed");
    expect(settled?.completedAt).toBe("2026-08-01T10:00:04.432Z");
    expect(settled?.result).toBe("A1");
    expect(settled?.progress).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles unfinished members when the coordinator is %s",
    (status) => {
      const groups = groupsOf([
        subagent({
          status,
          completedAt: at("2026-08-01T10:00:09.000Z"),
          workflow: {
            phases: [],
            agents: [
              member(),
              member({ index: 2, state: "queued" }),
              member({
                index: 3,
                state: "completed",
                startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
                durationMs: 1500,
              }),
            ],
          },
        }),
      ]);
      expect(groups[0]?.workflow.status).toBe(status);
      const members = groups[0]?.phases.flatMap((phase) => phase.members);
      expect(members?.map((agent) => agent.status)).toEqual([status, status, "completed"]);
      expect(members?.map((agent) => agent.completedAt)).toEqual([
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:01.500Z",
      ]);
    },
  );
});

describe("deriveWorkflowGroups over a dynamic workflow", () => {
  it("groups members under their phases and counts the run", () => {
    const groups = groupsOf([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 3, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
            member({
              index: 4,
              label: "beta:two",
              phaseIndex: 2,
              phaseTitle: "Beta",
              state: "queued",
            }),
          ],
        },
      }),
    ]);
    const group = groups[0];
    expect(group?.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Alpha", "done"],
      ["Beta", "running"],
    ]);
    expect(group?.phases.map((phase) => phase.settledCount)).toEqual([2, 0]);
    expect(group?.phases.flatMap((phase) => phase.members)).toHaveLength(4);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it.each([false, true])("keeps a reported phase title, missing title first=%s", (missingFirst) => {
    const agents = [member({ phaseTitle: "Review" }), member({ index: 2, phaseTitle: undefined })];
    const groups = groupsOf([
      subagent({ workflow: { phases: [], agents: missingFirst ? agents.toReversed() : agents } }),
    ]);
    expect(groups[0]?.phases[0]?.title).toBe("Review");
  });

  it("keeps unphased members with their workflow and excludes unrelated agents", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({ id: "ordinary" }),
      subagent({
        id: "__proto__",
        workflow: {
          phases: [],
          agents: [member({ phaseIndex: undefined, phaseTitle: undefined })],
        },
      }),
      subagent({ id: "constructor", workflow: { phases: [], agents: [] } }),
      subagent({ id: "orphan", workflow: { phases: [], agents: [member()] } }),
    ]);
    const groups = deriveWorkflowGroups(runtime.filter((agent) => agent.id !== "orphan"));
    expect(groups.map((group) => group.workflow.id)).toEqual(["__proto__", "constructor"]);
    expect(groups[0]?.phases).toEqual([]);
    expect(groups[0]?.unphasedMembers.map((agent) => agent.title)).toEqual(["alpha:one"]);
    expect(groups[1]?.phases).toEqual([]);
    expect(groups[1]?.unphasedMembers).toEqual([]);
  });
});

describe("resolveWorkflowOpening", () => {
  const SCRIPT = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';
  const childThread = {
    id: ThreadId.make("child"),
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("parent"),
    },
    creationSource: "provider" as const,
  };
  const coordinator = (workflow?: OrchestrationV2SubagentWorkflow) => ({
    ...subagent({
      title: "Run the alpha workflow",
      childThreadId: "child",
      ...(workflow === undefined ? {} : { workflow }),
    }),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  });
  const brief = (text: string, workflowScript?: boolean) => ({
    id: "message-1",
    role: "user",
    text,
    ...(workflowScript === undefined ? {} : { workflowScript }),
  });

  it("opens a marked thread with the coordinator's plan and members", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT, true)],
      parentSubagents: [
        coordinator({
          name: "probe-wf",
          phases: [{ index: 1, title: "Alpha" }],
          agents: [member({ childThreadId: ThreadId.make("member-1") })],
        }),
      ],
    });
    expect(opening).toMatchObject({
      messageId: "message-1",
      script: SCRIPT,
      name: "probe-wf",
      description: "Run the alpha workflow",
    });
    expect(
      opening?.group?.phases.map((phase) => ({
        title: phase.title,
        members: phase.members.map((agent) => [agent.title, agent.status, agent.childThreadId]),
      })),
    ).toEqual([{ title: "Alpha", members: [["alpha:one", "running", "member-1"]] }]);
  });

  it("recognizes an unmarked script before the parent loads", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT)],
      parentSubagents: null,
    });
    expect(opening).toMatchObject({ script: SCRIPT, name: null, group: null });
  });

  it("leaves an ordinary subagent thread and other threads alone", () => {
    expect(
      resolveWorkflowOpening({
        thread: childThread,
        messages: [brief("Audit the last five commits.")],
        parentSubagents: [coordinator()],
      }),
    ).toBeNull();
    expect(
      resolveWorkflowOpening({
        thread: {
          ...childThread,
          lineage: { ...childThread.lineage, relationshipToParent: null, parentThreadId: null },
        },
        messages: [brief(SCRIPT)],
        parentSubagents: null,
      }),
    ).toBeNull();
    expect(isWorkflowScriptMessage({ role: "user", text: "Explain `export const meta`." })).toBe(
      false,
    );
    expect(isWorkflowScriptMessage({ role: "assistant", text: SCRIPT })).toBe(false);
  });
});

describe("T3-run workflows", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claude");
  const workflow = {
    ...subagent({
      id: "workflow:w1",
      title: "Review",
      prompt: '// t3-workflow: {"budgetTokens":100}\nphase("Scan")\nreturn 1',
      workflow: {
        name: "review",
        phases: [{ index: 0, title: "Scan" }],
        agents: [
          member({
            index: 0,
            label: "a",
            phaseIndex: 0,
            phaseTitle: "Scan",
            childThreadId: ThreadId.make("thread:a"),
            providerInstanceId: claude,
            driver: ProviderDriverKind.make("claudeAgent"),
          }),
        ],
      },
    }),
    origin: "app_owned" as const,
    parentNodeId: "node:caller" as OrchestrationV2Subagent["parentNodeId"],
    childThreadId: null,
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: codex,
  };
  const memberTask = (id: string, thread: string) => ({
    ...subagent({ id, childThreadId: ThreadId.make(thread) }),
    origin: "app_owned" as const,
    parentNodeId: "workflow:w1" as OrchestrationV2Subagent["parentNodeId"],
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: codex,
  });

  it("lists each workflow's agent threads, in start order", () => {
    const threads = appWorkflowMemberThreads([
      workflow,
      memberTask("node:a", "thread:a"),
      memberTask("node:b", "thread:b"),
    ]);
    expect([...threads.entries()]).toEqual([["workflow:w1", ["thread:a", "thread:b"]]]);
  });

  it("shows the script without its settings line, and each agent's own provider", () => {
    const view = resolveAppWorkflowView(workflow);
    expect(view?.script).toBe('phase("Scan")\nreturn 1');
    expect(view?.name).toBe("review");
    const agent = view?.group?.phases[0]?.members[0];
    expect(agent?.providerInstanceId).toBe(claude);
    expect(agent?.driver).toBe("claudeAgent");
  });

  it("ignores Claude's own workflows, which run in a thread", () => {
    expect(
      resolveAppWorkflowView({ ...workflow, origin: "provider_native", childThreadId: "thread:c" }),
    ).toBeNull();
  });
});

describe("graph workflows", () => {
  const plan = {
    nodes: [
      { key: "a", label: "Schema", wave: 0, dependsOn: [] },
      { key: "b", label: "Build API", wave: 1, dependsOn: ["a"] },
      { key: "c", label: "Build UI", wave: 1, dependsOn: ["a"] },
      { key: "d", label: "End to end", wave: 2, dependsOn: ["b", "c"] },
    ],
  };
  const graphOf = (
    status: OrchestrationV2Subagent["status"],
    workflow: Omit<OrchestrationV2SubagentWorkflow, "phases"> &
      Partial<Pick<OrchestrationV2SubagentWorkflow, "phases">>,
  ) => groupsOf([subagent({ status, workflow: { phases: [], ...workflow } })])[0]?.graph;
  const states = (graph: ReturnType<typeof graphOf>) =>
    Object.fromEntries(
      (graph?.waves ?? []).flat().map((node) => [node.key, [node.state, node.reason]]),
    );

  it("leaves a script workflow without a graph", () => {
    expect(graphOf("running", { agents: [member()] })).toBeNull();
  });

  it("shows waiting nodes and the started node they wait on", () => {
    const graph = graphOf("running", {
      plan,
      nodeOutcomes: { a: { status: "passed", attempts: 1 } },
      agents: [
        member({ index: 0, label: "Schema", state: "completed", graphNodeKey: "a" }),
        member({ index: 1, label: "Build API", state: "running", graphNodeKey: "b" }),
        member({ index: 2, label: "Build UI", state: "queued", graphNodeKey: "c" }),
        member({ index: 3, label: "check Build API", state: "running" }),
      ],
    });
    expect(states(graph)).toEqual({
      a: ["passed", null],
      b: ["running", null],
      c: ["queued", null],
      d: ["waiting", null],
    });
    expect(graph?.waves.map((wave) => wave.map((node) => node.key))).toEqual([
      ["a"],
      ["b", "c"],
      ["d"],
    ]);
    expect(graph?.waves[0]?.[0]?.dependents).toEqual(["b", "c"]);
    expect(graph?.waves[1]?.[0]?.member?.title).toBe("Build API");
    expect(graph?.counts).toEqual({ passed: 1, running: 1, queued: 1, waiting: 1 });
    // Both block d; the first in plan order is named.
    expect(graph?.waitingOn).toEqual({ key: "b", label: "Build API", blocked: 1 });
    expect(graph?.otherMembers.map((agent) => agent.title)).toEqual(["check Build API"]);
  });

  it("marks nodes a stopped run never finished", () => {
    const graph = graphOf("cancelled", {
      plan,
      nodeOutcomes: { a: { status: "passed", attempts: 1 } },
      agents: [
        member({ index: 0, state: "completed", graphNodeKey: "a" }),
        member({ index: 1, state: "running", graphNodeKey: "b" }),
      ],
    });
    expect(states(graph)).toEqual({
      a: ["passed", null],
      b: ["interrupted", null],
      c: ["not_run", null],
      d: ["not_run", null],
    });
    expect(graph?.waitingOn).toBeNull();
  });

  it("shows a node that failed before starting an agent, and its skipped dependents", () => {
    const graph = graphOf("failed", {
      plan,
      nodeOutcomes: {
        a: { status: "failed", attempts: 0, reason: "Input source has no reviewed hash." },
        b: { status: "skipped", attempts: 0, reason: "Predecessor a did not pass." },
        c: { status: "skipped", attempts: 0, reason: "Predecessor a did not pass." },
        d: { status: "skipped", attempts: 0, reason: "Predecessor b did not pass." },
      },
      agents: [],
    });
    expect(states(graph)).toEqual({
      a: ["failed", "Input source has no reviewed hash."],
      b: ["skipped", "Predecessor a did not pass."],
      c: ["skipped", "Predecessor a did not pass."],
      d: ["skipped", "Predecessor b did not pass."],
    });
    expect(graph?.waves[0]?.[0]?.member).toBeNull();
    expect(graph?.counts).toEqual({ failed: 1, skipped: 3 });
  });
});

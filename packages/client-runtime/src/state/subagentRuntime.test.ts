import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  appWorkflowHeading,
  appWorkflowMemberThreads,
  canStopWorkflow,
  canStopWorkflowWork,
  workflowGraphHeadline,
  workflowGraphNodeDetail,
  deriveWorkflowGroups,
  deriveWorkflowProgress,
  resolveAppWorkflowView,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
  workflowProgressText,
  workflowMemberIdentity,
  workflowPhaseStatus,
  deriveWorkflowPhaseGroups,
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

describe("compact workflow presentation", () => {
  it("groups contiguous settled and queued phases while keeping running and failed phases open", () => {
    const states = ["completed", "completed", "running", "failed", "queued", "queued"] as const;
    const progress = deriveWorkflowProgress(
      groupsOf([
        subagent({
          workflow: {
            phases: states.map((_, index) => ({ index, title: `Phase ${index + 1}` })),
            agents: states.map((state, index) => member({ index, phaseIndex: index, state })),
          },
        }),
      ])[0]!,
    );
    expect(
      progress.phaseGroups.map(({ label, kind, summary }) => ({ label, kind, summary })),
    ).toEqual([
      { label: "Phases 1–2", kind: "done", summary: "2 done · total unknown" },
      { label: "Phase 3", kind: null, summary: "1 running · total unknown" },
      { label: "Phase 4", kind: null, summary: "1 failed · total unknown" },
      { label: "Phases 5–6", kind: "queued", summary: "2 queued · total unknown" },
    ]);
    expect(deriveWorkflowPhaseGroups(progress.phases)).toEqual(progress.phaseGroups);
  });

  it("respects declared running, stopped and unobserved phases without inventing completions", () => {
    const progress = deriveWorkflowProgress(
      groupsOf([
        subagent({
          workflow: {
            phases: [
              { index: 0, title: "Scan", progress: { total: 1, state: "running" } },
              { index: 1, title: "Build", progress: { total: 4, state: "completed" } },
              { index: 2, title: "Publish", progress: { total: 3, state: "planned" } },
              { index: 3, title: "Later", progress: { total: 8, state: "planned" } },
            ],
            agents: [
              member({ index: 0, phaseIndex: 0, state: "completed" }),
              member({ index: 1, phaseIndex: 1, state: "completed" }),
            ],
          },
        }),
      ])[0]!,
    );
    const phases = progress.phases.map((phase, index) =>
      index === 2 ? { ...phase, state: "stopped" as const } : phase,
    );
    expect(
      deriveWorkflowPhaseGroups(phases).map(({ kind, summary }) => ({ kind, summary })),
    ).toEqual([
      { kind: null, summary: "1 done" },
      { kind: "done", summary: "1 done · 3 not observed" },
      { kind: "settled", summary: "No agents observed · 3 not observed · phase stopped" },
      { kind: "queued", summary: "8 queued" },
    ]);
  });

  it("derives failures, active retries and dependency blockers without labelling ordinary queued work", () => {
    const progress = deriveWorkflowProgress(
      groupsOf([
        subagent({
          workflow: {
            phases: [],
            plan: {
              nodes: [
                { key: "retry", label: "Retrying", wave: 0, dependsOn: [] },
                { key: "failed", label: "Failed", wave: 0, dependsOn: [] },
                { key: "done", label: "Done", wave: 0, dependsOn: [] },
                { key: "queued", label: "Queued", wave: 0, dependsOn: [] },
                { key: "blocked", label: "Blocked", wave: 1, dependsOn: ["failed"] },
                { key: "indirect", label: "Indirect", wave: 2, dependsOn: ["blocked"] },
              ],
            },
            nodeOutcomes: {
              failed: { status: "failed", reason: "Permission denied" },
              done: { status: "passed", attempts: 3 },
            },
            agents: [
              member({ index: 0, graphNodeKey: "retry", attempt: 2 }),
              member({ index: 1, graphNodeKey: "failed", state: "failed" }),
              member({ index: 2, graphNodeKey: "done", state: "completed", attempt: 2 }),
            ],
          },
        }),
      ])[0]!,
    );
    expect(progress.attention.map((task) => [task.id, task.attention])).toEqual([
      ["failed", { kind: "failed", reason: "Permission denied" }],
      ["retry", { kind: "retrying", reason: "Retry 2" }],
      ["blocked", { kind: "blocked", reason: "Blocked by Failed" }],
      ["indirect", { kind: "blocked", reason: "Blocked by Blocked" }],
    ]);
  });

  it("keeps dependency-skipped and not-run nodes in terminal attention without changing their states", () => {
    const progress = deriveWorkflowProgress(
      groupsOf([
        subagent({
          status: "failed",
          workflow: {
            phases: [],
            agents: [],
            plan: {
              nodes: [
                { key: "failed", label: "Failed", wave: 0, dependsOn: [] },
                { key: "skipped", label: "Skipped", wave: 1, dependsOn: ["failed"] },
                { key: "not-run", label: "Not run", wave: 2, dependsOn: ["skipped"] },
                {
                  key: "independent-skipped",
                  label: "Independent skipped",
                  wave: 0,
                  dependsOn: [],
                },
                {
                  key: "independent-not-run",
                  label: "Independent not run",
                  wave: 0,
                  dependsOn: [],
                },
              ],
            },
            nodeOutcomes: {
              failed: { status: "failed", reason: "Permission denied" },
              skipped: { status: "skipped", reason: "Predecessor failed did not pass." },
              "independent-skipped": { status: "skipped", reason: "Not selected" },
            },
          },
        }),
      ])[0]!,
    );
    expect(
      progress.attention.map(({ id, state, attention }) => ({ id, state, attention })),
    ).toEqual([
      { id: "failed", state: "failed", attention: { kind: "failed", reason: "Permission denied" } },
      {
        id: "skipped",
        state: "skipped",
        attention: { kind: "blocked", reason: "Blocked by Failed" },
      },
      {
        id: "not-run",
        state: "stopped",
        attention: { kind: "blocked", reason: "Blocked by Skipped" },
      },
    ]);
  });

  it.each([
    ["completed", "2026-08-01T10:00:05Z", 5000],
    ["failed", "2026-08-01T10:00:05Z", 5000],
    ["completed", "2026-08-01T09:59:59Z", null],
    ["completed", null, null],
    ["running", "2026-08-01T10:00:05Z", null],
  ] as const)("uses reliable terminal timestamps for %s at %s", (status, end, elapsedMs) => {
    const group = groupsOf([
      subagent({
        status,
        completedAt: end === null ? null : at(end),
        workflow: { phases: [], agents: [] },
      }),
    ])[0]!;
    expect(deriveWorkflowProgress(group).elapsedMs).toBe(elapsedMs);
    expect(
      deriveWorkflowProgress({ ...group, workflow: { ...group.workflow, startedAt: null } })
        .elapsedMs,
    ).toBeNull();
  });
});

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it.each([false, true])(
    "preserves planned identity independently of actual identity (graph=%s)",
    (graph) => {
      const plannedIdentity = {
        providerInstanceId: ProviderInstanceId.make("primary"),
        model: "gpt-6.1-sol",
      };
      const workflow = {
        phases: [],
        agents: [
          member({
            state: "running",
            graphNodeKey: "a",
            plannedIdentity,
            providerInstanceId: ProviderInstanceId.make("fallback"),
            model: "gpt-6-luna",
          }),
        ],
        ...(graph
          ? {
              plan: {
                nodes: [
                  { key: "a", label: "A", wave: 0, dependsOn: [], plannedIdentity },
                  { key: "b", label: "B", wave: 1, dependsOn: ["a"], plannedIdentity },
                ],
              },
            }
          : {}),
      };
      const group = groupsOf([subagent({ workflow })])[0]!;
      const tasks = deriveWorkflowProgress(group).phases.flatMap((phase) => phase.tasks);
      expect(tasks[0]?.plannedIdentity).toEqual(plannedIdentity);
      expect(tasks[0]?.member).toMatchObject({
        plannedIdentity,
        model: "gpt-6-luna",
        providerInstanceId: "fallback",
      });
      if (graph) expect(tasks[1]).toMatchObject({ member: null, plannedIdentity, state: "queued" });
    },
  );
  it.each(["queued", "running", "failed", "completed"] as const)(
    "uses a recorded cancellation only for a settled failed member (%s)",
    (state) => {
      const progress = deriveWorkflowProgress(
        groupsOf([
          subagent({
            workflow: { phases: [], agents: [member({ state, outcomeCategory: "cancelled" })] },
          }),
        ])[0]!,
      );
      expect(progress.phases[0]?.tasks[0]?.state).toBe(
        state === "failed" ? "stopped" : state === "completed" ? "done" : state,
      );
    },
  );
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
              model: "claude-opus-5[1m]",
              effort: "xhigh",
              speed: "standard",
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
    expect(settled?.model).toBe("claude-opus-5[1m]");
    expect(settled?.effort).toBe("xhigh");
    expect(settled?.speed).toBe("standard");
    expect(settled?.intent).toBe("Reply with exactly: A1");
    expect(settled?.progress).toBeNull();
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
      const unfinished = status === "completed" ? "interrupted" : status;
      expect(members?.map((agent) => agent.status)).toEqual([unfinished, unfinished, "completed"]);
      if (status === "completed") expect(deriveWorkflowProgress(groups[0]!).successful).toBe(false);
      expect(members?.map((agent) => agent.completedAt)).toEqual([
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:01.500Z",
      ]);
      expect(members?.[0]?.model).toBeNull();
      expect(members?.[0]?.effort).toBeNull();
      expect(members?.[0]?.speed).toBeUndefined();
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
    expect(group?.phases.flatMap((phase) => phase.members)).toHaveLength(4);
    expect(group?.unphasedMembers).toEqual([]);
    const progress = deriveWorkflowProgress(group!);
    expect(progress.phases.map((phase) => [phase.title, phase.counts.settled])).toEqual([
      ["Alpha", 2],
      ["Beta", 0],
    ]);
    expect(progress.counts).toEqual({
      done: 1,
      failed: 1,
      running: 1,
      queued: 1,
      stopped: 0,
      skipped: 0,
      settled: 2,
      observed: 4,
      total: null,
    });
    expect(progress.phases.map((phase) => phase.counts.total)).toEqual([null, null]);
    expect(progress.phases.map((phase) => phase.allDone)).toEqual([false, false]);
    expect(progress.successful).toBe(false);
    expect(progress.headline).toBe("1 agent failed · alpha:two");
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

describe("workflow progress aggregation", () => {
  it.each([
    {
      state: "planned",
      status: "running",
      total: 4,
      observed: 0,
      allDone: false,
      label: "not started",
    },
    {
      state: "running",
      status: "running",
      total: 1,
      observed: 1,
      allDone: false,
      label: "running",
    },
    { state: "failed", status: "running", total: 1, observed: 1, allDone: false, label: "failed" },
    {
      state: "failed",
      status: "completed",
      total: 1,
      observed: 1,
      allDone: false,
      label: "failed",
    },
    {
      state: "running",
      status: "cancelled",
      total: 1,
      observed: 1,
      allDone: false,
      label: "stopped",
    },
    {
      state: "running",
      status: "completed",
      total: 1,
      observed: 1,
      allDone: false,
      label: "stopped",
    },
    {
      state: "completed",
      status: "completed",
      total: 4,
      observed: 1,
      allDone: true,
      label: "done",
    },
    {
      state: "completed",
      status: "completed",
      total: 4,
      observed: 0,
      allDone: true,
      label: "done",
    },
    {
      state: "completed",
      status: "completed",
      total: 0,
      observed: 0,
      allDone: true,
      label: "done",
    },
  ] as const)(
    "keeps callback $state authoritative with workflow $status and $observed/$total tasks done",
    ({ state, status, total, observed, allDone, label }) => {
      const progress = deriveWorkflowProgress(
        groupsOf([
          subagent({
            status,
            workflow: {
              phases: [{ index: 0, title: "Audit", progress: { total, state } }],
              agents: Array.from({ length: observed }, (_, index) =>
                member({ index, phaseIndex: 0, state: "completed", completedAt: 2000 }),
              ),
            },
          }),
        ])[0]!,
      );
      expect(progress.counts).toMatchObject({ total, observed, done: observed, settled: observed });
      expect(progress.phases[0]?.allDone).toBe(allDone);
      expect(workflowPhaseStatus(progress.phases[0]!)).toBe(label);
      expect(progress.successful).toBe(allDone && status === "completed");
      if (state === "failed") {
        expect(progress.headline).toBe("Audit failed");
        expect(progress.headlineMember).toBeNull();
      }
    },
  );

  it.each(["running", "completed", "failed", "cancelled"] as const)(
    "preserves planned script totals, callback lifecycle and member failures when %s",
    (status) => {
      const progress = deriveWorkflowProgress(
        groupsOf([
          subagent({
            status,
            workflow: {
              phases: [
                {
                  index: 0,
                  title: "Audit",
                  progress: { total: 10, state: status === "completed" ? "completed" : "running" },
                },
                { index: 1, title: "Next", progress: { total: 3, state: "planned" } },
              ],
              agents: [
                member({ index: 0, phaseIndex: 0, state: "completed", attempt: 2 }),
                member({ index: 1, phaseIndex: 0, state: "failed" }),
                member({
                  index: 2,
                  phaseIndex: 0,
                  state: "completed",
                  judgmentFor: { agentIndex: 0, attempt: 2 },
                }),
              ],
            },
          }),
        ])[0]!,
      );
      expect(progress.counts).toMatchObject({
        total: 13,
        done: 1,
        failed: 1,
        observed: 2,
        settled: 2,
      });
      expect(progress.phases[0]?.counts).toMatchObject({ total: 10, observed: 2 });
      expect(progress.phases[1]?.counts).toMatchObject({ total: 3, observed: 0 });
      expect(progress.phases[2]?.title).toBe("Other agents");
      expect(progress.phases.map((phase) => phase.allDone)).toEqual([false, false, true]);
      expect(progress.phases[0]?.state).toBe(status === "cancelled" ? "stopped" : status);
      expect(progress.successful).toBe(false);
    },
  );

  it("shows zero work and a caught callback failure without inventing successful agents", () => {
    const progress = deriveWorkflowProgress(
      groupsOf([
        subagent({
          status: "completed",
          workflow: {
            phases: [{ index: 0, title: "Empty", progress: { total: 0, state: "failed" } }],
            agents: [],
          },
        }),
      ])[0]!,
    );
    expect(progress.counts).toMatchObject({ total: 0, observed: 0, settled: 0, done: 0 });
    expect(progress.headline).toBe("Empty failed");
    expect(progress.successful).toBe(false);
  });
  it.each(["completed", "cancelled", "interrupted"] as const)(
    "announces %s instead of the retained activity log",
    (status) => {
      const group = groupsOf([
        subagent({
          status,
          progress: "Dispatching audit agents",
          workflow: { phases: [], agents: [member({ state: "completed" })] },
        }),
      ])[0]!;
      const progress = deriveWorkflowProgress(group);
      expect(progress.headline).toBe(
        `${appWorkflowHeading(status)} · 1 settled · 1 discovered · total unknown`,
      );
      expect(progress.successful).toBe(status === "completed");
      expect(progress.headlineMember).toBeNull();
      expect(progress.phases[0]?.allDone).toBe(true);
    },
  );

  it.each([1, 2])(
    "keeps %i auxiliary failures separate from the fixed graph denominator",
    (failures) => {
      const workflow = {
        phases: [],
        plan: { nodes: [{ key: "a", label: "Audit", wave: 0, dependsOn: [] }] },
        agents: [member({ graphNodeKey: "a", state: "completed" })],
        nodeOutcomes: { a: { status: "passed" as const } },
      };
      const before = deriveWorkflowProgress(
        groupsOf([subagent({ workflow, status: "completed" })])[0]!,
      );
      const after = deriveWorkflowProgress(
        groupsOf([
          subagent({
            status: "completed",
            workflow: {
              ...workflow,
              agents: [
                ...workflow.agents,
                ...Array.from({ length: failures }, (_, index) =>
                  member({
                    index: index + 2,
                    label: "Auxiliary check",
                    state: "failed",
                    result: "Permission denied",
                  }),
                ),
              ],
            },
          }),
        ])[0]!,
      );
      expect(after.counts).toEqual(before.counts);
      expect(before.successful).toBe(true);
      expect(after.counts).toMatchObject({ total: 1, observed: 1, done: 1, settled: 1 });
      expect(after.phases.at(-1)?.counts).toMatchObject({
        total: null,
        observed: failures,
        failed: failures,
      });
      expect(after.failedCount).toBe(failures);
      expect(after.agentCount).toBe(1 + failures);
      expect(after.headline).toBe(
        `${failures} ${failures === 1 ? "agent" : "agents"} failed · Auxiliary check: Permission denied`,
      );
      expect(after.successful).toBe(false);
    },
  );

  it("counts a logical agent once across retries and excludes native descendants", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({
        workflow: {
          phases: [],
          agents: [
            member({ state: "failed", startedAt: 1000, completedAt: 9000 }),
            member({ state: "running", attempt: 2, startedAt: 2000 }),
          ],
        },
      }),
    ]);
    const native = {
      ...runtime[1]!,
      id: "native-child",
      kind: "subagent" as const,
      parentAgentId: "coordinator",
      agentIndex: null,
      startedAt: "2099-01-01T00:00:00Z",
    };
    const progress = deriveWorkflowProgress(deriveWorkflowGroups([...runtime, native])[0]!);
    expect(progress.counts).toMatchObject({ observed: 1, running: 1, failed: 0, total: null });
    expect(progress.phases[0]?.tasks[0]?.member?.attempt).toBe(2);
    expect(progress.headlineMember?.attempt).toBe(2);
  });

  it("selects the latest logical start or completion without inventing missing activity", () => {
    const group = groupsOf([
      subagent({
        workflow: {
          phases: [],
          agents: [
            member({ index: 1, model: "gpt-6-luna", startedAt: 2000 }),
            member({
              index: 2,
              state: "completed",
              model: "gpt-6.1-sol",
              startedAt: 1000,
              completedAt: 3000,
            }),
            member({ index: 3, prompt: "Latest activity", model: "claude-opus-5-5" }),
          ],
        },
      }),
    ])[0]!;
    expect(deriveWorkflowProgress(group).headlineMember?.model).toBe("gpt-6.1-sol");
    const withMembers = (members: (typeof group.phases)[number]["members"]) => ({
      ...group,
      phases: [{ ...group.phases[0]!, members }],
    });
    const [first, second, missing] = group.phases[0]!.members;
    const tied = [first!, { ...second!, completedAt: first!.startedAt }];
    expect(deriveWorkflowProgress(withMembers(tied)).headlineMember?.id).toBe(first!.id);
    expect(deriveWorkflowProgress(withMembers(tied.toReversed())).headlineMember?.id).toBe(
      first!.id,
    );
    const unknown = { ...missing!, startedAt: "1970-01-01T00:00:04Z", model: null };
    expect(deriveWorkflowProgress(withMembers([first!, second!, unknown])).headlineMember).toBe(
      unknown,
    );
    expect(
      deriveWorkflowProgress(
        withMembers([
          { ...first!, startedAt: "invalid", completedAt: null, updatedAt: "2099-01-01T00:00:00Z" },
          missing!,
        ]),
      ).headlineMember,
    ).toBeNull();
    expect(
      deriveWorkflowProgress({
        ...group,
        workflow: { ...group.workflow, progress: "Coordinator log" },
      }).headlineMember,
    ).toBeNull();
    expect(
      deriveWorkflowProgress({ ...group, workflow: { ...group.workflow, status: "failed" } })
        .headlineMember,
    ).toBeNull();
  });

  it.each([4, 40, 256])("preserves unknown script totals as %i agents are discovered", (count) => {
    const group = groupsOf([
      subagent({
        progress: "Inspecting exports",
        workflow: {
          phases: [],
          agents: Array.from({ length: count }, (_, index) =>
            member({ index, prompt: "Static instructions" }),
          ),
        },
      }),
    ])[0]!;
    expect(deriveWorkflowProgress(group).counts).toMatchObject({ observed: count, total: null });
    expect(deriveWorkflowProgress(group).headline).toBe("Inspecting exports");
    expect(deriveWorkflowProgress(group).headlineMember).toBeNull();
    expect(
      deriveWorkflowProgress({ ...group, workflow: { ...group.workflow, progress: " " } }).headline,
    ).toBe(`Alpha · ${count} running`);
  });

  it("keeps graph totals fixed across retries and distinguishes settlement from success", () => {
    const workflow = {
      phases: [],
      plan: {
        nodes: [
          { key: "a", label: "Audit", wave: 0, dependsOn: [] },
          { key: "b", label: "Build", wave: 1, dependsOn: ["a"] },
        ],
      },
      agents: [
        member({ graphNodeKey: "a", state: "failed", startedAt: 1000, completedAt: 9000 }),
        member({ index: 2, graphNodeKey: "a", state: "running", attempt: 1, startedAt: 2000 }),
      ],
    };
    const running = deriveWorkflowProgress(groupsOf([subagent({ workflow })])[0]!);
    expect(running.counts).toMatchObject({
      total: 2,
      observed: 2,
      running: 1,
      failed: 0,
      queued: 1,
    });
    expect(running.headlineMember?.agentIndex).toBe(2);
    const failed = deriveWorkflowProgress(
      groupsOf([
        subagent({
          status: "failed",
          progress: "Old log",
          workflow: {
            ...workflow,
            nodeOutcomes: {
              a: { status: "failed", reason: "Permission denied" },
              b: { status: "skipped" },
            },
          },
        }),
      ])[0]!,
    );
    expect(failed.counts).toMatchObject({ total: 2, settled: 2, done: 0, failed: 1, skipped: 1 });
    expect(failed.successful).toBe(false);
    expect(failed.headline).toBe("1 agent failed · Audit: Permission denied");
    expect(failed.headlineMember).toBeNull();
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

  it("counts every waiting node behind a blocker, through chains", () => {
    const chain = {
      nodes: [
        { key: "a", label: "A", wave: 0, dependsOn: [] },
        { key: "b", label: "B", wave: 1, dependsOn: ["a"] },
        { key: "c", label: "C", wave: 2, dependsOn: ["b"] },
        { key: "d", label: "D", wave: 2, dependsOn: ["b"] },
        { key: "e", label: "E", wave: 3, dependsOn: ["c", "d"] },
        { key: "solo", label: "Solo", wave: 0, dependsOn: [] },
      ],
    };
    const graph = graphOf("running", {
      plan: chain,
      agents: [
        member({ index: 0, state: "running", graphNodeKey: "a" }),
        member({ index: 1, state: "running", graphNodeKey: "solo" }),
      ],
    });
    // b, c, d and e all wait on a; e is counted once though it waits on two of them.
    expect(graph?.waitingOn).toEqual({ key: "a", label: "A", blocked: 4 });
  });

  it("names no blocker when nothing waits, and puts agents for unknown nodes aside", () => {
    const graph = graphOf("running", {
      plan,
      nodeOutcomes: { a: { status: "passed", attempts: 1 } },
      agents: [
        member({ index: 1, state: "running", graphNodeKey: "b" }),
        member({ index: 2, state: "running", graphNodeKey: "c" }),
        member({ index: 3, state: "queued", graphNodeKey: "zz", label: "stray" }),
      ],
    });
    expect(states(graph).d).toEqual(["waiting", null]);
    expect(graph?.otherMembers.map((agent) => agent.title)).toEqual(["stray"]);
    const done = graphOf("running", {
      plan,
      nodeOutcomes: {
        a: { status: "passed" },
        b: { status: "passed" },
        c: { status: "passed" },
      },
      agents: [member({ index: 3, state: "running", graphNodeKey: "d" })],
    });
    expect(done?.waitingOn).toBeNull();
  });

  it("uses the latest agent for a node, and shows a node retrying as running", () => {
    const failed = graphOf("running", {
      plan,
      agents: [member({ state: "failed", graphNodeKey: "a" })],
    });
    expect(failed?.waves[0]?.[0]?.state).toBe("failed");
    const graph = graphOf("running", {
      plan,
      agents: [
        member({ index: 0, state: "failed", graphNodeKey: "a", label: "first try" }),
        member({ index: 1, state: "running", graphNodeKey: "a", label: "second try", attempt: 2 }),
      ],
    });
    const a = graph?.waves[0]?.[0];
    expect(a?.state).toBe("running");
    expect(a?.member?.title).toBe("second try");
  });

  it("associates checkers by explicit node identity across duplicate labels and retries", () => {
    const graph = graphOf("failed", {
      plan: { nodes: plan.nodes.map((node) => ({ ...node, label: "Same label" })) },
      agents: [
        member({ index: 0, graphNodeKey: "a", childThreadId: ThreadId.make("old-worker") }),
        member({
          index: 1,
          label: "check Same label",
          judgmentFor: { agentIndex: 0, attempt: 0, graphNodeKey: "a" },
          childThreadId: ThreadId.make("first-check"),
        }),
        member({ index: 2, graphNodeKey: "b", childThreadId: ThreadId.make("other-worker") }),
        member({
          index: 3,
          label: "check Same label",
          state: "failed",
          judgmentFor: { agentIndex: 0, attempt: 1, graphNodeKey: "a" },
          childThreadId: ThreadId.make("retry-check"),
        }),
        member({
          index: 4,
          label: "check Same label",
          judgmentFor: { agentIndex: 2, attempt: 0, graphNodeKey: "b" },
          childThreadId: ThreadId.make("other-check"),
        }),
        member({ index: 5, graphNodeKey: "a", childThreadId: ThreadId.make("new-worker") }),
        member({ index: 6, label: "check Same label" }),
      ],
    })!;
    const [a, b] = graph.waves.flat();
    expect(a?.member?.childThreadId).toBe("new-worker");
    expect(a?.checkers.map((checker) => checker.childThreadId)).toEqual([
      "first-check",
      "retry-check",
    ]);
    expect(b?.checkers.map((checker) => checker.childThreadId)).toEqual(["other-check"]);
    expect(graph.otherMembers.map((checker) => checker.agentIndex)).toEqual([6]);
  });

  it("uses actual member provider and model, leaving never-started nodes neutral", () => {
    const graph = graphOf("failed", {
      plan,
      agents: [
        member({
          index: 0,
          graphNodeKey: "a",
          model: "actual-model",
          providerInstanceId: ProviderInstanceId.make("other-provider"),
          childThreadId: ThreadId.make("actual-thread"),
        }),
        member({ index: 1, graphNodeKey: "b", state: "failed" }),
      ],
    })!;
    const nodes = graph.waves.flat();
    expect(nodes.map((node) => workflowMemberIdentity(node.member))).toEqual([
      "other-provider / actual-model",
      "Not started",
      "Not started",
      "Not started",
    ]);
    expect(nodes[0]?.member?.model).not.toBe(subagent().model);
  });

  it("words the status line and each node's detail", () => {
    const graph = graphOf("running", {
      plan,
      nodeOutcomes: {
        a: { status: "passed", attempts: 2 },
      },
      agents: [member({ index: 1, state: "running", graphNodeKey: "b", attempt: 1 })],
    })!;
    expect(workflowGraphHeadline(graph)).toEqual({
      summary: "1/4 passed · 1 running · 2 waiting",
      waitingOn: "Waiting on Build API: 1 node depends on it",
    });
    const labels = new Map(plan.nodes.map((node) => [node.key, node.label]));
    expect(graph.waves.flat().map((node) => workflowGraphNodeDetail(node, labels))).toEqual([
      { detail: null, retries: "2 attempts" },
      { detail: "after Schema", retries: "retry 1" },
      { detail: "after Schema", retries: null },
      { detail: "after Build API, Build UI", retries: null },
    ]);
  });
});

describe("workflow progress text", () => {
  const plan = {
    nodes: [
      { key: "build", label: "Build API", wave: 0, dependsOn: [] },
      { key: "test", label: "Test", wave: 1, dependsOn: ["build"] },
    ],
  };
  const legacy =
    "The workflow failed: Graph failed: " +
    JSON.stringify({
      ok: false,
      nodes: {
        build: {
          status: "failed",
          reason: "Provider unavailable",
          outputs: { huge: "x".repeat(10000) },
        },
        test: { status: "skipped" },
      },
    }) +
    " (at eval_script:25)";
  const row = {
    status: "failed" as const,
    result: legacy,
    workflow: { plan, phases: [], agents: [] },
  };

  it("says nothing for a failed graph, whose counts and failed node already say it", () => {
    expect(workflowProgressText(row)).toBeNull();
    expect(
      workflowProgressText({
        ...row,
        workflow: {
          ...row.workflow,
          nodeOutcomes: { build: { status: "failed", reason: "Recorded reason" } },
        },
      }),
    ).toBeNull();
    expect(
      workflowProgressText({
        ...row,
        result: legacy.slice(0, 100),
        workflow: {
          ...row.workflow,
          nodeOutcomes: {
            build: { status: "failed", reason: "Provider unavailable" },
            test: { status: "skipped" },
          },
        },
      }),
    ).toBeNull();
  });

  it("preserves unknown errors and script results and hides only graph success records", () => {
    for (const result of ["Permission denied", "{bad JSON}", '{"ok":false,"nodes":{}}']) {
      expect(workflowProgressText({ ...row, result })).toBe(result);
    }
    expect(workflowProgressText({ ...row, workflow: undefined })).toBe(legacy);
    const result = JSON.stringify({
      ok: true,
      nodes: { build: { status: "passed" }, test: { status: "passed" } },
    });
    expect(workflowProgressText({ ...row, status: "completed", result })).toBeNull();
    expect(workflowProgressText({ ...row, status: "completed", result, workflow: undefined })).toBe(
      result,
    );
    expect(workflowProgressText({ ...row, status: "running", progress: "Working" })).toBe(
      "Working",
    );
  });

  it("reads the server's compact record, its counts form, and nodes that carry provenance", () => {
    const sha = "a".repeat(64);
    const omitted =
      "input and output sha256 and any cut detail: workflow_status workflowId=workflow:w1, field nodes";
    const nodeOutcomes = {
      build: {
        status: "passed" as const,
        attempts: 1,
        inputs: { source: sha },
        outputs: { out: { path: "out/build.md", sha256: sha, sizeBytes: 3 } },
      },
      test: { status: "passed" as const, attempts: 1 },
    };
    const compact = JSON.stringify({
      ok: true,
      nodes: {
        build: {
          status: "passed",
          attempts: 1,
          outputs: { out: { path: "out/build.md", sizeBytes: 3 } },
        },
        test: { status: "passed", attempts: 1 },
      },
      omitted,
    });
    const workflow = { ...row.workflow, nodeOutcomes };
    expect(
      workflowProgressText({ ...row, status: "completed", result: compact, workflow }),
    ).toBeNull();
    // A graph too large for one status each has no nodes: the text is shown as it is.
    const counts = JSON.stringify({
      ok: false,
      counts: { passed: 1, failed: 1, skipped: 0 },
      reasons: [{ node: "build", reason: "Provider unavailable" }],
      omitted,
    });
    expect(workflowProgressText({ ...row, result: counts, workflow })).toBe(counts);
    // A failed graph's text cut at 4,096 bytes still reads from the stored outcomes.
    const cut = `The workflow failed: Graph failed: 1 node failed, 1 skipped. Build API: Provid...truncated (60 of 9000 bytes), per-node detail at workflow_status workflowId=workflow:w1, field nodes`;
    expect(
      workflowProgressText({
        ...row,
        result: cut,
        workflow: {
          ...row.workflow,
          nodeOutcomes: {
            build: { status: "failed", reason: "Provider unavailable", inputs: { source: sha } },
            test: { status: "skipped" },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("appWorkflowHeading", () => {
  it("names each run state, and stays generic before the run has one", () => {
    expect(
      (["running", "completed", "failed", "cancelled", "interrupted", "pending"] as const).map(
        appWorkflowHeading,
      ),
    ).toEqual([
      "Workflow running",
      "Workflow finished",
      "Workflow failed",
      "Workflow stopped",
      "Workflow stopped",
      "Workflow",
    ]);
  });
});

describe("canStopWorkflow", () => {
  const driver = (value: string) => ProviderDriverKind.make(value);

  it("offers Stop only while a workflow T3 can stop is running", () => {
    const statuses = [
      "pending",
      "running",
      "waiting",
      "idle",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const;
    expect(
      statuses.filter((status) =>
        canStopWorkflow({ status, origin: "app_owned", driver: driver("codex") }),
      ),
    ).toEqual(["running"]);
    expect(
      statuses.filter((status) =>
        canStopWorkflow({ status, origin: "provider_native", driver: driver("claudeAgent") }),
      ),
    ).toEqual(["running"]);
  });

  it("leaves a provider-native workflow only Claude can stop to the provider", () => {
    expect(
      canStopWorkflow({
        status: "running",
        origin: "provider_native",
        driver: driver("codex"),
      }),
    ).toBe(false);
    expect(canStopWorkflow({ status: "running", origin: "provider_native", driver: null })).toBe(
      false,
    );
  });
});

describe("canStopWorkflowWork", () => {
  const driver = ProviderDriverKind.make("codex");
  const workflow = (
    status: OrchestrationV2Subagent["status"],
    origin: "app_owned" | "provider_native" = "app_owned",
  ) => ({
    id: NodeId.make("workflow-1"),
    status,
    origin,
    driver,
  });
  const member = (
    status: OrchestrationV2Subagent["status"],
    overrides: Partial<
      Pick<OrchestrationV2Subagent, "origin" | "parentNodeId" | "childThreadId">
    > = {},
  ) => ({
    origin: "app_owned" as const,
    parentNodeId: NodeId.make("workflow-1"),
    childThreadId: ThreadId.make("thread-member"),
    status,
    ...overrides,
  });

  it("keeps Stop for a cancelled workflow while a member it started is still active", () => {
    // A stop cancels the row first; when a member stop then fails, the member keeps running.
    expect(canStopWorkflowWork(workflow("cancelled"), [member("running")])).toBe(true);
    expect(canStopWorkflowWork(workflow("failed"), [member("waiting")])).toBe(true);
    expect(canStopWorkflowWork(workflow("interrupted"), [member("pending")])).toBe(true);
  });

  it("drops Stop once the row and every member have settled", () => {
    expect(
      canStopWorkflowWork(workflow("cancelled"), [member("cancelled"), member("completed")]),
    ).toBe(false);
    expect(canStopWorkflowWork(workflow("completed"), [])).toBe(false);
  });

  it("offers Stop for a running workflow whatever its members do", () => {
    expect(canStopWorkflowWork(workflow("running"), [])).toBe(true);
    expect(canStopWorkflowWork(workflow("running"), [member("completed")])).toBe(true);
  });

  it("looks only at members this workflow started", () => {
    const stranger = member("running", { parentNodeId: NodeId.make("another-workflow") });
    const native = member("running", { origin: "provider_native" });
    const noThread = member("running", { childThreadId: null });
    expect(canStopWorkflowWork(workflow("cancelled"), [stranger, native, noThread])).toBe(false);
  });

  it("does not extend a provider-native workflow, whose members T3 does not own", () => {
    expect(canStopWorkflowWork(workflow("cancelled", "provider_native"), [member("running")])).toBe(
      false,
    );
  });
});

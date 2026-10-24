import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  workflowNodeAccounting,
} from "./subagentRuntime.ts";

const history = (
  overrides: Partial<NonNullable<OrchestrationV2WorkflowAgent["attemptHistory"]>[number]> = {},
) => ({
  taskId: NodeId.make("first"),
  childThreadId: ThreadId.make("old-child"),
  attempt: 0,
  state: "failed" as const,
  providerInstanceId: ProviderInstanceId.make("provider-a"),
  model: "model-a",
  totalTokens: 40,
  usageStatus: "complete" as const,
  durationMs: 2000,
  timingComplete: true,
  startedAt: 1000,
  ...overrides,
});
function graph(
  agents: ReadonlyArray<Partial<OrchestrationV2WorkflowAgent>>,
  status: "running" | "completed" = "completed",
) {
  const runtime = projectedSubagentsToRuntime([
    {
      id: "workflow",
      title: "Graph",
      prompt: "",
      model: null,
      status,
      result: null,
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(20000),
      updatedAt: DateTime.makeUnsafe(20000),
      workflow: {
        phases: [],
        plan: { nodes: [{ key: "a", label: "Audit", wave: 0, dependsOn: [] }] },
        agents: agents.map((agent, index) => ({
          index,
          label: "Audit",
          state: "completed",
          graphNodeKey: "a",
          ...agent,
        })),
      },
    },
  ]);
  return deriveWorkflowGroups(runtime)[0]!.graph!.waves[0]![0]!;
}

describe("workflow attempt accounting", () => {
  it("keeps a stopped in-flight attempt interrupted with lower-bound counts", () => {
    const result = workflowNodeAccounting(
      graph([{ attemptHistory: [history({ state: "running" })] }]),
    );
    expect(result.attempts[0]?.status).toBe("interrupted");
    expect(result.tokens).toEqual({ value: 40, complete: false });
    expect(result.elapsed).toEqual({ value: 2000, complete: false });
  });
  it("advances only the active run and keeps completed durations and queue gaps distinct", () => {
    const active = history({
      taskId: NodeId.make("second"),
      attempt: 1,
      state: "running",
      startedAt: 8000,
      activeStartedAt: 10000,
      completedDurationMs: 500,
      durationMs: 500,
      timingComplete: false,
    });
    const node = graph(
      [{ state: "running", attempt: 1, attemptHistory: [history(), active] }],
      "running",
    );
    expect(workflowNodeAccounting(node, 13000).elapsed).toEqual({ value: 5500, complete: false });
    expect(workflowNodeAccounting(node, 14000).elapsed.value).toBe(6500);
    expect(workflowNodeAccounting(node, 14000).attempts[1]?.elapsed.value).toBe(4500);
    expect(workflowNodeAccounting(node, 14000).live).toBe(true);
    const queued = graph([
      {
        state: "running",
        attemptHistory: [
          history({
            state: "running",
            durationMs: undefined,
            startedAt: undefined,
            timingComplete: false,
          }),
        ],
      },
    ]);
    expect(workflowNodeAccounting(queued, 14000).elapsed.value).toBeNull();
    expect(workflowNodeAccounting(queued, 14000).live).toBe(false);
    const stopped = graph([{ state: "failed", attempt: 1, attemptHistory: [history(), active] }]);
    expect(workflowNodeAccounting(stopped, 14000).elapsed.value).toBe(2500);
    expect(workflowNodeAccounting(stopped, 14000).live).toBe(false);
    const replayed = graph(
      [
        { state: "running", attemptHistory: [active] },
        { attemptHistory: [history({ ...active, state: "completed", timingComplete: true })] },
      ],
      "running",
    );
    expect(workflowNodeAccounting(replayed, 14000).live).toBe(false);
  });

  it("sums distinct attempts instead of cumulative member totals and keeps earlier routing and identity", () => {
    const first = history();
    const second = history({
      taskId: NodeId.make("second"),
      childThreadId: ThreadId.make("new-child"),
      attempt: 1,
      state: "completed",
      providerInstanceId: ProviderInstanceId.make("provider-b"),
      model: "model-b",
      totalTokens: 60,
      durationMs: 3000,
      startedAt: 10000,
    });
    const node = graph([
      {
        totalTokens: 100,
        attempt: 1,
        childThreadId: second.childThreadId,
        attemptHistory: [first, first, second],
      },
      {
        index: 5,
        judgmentFor: { agentIndex: 0, attempt: 0, graphNodeKey: "a" },
        totalTokens: 900,
        attemptHistory: [history({ taskId: NodeId.make("judge"), totalTokens: 900 })],
      },
    ]);
    const result = workflowNodeAccounting(node);
    expect(result.tokens).toEqual({ value: 100, complete: true });
    expect(result.elapsed).toEqual({ value: 5000, complete: true });
    expect(
      result.attempts.map((attempt) => [
        attempt.childThreadId,
        attempt.providerInstanceId,
        attempt.model,
      ]),
    ).toEqual([
      ["old-child", "provider-a", "model-a"],
      ["new-child", "provider-b", "model-b"],
    ]);
    expect(node.member?.childThreadId).toBe("new-child");
    expect(node.checkers).toHaveLength(1);
  });

  it("preserves unknown and partial usage and timing as lower bounds", () => {
    const result = workflowNodeAccounting(
      graph([
        {
          attempt: 1,
          attemptHistory: [
            history(),
            history({
              taskId: NodeId.make("second"),
              attempt: 1,
              totalTokens: undefined,
              usageStatus: "unavailable",
              durationMs: undefined,
              timingComplete: false,
            }),
          ],
        },
      ]),
    );
    expect(result.tokens).toEqual({ value: 40, complete: false });
    expect(result.elapsed).toEqual({ value: 2000, complete: false });
    expect(result.attempts[1]?.tokens.value).toBeNull();
    expect(result.attempts[1]?.elapsed.value).toBeNull();
    const unknown = workflowNodeAccounting(
      graph([
        {
          attemptHistory: [
            history({
              totalTokens: undefined,
              usageStatus: "unavailable",
              durationMs: undefined,
              timingComplete: false,
            }),
          ],
        },
      ]),
    );
    expect(unknown.tokens.value).toBeNull();
    expect(unknown.elapsed.value).toBeNull();
  });

  it("uses a legacy cumulative total once and never invents earlier duration or identity", () => {
    const result = workflowNodeAccounting(
      graph([
        {
          attempt: 1,
          attemptTaskIds: [NodeId.make("old"), NodeId.make("latest")],
          totalTokens: 55561,
          startedAt: 1000,
          completedAt: 20000,
          childThreadId: ThreadId.make("latest-child"),
          model: "latest-model",
        },
      ]),
    );
    expect(result.tokens).toEqual({ value: 55561, complete: false });
    expect(result.elapsed).toEqual({ value: null, complete: false });
    expect(result.attempts[0]).toMatchObject({
      childThreadId: null,
      model: null,
      status: "unknown",
    });
    expect(result.attempts[1]?.childThreadId).toBe("latest-child");
  });

  it("deduplicates replayed snapshots by task identity and retains multiple member histories", () => {
    const result = workflowNodeAccounting(
      graph([
        { attemptHistory: [history()] },
        {
          attemptHistory: [
            history(),
            history({
              taskId: NodeId.make("second"),
              attempt: 1,
              totalTokens: 10,
              usageStatus: "partial",
            }),
          ],
        },
      ]),
    );
    expect(result.attempts).toHaveLength(2);
    expect(result.tokens).toEqual({ value: 50, complete: false });
    const missing = workflowNodeAccounting(graph([{ attempt: 2, attemptHistory: [history()] }]));
    expect(missing.missing).toBe(true);
    expect(missing.tokens.complete).toBe(false);
    expect(workflowNodeAccounting(graph([])).tokens.value).toBeNull();
  });
});

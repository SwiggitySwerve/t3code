import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2WorkflowAgent,
} from "@t3tools/contracts";
import { workflowBudget, workflowRecordedUsage } from "./workflowBudget.ts";

const member = (tokens: number | undefined, index = 0): OrchestrationV2WorkflowAgent => ({
  index,
  label: `Worker ${index}`,
  state: "completed",
  totalTokens: tokens,
  attemptHistory: [
    {
      taskId: NodeId.make(`task-${index}`),
      childThreadId: ThreadId.make(`child-${index}`),
      attempt: 0,
      state: "completed",
      providerInstanceId: ProviderInstanceId.make("codex"),
      totalTokens: tokens,
      usageStatus: tokens === undefined ? "unavailable" : "complete",
      timingComplete: false,
    },
  ],
});
describe("workflow budget", () => {
  it("distinguishes unset, zero, within, exhausted and overshot limits", () => {
    const read = (limit: number | undefined, spent: number) =>
      workflowBudget({
        phases: [],
        agents: [member(spent)],
        ...(limit === undefined ? {} : { budget: { limit, exhausted: false } }),
      });
    expect(read(undefined, 12)).toEqual({
      spent: 12,
      complete: true,
      limit: null,
      exhausted: false,
      overshot: false,
    });
    expect(read(0, 0)).toMatchObject({ exhausted: true, overshot: false });
    expect(read(100, 99)).toMatchObject({ exhausted: false, overshot: false });
    expect(read(100, 100)).toMatchObject({ exhausted: true, overshot: false });
    expect(read(100, 101)).toMatchObject({ exhausted: true, overshot: true });
  });
  it("counts retries and independent checkers once through replay and restart", () => {
    const worker = member(30);
    const retried = {
      ...worker,
      totalTokens: 80,
      attemptHistory: [
        ...worker.attemptHistory!,
        { ...member(50, 1).attemptHistory![0]!, attempt: 1 },
      ],
    };
    const checker = { ...member(20, 2), judgmentFor: { agentIndex: 0, attempt: 1 } };
    expect(workflowRecordedUsage([retried, checker, retried])).toEqual({
      spent: 100,
      complete: true,
    });
    expect(workflowRecordedUsage(JSON.parse(JSON.stringify([retried, checker])))).toEqual({
      spent: 100,
      complete: true,
    });
  });
  it("retains recorded spending while a reattached task refreshes unknown usage", () => {
    const recorded = member(60);
    const refreshing = {
      ...member(undefined),
      attemptHistory: [{ ...member(undefined).attemptHistory![0]!, state: "running" as const }],
    };
    expect(workflowRecordedUsage([recorded, refreshing])).toEqual({ spent: 60, complete: false });
  });
  it("keeps unknown and partial usage explicit, including parallel overshoot", () => {
    expect(workflowRecordedUsage([])).toEqual({ spent: 0, complete: true });
    expect(workflowRecordedUsage([member(undefined)])).toEqual({ spent: null, complete: false });
    expect(workflowRecordedUsage([member(30), member(undefined, 1)])).toEqual({
      spent: 30,
      complete: false,
    });
    const running = member(60, 1);
    const partial = {
      ...running,
      attemptHistory: [{ ...running.attemptHistory![0]!, state: "running" as const }],
    };
    expect(
      workflowBudget({
        phases: [],
        agents: [member(60), partial],
        budget: { limit: 100, exhausted: false },
      }),
    ).toEqual({
      spent: 120,
      complete: false,
      limit: 100,
      exhausted: true,
      overshot: true,
    });
    expect(
      workflowRecordedUsage([
        {
          index: 0,
          label: "legacy",
          state: "completed",
          agentId: "old",
          attemptTaskIds: [NodeId.make("a"), NodeId.make("b")],
          totalTokens: 90,
        },
      ]),
    ).toEqual({ spent: 90, complete: false });
  });
});

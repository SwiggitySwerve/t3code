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
  applyWorkflowUpdate,
  mergeWorkflowPatch,
  workflowPatches,
  workflowJsonBytes,
} from "./workflowUpdate.ts";

const empty: OrchestrationV2SubagentWorkflow = { phases: [], agents: [] };
const task = (workflow = empty): OrchestrationV2Subagent => ({
  id: NodeId.make("workflow"),
  threadId: ThreadId.make("thread"),
  runId: null,
  parentNodeId: NodeId.make("parent"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: null,
  prompt: "retained script",
  title: "workflow",
  model: null,
  status: "running",
  result: null,
  startedAt: DateTime.makeUnsafe(0),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe(0),
  workflow,
});
describe("workflow updates", () => {
  it("preserves identities, omission, plan and complete histories across bounded bursts", () => {
    const next: OrchestrationV2SubagentWorkflow = {
      phases: [{ index: 0, title: "Audit" }],
      budget: { limit: 100000, exhausted: false },
      plan: {
        nodes: Array.from({ length: 150 }, (_, i) => ({
          key: `n${i}`,
          label: `日本語 ${i}`,
          wave: 0,
          dependsOn: [],
        })),
      },
      agents: Array.from({ length: 150 }, (_, i) => ({
        index: i,
        label: `Audit ${i}`,
        state: "completed",
        prompt: "長い 🧪".repeat(100),
        result: "Result 🧪".repeat(200),
        graphNodeKey: `n${i}`,
        attemptHistory: Array.from({ length: 3 }, (_, attempt) => ({
          taskId: NodeId.make(`task-${i}-${attempt}`),
          childThreadId: ThreadId.make(`child-${i}-${attempt}`),
          attempt,
          state: "completed",
          providerInstanceId: ProviderInstanceId.make("codex"),
          model: "gpt-6.1-sol",
          usageStatus: "complete",
          totalTokens: 1000,
          durationMs: 100,
          timingComplete: true,
        })),
      })),
      nodeOutcomes: Object.fromEntries(
        Array.from({ length: 150 }, (_, i) => [
          `n${i}`,
          { status: "failed" as const, attempts: 3, reason: "理由 🧪".repeat(100) },
        ]),
      ),
    };
    expect(workflowJsonBytes(next)).toBeGreaterThan(65536);
    const patches = workflowPatches(empty, next);
    expect(patches.length).toBeGreaterThan(10);
    expect(patches.filter((patch) => patch.plan !== undefined)).toHaveLength(1);
    for (const patch of patches) expect(workflowJsonBytes(patch)).toBeLessThan(32769);
    expect(patches.reduce(mergeWorkflowPatch, empty)).toEqual(next);
    expect(workflowPatches(next, next)).toEqual([]);
    const withModel = {
      ...next,
      agents: [{ ...next.agents[0]!, model: "old model" }, ...next.agents.slice(1)],
    };
    const clearedModel = { ...withModel, agents: [...next.agents] };
    expect(
      workflowPatches(withModel, clearedModel).reduce(mergeWorkflowPatch, withModel).agents[0]
        ?.model,
    ).toBeUndefined();
  });
  it("rejects missing and out-of-order updates, ignores duplicates, and accepts legacy bases", () => {
    const update = {
      id: NodeId.make("workflow"),
      previousRevision: 0,
      revision: 1,
      patch: { kind: "patch" as const, name: "First" },
      updatedAt: DateTime.makeUnsafe(10),
    };
    expect(() => applyWorkflowUpdate(undefined, update)).toThrow("initial snapshot");
    expect(() =>
      applyWorkflowUpdate(task(), { ...update, previousRevision: 1, revision: 2 }),
    ).toThrow("revision gap");
    const first = applyWorkflowUpdate(task(), update);
    expect(applyWorkflowUpdate(first, update)).toBe(first);
    expect(first.prompt).toBe("retained script");
    const second = applyWorkflowUpdate(first, {
      ...update,
      previousRevision: 1,
      revision: 2,
      status: "completed",
      result: "Done",
    });
    expect(second).toMatchObject({
      status: "completed",
      result: "Done",
      workflow: { revision: 2, name: "First" },
    });
    expect(applyWorkflowUpdate(second, update)).toBe(second);
  });
  it("refuses changed plans, duplicate members, and an unsplittable oversized member", () => {
    const plan = { nodes: [{ key: "a", label: "A", wave: 0, dependsOn: [] }] };
    expect(() =>
      mergeWorkflowPatch({ ...empty, plan }, { kind: "patch", plan: { nodes: [] } }),
    ).toThrow("immutable");
    expect(() => workflowPatches({ ...empty, plan }, { ...empty, plan: { nodes: [] } })).toThrow(
      "immutable",
    );
    const agent = { index: 0, label: "A", state: "queued" as const };
    expect(() => mergeWorkflowPatch(empty, { kind: "patch", agents: [agent, agent] })).toThrow(
      "Duplicate",
    );
    expect(() =>
      workflowPatches(empty, { ...empty, agents: [{ ...agent, result: "🧪".repeat(20000) }] }),
    ).toThrow("32 KiB");
  });
});

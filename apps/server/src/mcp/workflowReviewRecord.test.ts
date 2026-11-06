import {
  WORKFLOW_REVIEW_MAX_BLOCKERS,
  WORKFLOW_REVIEW_MAX_DEPENDENCIES,
  WORKFLOW_REVIEW_MAX_TASKS,
  WORKFLOW_REVIEW_MAX_TEXT_LENGTH,
  OrchestrationV2WorkflowReviewRecord,
  ProviderInstanceId,
  type OrchestratorMcpGraphReviewResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { parseGraph } from "./workflowGraph.ts";
import { workflowReviewRecord } from "./workflowReviewRecord.ts";

const P1 = ProviderInstanceId.make("p1");
const P2 = ProviderInstanceId.make("p2");
const DIGEST = `sha256:${"ab".repeat(32)}`;
const decodeRecord = Schema.decodeUnknownSync(OrchestrationV2WorkflowReviewRecord);

const result = (
  overrides: Partial<OrchestratorMcpGraphReviewResult> = {},
): OrchestratorMcpGraphReviewResult => ({
  reviewId: "review-1",
  approvalRequired: true,
  digest: DIGEST,
  ready: true,
  expandedGraph: null,
  targets: [],
  layers: [],
  writeConflicts: [],
  inputs: [],
  blockers: [],
  ...overrides,
});

const graphOf = (value: unknown) => {
  const parsed = parseGraph(value);
  if (!parsed.ok) throw new Error(parsed.problems.join("; "));
  return parsed.graph;
};

const node = (dependsOn: ReadonlyArray<string> = [], extra: object = {}) => ({
  subject: "Do the work",
  description: "A long description the record never carries. ".repeat(100),
  dependsOn,
  ...extra,
});

describe("workflowReviewRecord", () => {
  it("lists tasks in step order with worker, retries, judge, check and what each waits for", () => {
    const graph = graphOf({
      schemaVersion: 1,
      name: "  Fix it  ",
      nodes: {
        b: node(["a"], { verify: { type: "judgment", rubric: ["It works"] } }),
        a: node([], { verify: { type: "process", argv: ["node", "check.mjs"] } }),
      },
    });
    const record = workflowReviewRecord(
      result({
        layers: [["a"], ["b"]],
        targets: [
          {
            nodeId: "a",
            source: "target",
            target: { providerInstanceId: P1, model: "m1" },
            retries: [{ providerInstanceId: P2, model: "m4" }],
          },
          {
            nodeId: "b",
            source: "target",
            target: { providerInstanceId: P1, model: "m2" },
            judgmentTarget: { providerInstanceId: P2, model: "m3" },
          },
        ],
        writeConflicts: [{ nodes: ["a", "b"], paths: ["x"] }],
      }),
      graph,
    );
    expect(record).toMatchObject({
      type: "workflow_review",
      reviewId: "review-1",
      digest: DIGEST,
      ready: true,
      approvalRequired: true,
      name: "Fix it",
      taskCount: 2,
      writeConflictCount: 1,
      tasks: [
        {
          key: "a",
          label: "Do the work",
          wave: 0,
          dependsOn: [],
          worker: { providerInstanceId: "p1", model: "m1" },
          retries: [{ providerInstanceId: "p2", model: "m4" }],
          check: "process",
        },
        {
          key: "b",
          wave: 1,
          dependsOn: ["a"],
          worker: { providerInstanceId: "p1", model: "m2" },
          judge: { providerInstanceId: "p2", model: "m3" },
          check: "judgment",
        },
      ],
    });
    // A task that declares no retries carries none.
    expect(record.tasks[1]).not.toHaveProperty("retries");
    // Descriptions, prompts and inputs never reach the record.
    expect(JSON.stringify(record)).not.toContain("A long description");
  });

  it("carries each target's effort under any driver's option id, and old records still decode", () => {
    const graph = graphOf({
      schemaVersion: 1,
      nodes: { a: node([], { verify: { type: "judgment", rubric: ["It works"] } }) },
    });
    const effort = (id: string, value: string) => [{ id, value }];
    const record = workflowReviewRecord(
      result({
        layers: [["a"]],
        targets: [
          {
            nodeId: "a",
            source: "target",
            target: { providerInstanceId: P1, model: "m1", options: effort("effort", "medium") },
            retries: [
              { providerInstanceId: P1, model: "m1", options: effort("reasoningEffort", "high") },
              { providerInstanceId: P2, model: "m2", options: effort("variant", "xhigh") },
            ],
            judgmentTarget: {
              providerInstanceId: P2,
              model: "m3",
              options: [...effort("effort", "low"), { id: "fastMode", value: true }],
            },
          },
        ],
      }),
      graph,
    );
    expect(record.tasks[0]).toMatchObject({
      worker: { providerInstanceId: "p1", model: "m1", effort: "medium" },
      // An effort-only ladder keeps the model and says the effort of each attempt.
      retries: [
        { providerInstanceId: "p1", model: "m1", effort: "high" },
        { providerInstanceId: "p2", model: "m2", effort: "xhigh" },
      ],
      judge: { providerInstanceId: "p2", model: "m3", effort: "low" },
    });
    expect(decodeRecord(record).tasks[0]?.worker?.effort).toBe("medium");
    // A record written before efforts were carried decodes with none.
    const older = {
      ...record,
      tasks: [{ key: "a", label: "a", wave: 0, dependsOn: [], worker: { model: "m1" } }],
    };
    expect(decodeRecord(older).tasks[0]?.worker).toEqual({ model: "m1" });
  });

  it("is bounded however large the graph is, and counts what it leaves out", () => {
    const keys = Array.from({ length: 300 }, (_, index) => `t${index}`);
    const graph = graphOf({
      schemaVersion: 1,
      nodes: {
        ...Object.fromEntries(keys.map((key) => [key, node()])),
        sink: node(keys, { subject: "x".repeat(5_000) }),
      },
    });
    const record = workflowReviewRecord(
      result({
        layers: [keys, ["sink"]],
        blockers: Array.from({ length: 30 }, (_, index) => `blocker ${index} ${"y".repeat(2_000)}`),
      }),
      graph,
    );
    expect(record.taskCount).toBe(301);
    expect(record.tasks).toHaveLength(WORKFLOW_REVIEW_MAX_TASKS);
    expect(record.blockers).toHaveLength(WORKFLOW_REVIEW_MAX_BLOCKERS);
    expect(record.blockersMore).toBe(30 - WORKFLOW_REVIEW_MAX_BLOCKERS);
    for (const text of record.blockers) {
      expect(text.length).toBeLessThanOrEqual(WORKFLOW_REVIEW_MAX_TEXT_LENGTH);
    }
    expect(JSON.stringify(record).length).toBeLessThan(80_000);
    // A task past the cap that waits on 300 others is cut the same way.
    const wide = workflowReviewRecord(result({ layers: [keys, ["sink"]] }), graph);
    expect(wide.tasks.find((task) => task.key === "sink")).toBeUndefined();
    const narrow = graphOf({
      schemaVersion: 1,
      nodes: {
        ...Object.fromEntries(keys.slice(0, 40).map((key) => [key, node()])),
        sink: node(keys.slice(0, 40), { subject: "z".repeat(5_000) }),
      },
    });
    const sink = workflowReviewRecord(
      result({ layers: [keys.slice(0, 40), ["sink"]] }),
      narrow,
    ).tasks.at(-1)!;
    expect(sink.key).toBe("sink");
    expect(sink.dependsOn).toHaveLength(WORKFLOW_REVIEW_MAX_DEPENDENCIES);
    expect(sink.dependsOnMore).toBe(40 - WORKFLOW_REVIEW_MAX_DEPENDENCIES);
    expect(sink.label.length).toBe(WORKFLOW_REVIEW_MAX_TEXT_LENGTH);
  });

  it("keeps the id and blockers of a review that cannot be digested, and lists its tasks by id", () => {
    const record = workflowReviewRecord(
      result({ digest: null, ready: false, blockers: ["a has a cycle"], layers: [["a"]] }),
      undefined,
    );
    expect(record).toMatchObject({
      reviewId: "review-1",
      digest: null,
      ready: false,
      blockers: ["a has a cycle"],
      name: null,
      taskCount: 1,
      tasks: [{ key: "a", label: "a", wave: 0, dependsOn: [] }],
    });
    expect(workflowReviewRecord(result({ digest: "sha256:short" }), undefined).digest).toBeNull();
  });
});

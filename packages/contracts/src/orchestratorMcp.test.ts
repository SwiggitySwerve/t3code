import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpGraphReviewInput,
  OrchestratorMcpGraphReviewResult,
  OrchestratorMcpGraphStartInput,
  OrchestratorMcpWorkflowStartInput,
} from "./orchestratorMcp.ts";

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);
const decodeGraphReviewInput = Schema.decodeUnknownSync(OrchestratorMcpGraphReviewInput);
const decodeGraphReviewResult = Schema.decodeUnknownSync(OrchestratorMcpGraphReviewResult);
const decodeGraphStartInput = Schema.decodeUnknownSync(OrchestratorMcpGraphStartInput);
const decodeWorkflowStartInput = Schema.decodeUnknownSync(OrchestratorMcpWorkflowStartInput);

describe("orchestrator MCP contracts", () => {
  it("decodes worker defaults consistently on scripts, graph review and graph start", () => {
    for (const options of [{ reasoningEffort: "high" }, [], {}]) {
      const workerTarget = { model: "sol", options };
      const expected = {
        model: "sol",
        options: Array.isArray(options)
          ? options
          : Object.entries(options).map(([id, value]) => ({ id, value })),
      };
      expect(
        decodeWorkflowStartInput({
          script: "return 1",
          workerTarget,
        }).workerTarget,
      ).toEqual(expected);
      expect(decodeGraphReviewInput({ graph: {}, workerTarget }).workerTarget).toEqual(expected);
      expect(
        decodeGraphStartInput({
          graph: {},
          workerTarget,
          acceptedDigest: `sha256:${"a".repeat(64)}`,
        }).workerTarget,
      ).toEqual(expected);
    }
  });
  it("leaves graph validation to the server while requiring a review digest to start", () => {
    const graph = { schemaVersion: 999, nodes: { invalid: { unknownField: true } } };
    const acceptedDigest = `sha256:${"a".repeat(64)}`;

    expect(decodeGraphReviewInput({ graph })).toEqual({
      graph,
    });
    expect(
      decodeGraphStartInput({
        graph,
        acceptedDigest,
        budgetTokens: 100,
        title: "Graph",
        clientRequestId: "g1",
      }),
    ).toEqual({ graph, acceptedDigest, budgetTokens: 100, title: "Graph", clientRequestId: "g1" });
    for (const digest of [
      undefined,
      "",
      "a".repeat(64),
      `sha256:${"A".repeat(64)}`,
      `sha256:${"a".repeat(63)}`,
    ]) {
      expect(() => decodeGraphStartInput({ graph, acceptedDigest: digest })).toThrow();
    }
    for (const budgetTokens of [0, -1, 1.5]) {
      expect(() => decodeGraphStartInput({ graph, acceptedDigest, budgetTokens })).toThrow();
    }
  });

  it("preserves graph review blockers and partial input facts", () => {
    const review = {
      digest: `sha256:${"a".repeat(64)}`,
      ready: false,
      targets: [],
      layers: [["first", "second"], ["last"]],
      writeConflicts: [{ nodes: ["first", "second"], paths: ["src/shared.ts"] }],
      inputs: [
        { path: "input.txt", status: "found", sha256: "a".repeat(64), sizeBytes: 12 },
        { path: "missing.txt", status: "missing", sha256: null, sizeBytes: null },
        { path: "large.txt", status: "too_large", sha256: null, sizeBytes: 1_000_000 },
      ],
      blockers: ["Missing workspace input"],
    };
    expect(decodeGraphReviewResult(review)).toEqual(review);
    expect(() =>
      decodeGraphReviewResult({ ...review, inputs: [{ ...review.inputs[0], status: "unknown" }] }),
    ).toThrow();
  });

  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});

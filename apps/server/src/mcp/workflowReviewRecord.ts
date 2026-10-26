/**
 * The approval record of a `graph_review`: the compact plan a client decides from, taken from the
 * review the server produced. It is the only thing a client reads to approve or dismiss, so it is
 * built here, once, and bounded here: it never depends on how large the full review result is.
 */
import {
  OrchestrationV2WorkflowReviewDigest,
  WORKFLOW_REVIEW_MAX_BLOCKERS,
  WORKFLOW_REVIEW_MAX_DEPENDENCIES,
  WORKFLOW_REVIEW_MAX_TASKS,
  WORKFLOW_REVIEW_MAX_TEXT_LENGTH,
  type OrchestrationV2WorkflowReviewRecord,
  type OrchestrationV2WorkflowReviewTarget,
  type OrchestratorMcpGraphReviewResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { graphPlan, type WorkflowGraph } from "./workflowGraph.ts";

const isDigest = Schema.is(OrchestrationV2WorkflowReviewDigest);

function clip(text: string): string {
  return text.length <= WORKFLOW_REVIEW_MAX_TEXT_LENGTH
    ? text
    : `${text.slice(0, WORKFLOW_REVIEW_MAX_TEXT_LENGTH - 1)}\u2026`;
}

function targetOf(
  target:
    | { readonly providerInstanceId?: string | undefined; readonly model?: string | undefined }
    | undefined,
): OrchestrationV2WorkflowReviewTarget | undefined {
  if (target === undefined) return undefined;
  const { providerInstanceId, model } = target;
  if (providerInstanceId === undefined && model === undefined) return undefined;
  return {
    ...(providerInstanceId === undefined ? {} : { providerInstanceId }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * `result` is what the server returns to the agent; `graph` is the parsed graph it reviewed, absent
 * when the graph did not parse (the record then lists the tasks the review's layers name).
 */
export function workflowReviewRecord(
  result: Pick<
    OrchestratorMcpGraphReviewResult,
    | "reviewId"
    | "approvalRequired"
    | "digest"
    | "ready"
    | "blockers"
    | "targets"
    | "layers"
    | "writeConflicts"
    | "advisory"
  >,
  graph: WorkflowGraph | undefined,
): OrchestrationV2WorkflowReviewRecord {
  const targets = new Map(result.targets.map((entry) => [entry.nodeId, entry]));
  const planned =
    graph === undefined
      ? result.layers.flatMap((layer, wave) =>
          layer.map((key) => ({ key, label: key, wave, dependsOn: [] as ReadonlyArray<string> })),
        )
      : graphPlan(graph).nodes;
  const tasks = planned.slice(0, WORKFLOW_REVIEW_MAX_TASKS).map((node) => {
    const entry = targets.get(node.key);
    const worker = targetOf(entry?.target);
    const judge = targetOf(entry?.judgmentTarget);
    const check = graph?.nodes[node.key]?.verify?.type;
    const dependsOnMore = node.dependsOn.length - WORKFLOW_REVIEW_MAX_DEPENDENCIES;
    return {
      key: node.key,
      label: clip(node.label.trim() === "" ? node.key : node.label),
      wave: node.wave,
      dependsOn: node.dependsOn.slice(0, WORKFLOW_REVIEW_MAX_DEPENDENCIES),
      ...(dependsOnMore > 0 ? { dependsOnMore } : {}),
      ...(worker === undefined ? {} : { worker }),
      ...(judge === undefined ? {} : { judge }),
      ...(check === undefined ? {} : { check }),
    };
  });
  const name = graph?.name?.trim() ?? "";
  const blockersMore = result.blockers.length - WORKFLOW_REVIEW_MAX_BLOCKERS;
  const { advisory } = result;
  return {
    type: "workflow_review",
    reviewId: result.reviewId,
    digest: result.digest !== null && isDigest(result.digest) ? result.digest : null,
    ready: result.ready,
    approvalRequired: result.approvalRequired,
    name: name === "" ? null : clip(name),
    blockers: result.blockers.slice(0, WORKFLOW_REVIEW_MAX_BLOCKERS).map(clip),
    ...(blockersMore > 0 ? { blockersMore } : {}),
    tasks,
    taskCount: planned.length,
    writeConflictCount: result.writeConflicts.length,
    ...(advisory === undefined
      ? {}
      : {
          advice: {
            fanOut: advisory.fanOut,
            reasons: advisory.reasons.slice(0, 3).map(clip),
            nodeCount: advisory.nodeCount,
            widestWave: advisory.widestWave,
            depth: advisory.depth,
            verifierCount: advisory.verifierCount,
            estimatedTokens: {
              low: advisory.estimatedTokens.low,
              high: advisory.estimatedTokens.high,
              basis: clip(advisory.estimatedTokens.basis),
            },
            suggestedBudgetTokens: advisory.suggestedBudgetTokens,
          },
        }),
  };
}

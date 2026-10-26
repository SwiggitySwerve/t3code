/**
 * The person's decision on a reviewed workflow graph, shared by every client. The review is the
 * `graph_review` result read from the stored tool item; Approve and Dismiss name it by its review
 * id and digest, and the server refuses anything it did not issue. Nothing here grants anything.
 */
import {
  OrchestrationV2WorkflowApprovalError,
  OrchestrationV2WorkflowReviewDigest,
  OrchestratorMcpGraphAdvisory,
  OrchestratorMcpGraphReviewResult,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

/** One graph node as the card lists it: what it does, what it waits for, and who runs it. */
export interface WorkflowReviewNodeView {
  readonly id: string;
  readonly subject: string;
  readonly dependsOn: ReadonlyArray<string>;
  /** Dependency layer, 0 for nodes with no dependencies. */
  readonly wave: number;
  /** The concrete provider and model the digest covers; null when the review lists none. */
  readonly worker: WorkflowReviewTargetView | null;
  /** The judge's target, when the node has a judgment check. */
  readonly judge: WorkflowReviewTargetView | null;
}

export interface WorkflowReviewTargetView {
  readonly providerInstanceId: string | null;
  readonly model: string | null;
}

/** The server's fan-out and cost advice; informational, never part of the digest. */
export interface WorkflowReviewAdviceView {
  readonly fanOut: "ok" | "consider_single";
  readonly reasons: ReadonlyArray<string>;
  readonly nodeCount: number;
  readonly widestWave: number;
  readonly depth: number;
  readonly verifierCount: number;
  readonly estimatedTokens: {
    readonly low: number;
    readonly high: number;
    /** How the server derived the figures, including which drivers are not measured. */
    readonly basis: string;
  };
  readonly suggestedBudgetTokens: number;
}

export interface WorkflowReviewView {
  readonly reviewId: string;
  /** Null when the server could not digest the graph, or the digest is not one it would issue. */
  readonly digest: string | null;
  readonly ready: boolean;
  /** True while the person's request for a workflow waits for this review's decision. */
  readonly approvalRequired: boolean;
  readonly blockers: ReadonlyArray<string>;
  readonly name: string | null;
  readonly nodes: ReadonlyArray<WorkflowReviewNodeView>;
  readonly writeConflictCount: number;
  readonly advice: WorkflowReviewAdviceView | null;
}

const GRAPH_REVIEW_TOOL = "graph_review";

const reviewFields = OrchestratorMcpGraphReviewResult.fields;
const decodeCore = Schema.decodeUnknownOption(
  Schema.Struct({
    reviewId: reviewFields.reviewId,
    approvalRequired: reviewFields.approvalRequired,
    digest: reviewFields.digest,
    ready: reviewFields.ready,
    blockers: reviewFields.blockers,
  }),
);
const decodeTargets = Schema.decodeUnknownOption(reviewFields.targets);
const decodeLayers = Schema.decodeUnknownOption(reviewFields.layers);
const decodeConflicts = Schema.decodeUnknownOption(reviewFields.writeConflicts);
const decodeAdvisory = Schema.decodeUnknownOption(OrchestratorMcpGraphAdvisory);
const isDigest = Schema.is(OrchestrationV2WorkflowReviewDigest);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Where the result can sit in a stored tool output: as is (Codex), under `structuredContent`, or as
 * the JSON text of a content block (Claude stores both). A truncated or foreign output has none.
 */
function reviewResultCandidates(output: unknown): ReadonlyArray<unknown> {
  if (typeof output === "string") return [parseJson(output)];
  if (!isRecord(output)) return [];
  const blocks = Array.isArray(output.content) ? output.content : [];
  return [
    output,
    output.structuredContent,
    ...blocks.map((block) =>
      isRecord(block) && typeof block.text === "string" ? parseJson(block.text) : undefined,
    ),
  ];
}

function readGraphNodes(expandedGraph: unknown): {
  readonly name: string | null;
  readonly nodes: ReadonlyMap<string, { subject: string; dependsOn: ReadonlyArray<string> }>;
} {
  const nodes = new Map<string, { subject: string; dependsOn: ReadonlyArray<string> }>();
  if (!isRecord(expandedGraph)) return { name: null, nodes };
  if (isRecord(expandedGraph.nodes)) {
    for (const [id, node] of Object.entries(expandedGraph.nodes)) {
      if (!isRecord(node)) continue;
      nodes.set(id, {
        subject: typeof node.subject === "string" && node.subject.trim() ? node.subject : id,
        dependsOn: Array.isArray(node.dependsOn)
          ? node.dependsOn.filter((entry): entry is string => typeof entry === "string")
          : [],
      });
    }
  }
  const name = typeof expandedGraph.name === "string" ? expandedGraph.name.trim() : "";
  return { name: name === "" ? null : name, nodes };
}

function targetView(
  target:
    | { readonly providerInstanceId?: string | undefined; readonly model?: string | undefined }
    | undefined,
): WorkflowReviewTargetView | null {
  if (target === undefined) return null;
  const providerInstanceId = target.providerInstanceId ?? null;
  const model = target.model ?? null;
  return providerInstanceId === null && model === null ? null : { providerInstanceId, model };
}

/**
 * Reads the review out of a stored `graph_review` tool output. The identity of the review (id,
 * digest, ready, approval, blockers) must decode, or this returns null and the client falls back
 * to the generic tool row. The plan details decode on their own, so one the card cannot read costs
 * only that detail, never the person's ability to decide.
 */
export function readWorkflowReviewOutput(output: unknown): WorkflowReviewView | null {
  for (const candidate of reviewResultCandidates(output)) {
    const core = decodeCore(candidate);
    if (Option.isNone(core) || !isRecord(candidate)) continue;
    const { reviewId, approvalRequired, digest, ready, blockers } = core.value;
    if (reviewId.trim() === "") continue;
    const graph = readGraphNodes(candidate.expandedGraph);
    const targets = Option.getOrElse(decodeTargets(candidate.targets), () => []);
    const layers = Option.getOrElse(decodeLayers(candidate.layers), () => []);
    const waveOf = new Map<string, number>();
    layers.forEach((layer, wave) => layer.forEach((id) => waveOf.set(id, wave)));
    const targetOf = new Map(targets.map((entry) => [entry.nodeId, entry]));
    const ids = [...new Set([...layers.flat(), ...graph.nodes.keys(), ...targetOf.keys()])];
    const advisory = Option.getOrNull(decodeAdvisory(candidate.advisory));
    return {
      reviewId,
      digest: digest !== null && isDigest(digest) ? digest : null,
      ready,
      approvalRequired,
      blockers,
      name: graph.name,
      nodes: ids.map((id) => {
        const node = graph.nodes.get(id);
        const entry = targetOf.get(id);
        return {
          id,
          subject: node?.subject ?? id,
          dependsOn: node?.dependsOn ?? [],
          wave: waveOf.get(id) ?? 0,
          worker: targetView(entry?.target),
          judge: targetView(entry?.judgmentTarget),
        };
      }),
      writeConflictCount: Option.getOrElse(decodeConflicts(candidate.writeConflicts), () => [])
        .length,
      advice:
        advisory === null
          ? null
          : {
              fanOut: advisory.fanOut,
              reasons: advisory.reasons,
              nodeCount: advisory.nodeCount,
              widestWave: advisory.widestWave,
              depth: advisory.depth,
              verifierCount: advisory.verifierCount,
              estimatedTokens: {
                low: advisory.estimatedTokens.low,
                high: advisory.estimatedTokens.high,
                basis: advisory.estimatedTokens.basis,
              },
              suggestedBudgetTokens: advisory.suggestedBudgetTokens,
            },
    };
  }
  return null;
}

/** Whether a turn item is the coordinator's `graph_review` call, whatever server prefix it carries. */
export function isWorkflowReviewItem(
  item: Pick<OrchestrationV2TurnItem, "type"> & { readonly toolName?: string | null | undefined },
): boolean {
  return item.type === "dynamic_tool" && resolveT3McpToolId(item.toolName) === GRAPH_REVIEW_TOOL;
}

/**
 * The review a person can still decide: the newest `graph_review` of the thread. An older one was
 * replaced by it, so only the newest offers buttons.
 */
export function latestWorkflowReviewItemId(
  items: ReadonlyArray<
    Pick<OrchestrationV2TurnItem, "id" | "type" | "startedAt" | "updatedAt"> & {
      readonly toolName?: string | null | undefined;
    }
  >,
): string | null {
  let latest: { readonly id: string; readonly at: number } | null = null;
  for (const item of items) {
    if (!isWorkflowReviewItem(item)) continue;
    const at = DateTime.toEpochMillis(item.startedAt ?? item.updatedAt);
    if (latest === null || at >= latest.at) latest = { id: item.id, at };
  }
  return latest === null ? null : latest.id;
}

export type WorkflowReviewAction = "approve" | "dismiss";

/** What this client has done with one review. Kept per review, so a remounted card still knows. */
export type WorkflowReviewDecision =
  | { readonly _tag: "idle" }
  | { readonly _tag: "pending"; readonly action: WorkflowReviewAction }
  | { readonly _tag: "settled"; readonly action: WorkflowReviewAction }
  | {
      readonly _tag: "failed";
      readonly action: WorkflowReviewAction;
      /**
       * "stale": the server no longer has this review waiting, so it refuses both buttons.
       * "blocked": it has blockers, so it refuses Approve. "retry": nothing says it will refuse.
       */
      readonly kind: "stale" | "blocked" | "retry";
      readonly message: string;
    };

const IDLE: WorkflowReviewDecision = { _tag: "idle" };

export function workflowReviewDecisionKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  reviewId: string,
): string {
  return `${environmentId}:${threadId}:${reviewId}`;
}

export const workflowReviewDecisionAtom = Atom.family((_key: string) =>
  Atom.make<WorkflowReviewDecision>(IDLE).pipe(Atom.keepAlive),
);

const isApprovalError = Schema.is(OrchestrationV2WorkflowApprovalError);

function failedDecision(
  action: WorkflowReviewAction,
  failure: unknown,
): Extract<WorkflowReviewDecision, { _tag: "failed" }> {
  if (isApprovalError(failure)) {
    const kind =
      failure.reason === "review-blocked"
        ? "blocked"
        : failure.reason === "review-not-found" || failure.reason === "no-pending-request"
          ? "stale"
          : "retry";
    return { _tag: "failed", action, kind, message: failure.message };
  }
  return {
    _tag: "failed",
    action,
    kind: "retry",
    message: "Could not send your decision. Try again.",
  };
}

/**
 * Sends one decision. A second call while one is open, or after the review was settled, does
 * nothing: the check and the move to "pending" happen in one step, before any render, so a double
 * click sends one request. A failed decision may be tried again unless the server said it will
 * refuse it: any decision on a review it no longer waits for, Approve on one with blockers.
 */
export async function runWorkflowReviewDecision(
  registry: AtomRegistry.AtomRegistry,
  input: {
    readonly key: string;
    readonly action: WorkflowReviewAction;
    readonly send: () => Promise<AtomCommandResult<void, unknown>>;
  },
): Promise<void> {
  const atom = workflowReviewDecisionAtom(input.key);
  const current = registry.get(atom);
  if (current._tag === "pending" || current._tag === "settled") return;
  if (current._tag === "failed" && current.kind === "stale") return;
  if (current._tag === "failed" && current.kind === "blocked" && input.action === "approve") return;
  registry.set(atom, { _tag: "pending", action: input.action });
  const result = await input.send();
  registry.set(
    atom,
    result._tag === "Success"
      ? { _tag: "settled", action: input.action }
      : isAtomCommandInterrupted(result)
        ? IDLE
        : failedDecision(input.action, squashAtomCommandFailure(result)),
  );
}

export type WorkflowReviewStatus =
  | "ready"
  | "blocked"
  | "approving"
  | "dismissing"
  | "approved"
  | "dismissed"
  | "stale"
  | "superseded"
  | "info"
  | "read-only";

interface WorkflowReviewButton {
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly label: string;
}

export interface WorkflowReviewPresentation {
  readonly status: WorkflowReviewStatus;
  readonly statusLabel: string;
  readonly note: { readonly tone: "info" | "warning" | "error"; readonly text: string } | null;
  readonly approve: WorkflowReviewButton;
  readonly dismiss: WorkflowReviewButton;
}

const NO_BUTTONS = {
  approve: { visible: false, enabled: false, label: "Approve & run" },
  dismiss: { visible: false, enabled: false, label: "Dismiss" },
} as const;

/**
 * What the card says and which buttons it offers, from the review, this client's decision, whether
 * the person may decide here, and whether a newer review replaced this one. Approve needs a ready
 * review with a digest; Dismiss needs only a review the server knows, because a review that could
 * not be digested still has to be dismissable.
 */
export function presentWorkflowReview(input: {
  readonly review: WorkflowReviewView;
  readonly decision: WorkflowReviewDecision;
  readonly canDecide: boolean;
  readonly superseded: boolean;
}): WorkflowReviewPresentation {
  const { review, decision } = input;
  if (decision._tag === "settled") {
    return decision.action === "approve"
      ? {
          status: "approved",
          statusLabel: "Approved",
          note: { tone: "info", text: "Approved. The agent is starting this workflow." },
          ...NO_BUTTONS,
        }
      : {
          status: "dismissed",
          statusLabel: "Dismissed",
          note: {
            tone: "info",
            text: "Dismissed. The agent will not start a workflow for this request.",
          },
          ...NO_BUTTONS,
        };
  }
  if (decision._tag === "failed" && decision.kind === "stale") {
    return {
      status: "stale",
      statusLabel: "Out of date",
      note: { tone: "error", text: decision.message },
      ...NO_BUTTONS,
    };
  }
  if (decision._tag === "pending") {
    const approving = decision.action === "approve";
    return {
      status: approving ? "approving" : "dismissing",
      statusLabel: approving ? "Approving\u2026" : "Dismissing\u2026",
      note: null,
      approve: {
        visible: true,
        enabled: false,
        label: approving ? "Approving\u2026" : "Approve & run",
      },
      dismiss: { visible: true, enabled: false, label: approving ? "Dismiss" : "Dismissing\u2026" },
    };
  }
  if (input.superseded) {
    return {
      status: "superseded",
      statusLabel: "Replaced",
      note: { tone: "info", text: "The agent made a newer review; decide on that one." },
      ...NO_BUTTONS,
    };
  }
  if (!review.approvalRequired) {
    return { status: "info", statusLabel: "Reviewed", note: null, ...NO_BUTTONS };
  }
  if (!input.canDecide) {
    return {
      status: "read-only",
      statusLabel: "Waiting for approval",
      note: { tone: "info", text: "You cannot approve workflows in this environment." },
      ...NO_BUTTONS,
    };
  }
  const failure =
    decision._tag === "failed" ? { tone: "error" as const, text: decision.message } : null;
  const approvable =
    review.ready &&
    review.digest !== null &&
    !(decision._tag === "failed" && decision.kind === "blocked");
  return {
    status: approvable ? "ready" : "blocked",
    statusLabel: approvable ? "Waiting for your approval" : "Blocked",
    note:
      failure ??
      (approvable
        ? null
        : { tone: "warning", text: "This review has blockers, so it cannot be approved." }),
    approve: { visible: true, enabled: approvable, label: "Approve & run" },
    dismiss: { visible: true, enabled: true, label: "Dismiss" },
  };
}

/**
 * The provider and model a task will run on, in the person's words: the provider's display name
 * and the model's name when the catalog lists them, else the ids the review carries.
 */
export function workflowReviewTargetLabel(
  target: WorkflowReviewTargetView | null,
  providers:
    | ReadonlyArray<Pick<ServerProvider, "instanceId" | "displayName" | "models">>
    | undefined,
): string {
  if (target === null) return "Provider and model not listed";
  const provider = providers?.find((entry) => entry.instanceId === target.providerInstanceId);
  const providerName = provider?.displayName ?? target.providerInstanceId;
  const modelName =
    provider?.models.find((entry) => entry.slug === target.model)?.name ?? target.model;
  return [providerName, modelName].filter((part): part is string => part !== null).join(" \u00b7 ");
}

export interface WorkflowReviewSummary {
  /** "4 tasks in 3 steps". */
  readonly shape: string;
  /** The server's token estimate and suggested budget, in words; null when it gave no advice. */
  readonly cost: string | null;
  /** How the estimate was made, for a line of small print. */
  readonly costBasis: string | null;
  /** Why one agent might do the work for less (at most three); empty when fan-out is fine. */
  readonly fanOutReasons: ReadonlyArray<string>;
  /** Tasks that write the same paths, which the card says before the person approves. */
  readonly writeConflicts: string | null;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The numbers above the task list, in words. Both clients show these lines as given. */
export function workflowReviewSummary(review: WorkflowReviewView): WorkflowReviewSummary {
  const steps = review.nodes.reduce((deepest, node) => Math.max(deepest, node.wave + 1), 0);
  const { advice } = review;
  return {
    shape: `${plural(review.nodes.length, "task")} in ${plural(steps, "step")}`,
    cost:
      advice === null
        ? null
        : `About ${formatTokens(advice.estimatedTokens.low)} to ${formatTokens(advice.estimatedTokens.high)} tokens, your agent included. Suggested budget ${formatTokens(advice.suggestedBudgetTokens)}.`,
    costBasis: advice === null ? null : advice.estimatedTokens.basis,
    fanOutReasons: advice?.fanOut === "consider_single" ? advice.reasons : [],
    writeConflicts:
      review.writeConflictCount === 0
        ? null
        : `${plural(review.writeConflictCount, "group")} of tasks write the same paths.`,
  };
}

/** The review's tasks grouped by dependency layer, in layer order: what the card lists as steps. */
export function workflowReviewSteps(
  review: WorkflowReviewView,
): ReadonlyArray<{ readonly step: number; readonly nodes: ReadonlyArray<WorkflowReviewNodeView> }> {
  const steps = new Map<number, Array<WorkflowReviewNodeView>>();
  for (const node of review.nodes) {
    const nodes = steps.get(node.wave) ?? [];
    nodes.push(node);
    steps.set(node.wave, nodes);
  }
  return [...steps]
    .sort(([left], [right]) => left - right)
    .map(([wave, nodes]) => ({ step: wave + 1, nodes }));
}

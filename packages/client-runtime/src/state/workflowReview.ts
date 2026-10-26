/**
 * The person's decision on a reviewed workflow graph, for every client. It reads the typed
 * `workflow_review` record the server writes, never the `graph_review` tool output. Approve and
 * Dismiss name the record's id and digest; the server refuses any it did not issue.
 */
import {
  OrchestrationV2WorkflowApprovalError,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type OrchestrationV2WorkflowReviewRecord,
  type OrchestrationV2WorkflowReviewTarget,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

type WorkflowReviewItem = Extract<OrchestrationV2TurnItem, { readonly type: "workflow_review" }>;

/** One task as the card lists it: what it does, what it waits for, and who runs it. */
export interface WorkflowReviewNodeView {
  readonly id: string;
  readonly subject: string;
  readonly dependsOn: ReadonlyArray<string>;
  /** Dependencies the record lists no further. */
  readonly dependsOnMore: number;
  /** Dependency step, 0 for tasks with no dependencies. */
  readonly wave: number;
  /** The concrete provider and model the digest covers; null when the review lists none. */
  readonly worker: WorkflowReviewTargetView | null;
  /** The judge's target, when the task has a judgment check. */
  readonly judge: WorkflowReviewTargetView | null;
  /** How the task's result is checked, when it is. */
  readonly check: "process" | "structured" | "judgment" | null;
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
  /** Null when the server could not digest the graph. */
  readonly digest: string | null;
  readonly ready: boolean;
  /** True while the person's request for a workflow waits for this review's decision. */
  readonly approvalRequired: boolean;
  readonly blockers: ReadonlyArray<string>;
  /** Blockers the record lists no further. */
  readonly blockersMore: number;
  readonly name: string | null;
  readonly nodes: ReadonlyArray<WorkflowReviewNodeView>;
  /** Tasks in the reviewed graph, listed or not. */
  readonly taskCount: number;
  readonly writeConflictCount: number;
  readonly advice: WorkflowReviewAdviceView | null;
}

const WORKFLOW_REVIEW_ITEM = "workflow_review";

/** Whether a turn item is a review record, the one a person approves or dismisses from. */
export function isWorkflowReviewItem(
  item: Pick<OrchestrationV2TurnItem, "type">,
): item is WorkflowReviewItem {
  return item.type === WORKFLOW_REVIEW_ITEM;
}

/** A projected turn item known to be a review record. */
export type ProjectedWorkflowReviewItem = OrchestrationV2ProjectedTurnItem & {
  readonly item: WorkflowReviewItem;
};

export function isProjectedWorkflowReview(
  row: OrchestrationV2ProjectedTurnItem,
): row is ProjectedWorkflowReviewItem {
  return isWorkflowReviewItem(row.item);
}

function targetView(
  target: OrchestrationV2WorkflowReviewTarget | undefined,
): WorkflowReviewTargetView | null {
  if (target === undefined) return null;
  const providerInstanceId = target.providerInstanceId ?? null;
  const model = target.model ?? null;
  return providerInstanceId === null && model === null ? null : { providerInstanceId, model };
}

/** The review a record carries, in the shape the cards draw. The record is already typed and bounded. */
export function workflowReviewOf(item: OrchestrationV2WorkflowReviewRecord): WorkflowReviewView {
  return {
    reviewId: item.reviewId,
    digest: item.digest,
    ready: item.ready,
    approvalRequired: item.approvalRequired,
    blockers: item.blockers,
    blockersMore: item.blockersMore ?? 0,
    name: item.name,
    nodes: item.tasks.map((task) => ({
      id: task.key,
      subject: task.label,
      dependsOn: task.dependsOn,
      dependsOnMore: task.dependsOnMore ?? 0,
      wave: task.wave,
      worker: targetView(task.worker),
      judge: targetView(task.judge),
      check: task.check ?? null,
    })),
    taskCount: item.taskCount,
    writeConflictCount: item.writeConflictCount,
    advice:
      item.advice === undefined
        ? null
        : {
            fanOut: item.advice.fanOut,
            reasons: item.advice.reasons,
            nodeCount: item.advice.nodeCount,
            widestWave: item.advice.widestWave,
            depth: item.advice.depth,
            verifierCount: item.advice.verifierCount,
            estimatedTokens: item.advice.estimatedTokens,
            suggestedBudgetTokens: item.advice.suggestedBudgetTokens,
          },
  };
}

/**
 * The review a person can still decide: the newest review record of the thread. An older one was
 * replaced by it, so only the newest offers buttons.
 */
export function latestWorkflowReviewItemId(
  items: ReadonlyArray<Pick<OrchestrationV2TurnItem, "id" | "type" | "startedAt" | "updatedAt">>,
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
  /** False for a review this thread inherited from the one it was forked from: shown, not decidable. */
  readonly local: boolean;
}): WorkflowReviewPresentation {
  const { review, decision } = input;
  if (!input.local) {
    return { status: "info", statusLabel: "Reviewed", note: null, ...NO_BUTTONS };
  }
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

/** The two lines under a task's name: who runs it and how it is checked, and what it waits for. */
export function workflowReviewNodeLines(
  node: WorkflowReviewNodeView,
  providers: Parameters<typeof workflowReviewTargetLabel>[1],
): { readonly runs: string; readonly after: string | null } {
  const worker = workflowReviewTargetLabel(node.worker, providers);
  const checkedBy =
    node.check === "judgment"
      ? `checked by ${node.judge === null ? "a judge" : workflowReviewTargetLabel(node.judge, providers)}`
      : node.check === "process"
        ? "checked by a command"
        : node.check === "structured"
          ? "checked against its output"
          : null;
  const waits = [
    ...node.dependsOn,
    ...(node.dependsOnMore > 0 ? [`${node.dependsOnMore} more`] : []),
  ];
  return {
    runs: checkedBy === null ? worker : `${worker} \u00b7 ${checkedBy}`,
    after: waits.length === 0 ? null : `After ${waits.join(", ")}`,
  };
}

export interface WorkflowReviewSummary {
  /** "4 tasks in 3 steps". */
  readonly shape: string;
  /** Said under the task list when the record lists fewer tasks than the graph has. */
  readonly moreTasks: string | null;
  /** Likewise for blockers the record does not list. */
  readonly moreBlockers: string | null;
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
  const { advice } = review;
  // The server's depth counts every task, listed or not.
  const steps =
    advice?.depth ?? review.nodes.reduce((deepest, node) => Math.max(deepest, node.wave + 1), 0);
  const unlisted = Math.max(0, review.taskCount - review.nodes.length);
  return {
    shape: `${plural(review.taskCount, "task")} in ${plural(steps, "step")}`,
    moreTasks: unlisted === 0 ? null : `${plural(unlisted, "more task")} not listed here.`,
    moreBlockers:
      review.blockersMore === 0
        ? null
        : `${plural(review.blockersMore, "more blocker")} not listed.`,
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

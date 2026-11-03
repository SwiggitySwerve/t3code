/**
 * Per-turn hooks for `workflowStart`, the one owner of whether a person's message starts a
 * workflow: a request gets graph planning, and under "always" every other person's turn gets the
 * every-turn note. graph_start and workflow_start wait for approval (`WorkflowApprovalGate.ts`).
 */
import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { WorkflowStartMode, WorkflowTriggers } from "@t3tools/contracts/settings";
import { detectWorkflowIntent } from "@t3tools/shared/workflowIntent";

import { isPersonTypedMessage } from "./personMessage.ts";

/**
 * How the coordinator assigns agents, shared by both notes. These lines are prompt tokens on
 * every workflow turn, so they stay short.
 */
const ASSIGNMENT_RULES = [
  "You choose every worker's and every check's target: providerInstanceId, model and options such as effort, from orchestrator_capabilities. Never invent ids.",
  "Give each agent the smallest model and effort you expect to succeed first time (pass its check, if it has one), and more to ambiguous, multi-file or previously failed work. Prefer lowering effort to switching to a much weaker model.",
  "Split work you cannot scope into smaller agents; for a part too large to scope, run a planning agent on a stronger model first.",
  "Check work with verify: { type: 'process', argv }, or { type: 'judgment', rubric, target } on a different model family than its worker when one is enabled.",
  "Give an agent with a check that can fail it retries: later targets, cheapest first, then more effort or model. Redo it only once they run out or the split was wrong. listPrice is the provider's published price, not what this account pays; null is unknown, not free.",
];

const WORKFLOW_TURN_NOTE = [
  "<t3-workflow>",
  "The user asked for a workflow, so plan it before anything runs.",
  "1. Split the work into graph nodes with dependencies, add a verify check to any node whose result needs checking, and call graph_review.",
  ...ASSIGNMENT_RULES.map((rule, index) => `${index + 2}. ${rule}`),
  `${ASSIGNMENT_RULES.length + 2}. When graph_review returns approvalRequired: true, end your turn. The user approves it in T3 Code, which then sends you a message with the approved digest: do not call graph_start or workflow_start before that message. When it returns false, call graph_start.`,
  "</t3-workflow>",
].join("\n");

/** The plan-first note for a turn that asks for a workflow; one text for every driver. */
export function workflowTurnNote(): string {
  return WORKFLOW_TURN_NOTE;
}

const CLAUDE_DRIVER = "claudeAgent";

/**
 * Claude Code's own trigger for its native multi-agent orchestration. Only a Claude turn gets
 * it, in place of the every-turn note; the stored message never shows it.
 */
export const CLAUDE_NATIVE_ORCHESTRATION_KEYWORD = "ultracode";

/** The note for a person's turn that `workflowStart: "always"` runs as a workflow. */
export const EVERY_TURN_WORKFLOW_NOTE = [
  "<t3-workflow-every-turn>",
  "The user asked T3 to run every turn as a workflow: multi-agent orchestration.",
  "For substantive work, plan it as a workflow and run it with the T3 workflow_start tool:",
  "phases, parallel agents, and agents that check each other's findings before you report.",
  ...ASSIGNMENT_RULES,
  "Stay solo only for conversational replies or trivial edits.",
  "</t3-workflow-every-turn>",
].join("\n");

/** What a turn's message asks of the workflow trigger. */
export type WorkflowRequest =
  /** A person's new message asks for a workflow. */
  | "requested"
  /** A person's new message does not, or `workflowStart` is "off". */
  | "plain"
  /** Not a person's new request (agent text, wakes, schedules, delegated threads, resumes). */
  | "ignored";

export interface WorkflowRequestInput {
  readonly workflows?: boolean;
  /** "off" means no message asks for a workflow; "keyword" and "always" read the triggers. */
  readonly workflowStart: WorkflowStartMode;
  readonly workflowTriggers: WorkflowTriggers;
  /** The message as stored, before provider context projection: what the person wrote. */
  readonly typedText: string;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: string | undefined;
  /** The thread is a delegated task or workflow member (persisted lineage: a subagent child). */
  readonly delegatedThread: boolean;
  /** A restart continuation: it resumes work, so it is not a new request. */
  readonly resumesEarlierTurn: boolean;
}

/**
 * The one rule for whether a message asks for a workflow. Turn start and the approval gate's
 * re-arm after a restart both ask it, so a message never counts as a request for one and not
 * the other.
 */
export function workflowRequestOf(input: WorkflowRequestInput): WorkflowRequest {
  if (
    input.workflows === false ||
    input.delegatedThread ||
    input.resumesEarlierTurn ||
    !isPersonTypedMessage(input)
  ) {
    return "ignored";
  }
  // Off still reads as a person's plain message, so it lifts a waiting request as one would.
  return input.workflowStart === "off" ||
    detectWorkflowIntent(input.typedText, input.workflowTriggers) === null
    ? "plain"
    : "requested";
}

/**
 * The text the provider receives for this turn: the plan-first note for a request, the every-turn
 * note for another person's turn under "always", else the text unchanged. `request` is the answer
 * `workflowRequestOf` already gave for this message.
 */
export function applyTurnTriggers(
  input: WorkflowRequestInput & {
    readonly driver: ProviderDriverKind;
    /** The text the provider would receive. */
    readonly text: string;
  },
  request: WorkflowRequest = workflowRequestOf(input),
): string {
  if (input.workflows === false) return input.text;
  if (request === "requested") {
    return `${input.text}\n\n${workflowTurnNote()}`;
  }
  // "ignored" covers agent text, server messages (approved workflow instructions among them),
  // wakes, schedules, delegated threads and resumes: none of them opts in on its own.
  if (request !== "plain" || input.workflowStart !== "always") return input.text;
  return input.driver === CLAUDE_DRIVER
    ? `${input.text}\n\n${CLAUDE_NATIVE_ORCHESTRATION_KEYWORD}`
    : `${input.text}\n\n${EVERY_TURN_WORKFLOW_NOTE}`;
}

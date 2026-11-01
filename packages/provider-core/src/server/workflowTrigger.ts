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
import type {
  WorkflowPresets,
  WorkflowStartMode,
  WorkflowTriggers,
} from "@t3tools/contracts/settings";
import { detectWorkflowIntent } from "@t3tools/shared/workflowIntent";

import { isPersonTypedMessage } from "./personMessage.ts";

const MAX_LISTED_PROFILES = 12;
const MAX_LISTED_NAME_CHARS = 60;

/**
 * A free-form value as a JSON string with angle brackets escaped: it stays on one line and
 * cannot open or close a tag in the note.
 */
function quoted(value: string, maxChars?: number): string {
  const characters = Array.from(value.replace(/\s+/gu, " ").trim());
  const shown =
    maxChars !== undefined && characters.length > maxChars
      ? `${characters.slice(0, maxChars).join("")}\u2026`
      : characters.join("");
  return JSON.stringify(shown).replace(/</gu, "\\u003c").replace(/>/gu, "\\u003e");
}

function profilesLine(presets: WorkflowPresets): string {
  if (presets.presets.length === 0) {
    return "The user has saved no profiles: leave preset out, and pick a check's target from orchestrator_capabilities.";
  }
  const describe = (profile: WorkflowPresets["presets"][number]) =>
    `${quoted(profile.name, MAX_LISTED_NAME_CHARS)} (id ${quoted(profile.id)}${
      profile.id === presets.defaultPresetId ? ", default" : ""
    })`;
  const shown = presets.presets.slice(0, MAX_LISTED_PROFILES);
  const omitted = presets.presets.slice(MAX_LISTED_PROFILES);
  const more =
    omitted.length > 0
      ? `, and ${omitted.length} more (all are in orchestrator_capabilities workflowPresets)`
      : "";
  // The stored order stays as saved; a default past the cap is named so it is never lost.
  const hiddenDefault = omitted.find((profile) => profile.id === presets.defaultPresetId);
  const defaultNote =
    hiddenDefault === undefined ? "" : ` The default profile is ${describe(hiddenDefault)}.`;
  return `The user saved these profiles in Settings: ${shown.map(describe).join(", ")}${more}.${defaultNote} Use a profile id from here or from orchestrator_capabilities; never invent one.`;
}

/** The plan-first note for a turn that asks for a workflow; one text for every driver. */
export function workflowTurnNote(presets: WorkflowPresets): string {
  return [
    "<t3-workflow>",
    "The user asked for a workflow, so plan it before anything runs.",
    "1. Split the work into graph nodes with dependencies and call graph_review.",
    "2. Set a worker node's preset to a saved profile's id.",
    "3. Add a verify check to any node whose result needs checking. A check takes no preset: set its target to a concrete providerInstanceId, model and options copied from an available entry of one profile (its target, then its fallbacks) in orchestrator_capabilities workflowPresets. Pick the entry yourself; T3 does not try other entries for a check.",
    "4. End your turn once graph_review has returned the plan. The user approves it in T3 Code, which then sends you a message with the approved digest: do not call graph_start or workflow_start before that message.",
    profilesLine(presets),
    "</t3-workflow>",
  ].join("\n");
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
  "Pick agents' providers and models with orchestrator_capabilities.",
  "Stay solo only for conversational replies or trivial edits. Token cost is not a constraint.",
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
    readonly workflowPresets: WorkflowPresets;
    readonly driver: ProviderDriverKind;
    /** The text the provider would receive. */
    readonly text: string;
  },
  request: WorkflowRequest = workflowRequestOf(input),
): string {
  if (input.workflows === false) return input.text;
  if (request === "requested") {
    return `${input.text}\n\n${workflowTurnNote(input.workflowPresets)}`;
  }
  // "ignored" covers agent text, server messages (approved workflow instructions among them),
  // wakes, schedules, delegated threads and resumes: none of them opts in on its own.
  if (request !== "plain" || input.workflowStart !== "always") return input.text;
  return input.driver === CLAUDE_DRIVER
    ? `${input.text}\n\n${CLAUDE_NATIVE_ORCHESTRATION_KEYWORD}`
    : `${input.text}\n\n${EVERY_TURN_WORKFLOW_NOTE}`;
}

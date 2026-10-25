/**
 * Per-turn hooks that start orchestration from a person's words: a message asking for a
 * workflow puts the coordinator into graph planning, which wins over the ultracode note. Only a
 * person's message on a non-delegated thread can ask; agent text, wakes, canned replies,
 * schedules, steers and restarts never do, or each child could start a fan-out.
 */
import type {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  ProviderDriverKind,
} from "@t3tools/contracts";
import type { UltracodeMode, WorkflowPresets, WorkflowTriggers } from "@t3tools/contracts/settings";
import { detectWorkflowIntent } from "@t3tools/shared/workflowIntent";

import { isPersonTypedMessage } from "./personMessage.ts";
import { applyUltracode } from "./ultracode.ts";

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

/** What a turn's message asks of the workflow trigger. */
export type WorkflowRequest =
  /** A person's new message asks for a workflow. */
  | "requested"
  /** A person's new message does not. */
  | "plain"
  /** Not a person's new request (agent text, wakes, schedules, delegated threads, resumes). */
  | "ignored";

export interface WorkflowRequestInput {
  readonly workflowTriggers: WorkflowTriggers;
  /** The message as stored, before provider context projection: what the person wrote. */
  readonly typedText: string;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: string | undefined;
  /** The thread is a delegated task or workflow member (persisted lineage: a subagent child). */
  readonly delegatedThread: boolean;
  /** A steering restart or restart continuation: it resumes work, so it is not a new request. */
  readonly resumesEarlierTurn: boolean;
}

/**
 * The one rule for whether a message asks for a workflow. Turn start and the approval gate's
 * re-arm after a restart both ask it, so a message never counts as a request for one and not
 * the other.
 */
export function workflowRequestOf(input: WorkflowRequestInput): WorkflowRequest {
  if (input.delegatedThread || input.resumesEarlierTurn || !isPersonTypedMessage(input)) {
    return "ignored";
  }
  return detectWorkflowIntent(input.typedText, input.workflowTriggers) === null
    ? "plain"
    : "requested";
}

/**
 * The text the provider receives for this turn: the workflow note, else the ultracode result.
 * `request` is the answer `workflowRequestOf` already gave for this message.
 */
export function applyTurnTriggers(
  input: WorkflowRequestInput & {
    readonly ultracode: UltracodeMode;
    readonly workflowPresets: WorkflowPresets;
    readonly driver: ProviderDriverKind;
    /** The text the provider would receive. */
    readonly text: string;
  },
  request: WorkflowRequest = workflowRequestOf(input),
): string {
  if (request === "requested") {
    return `${input.text}\n\n${workflowTurnNote(input.workflowPresets)}`;
  }
  return applyUltracode({
    mode: input.ultracode,
    driver: input.driver,
    text: input.text,
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    delegatedThread: input.delegatedThread,
  });
}

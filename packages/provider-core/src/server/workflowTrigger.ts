/**
 * Per-turn hooks that start orchestration from a person's words. A message that asks for a
 * workflow ("workflow" or the user's own trigger words) puts the coordinator into graph
 * planning; that note wins over the ultracode note, whose advice is to run a script at once.
 *
 * Only a person's message on a thread that is not a delegated task can ask for a workflow.
 * Agent text, server wakes, canned replies, schedules, steers and restart continuations never
 * do, or every child and every wake could start another fan-out. The note is the same for every
 * driver and names graph_review; it never adds a provider's own trigger word.
 *
 * This only adds planning guidance to the turn. It does not enforce approval: nothing here
 * stops an agent from calling graph_start or workflow_start.
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
    "4. End your turn once graph_review has returned the plan. The user reviews it first: do not call graph_start or workflow_start in this turn.",
    profilesLine(presets),
    "</t3-workflow>",
  ].join("\n");
}

/** The text the provider receives for this turn: the workflow note, else the ultracode result. */
export function applyTurnTriggers(input: {
  readonly ultracode: UltracodeMode;
  readonly workflowTriggers: WorkflowTriggers;
  readonly workflowPresets: WorkflowPresets;
  readonly driver: ProviderDriverKind;
  /** The text the provider would receive. */
  readonly text: string;
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
}): string {
  if (
    !input.delegatedThread &&
    !input.resumesEarlierTurn &&
    isPersonTypedMessage(input) &&
    detectWorkflowIntent(input.typedText, input.workflowTriggers) !== null
  ) {
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

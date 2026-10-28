/**
 * Ultracode for every provider: an opted-in turn carries a note asking the agent to run
 * substantive work as a T3 workflow (Claude only gets the keyword, which starts its own).
 * A delegated or workflow child never opts in on its own: only a person typing the keyword does.
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import type { OrchestrationV2CreationSource } from "@t3tools/contracts";
import type { UltracodeMode } from "@t3tools/contracts/settings";

import { isPersonTypedMessage } from "./personMessage.ts";

const KEYWORD = /\bultracode\b/i;

const CLAUDE_DRIVER = "claudeAgent";

export const ULTRACODE_TURN_NOTE = [
  "<t3-ultracode>",
  "The user opted this turn into ultracode: multi-agent orchestration.",
  "For substantive work, plan it as a workflow and run it with the T3 workflow_start tool:",
  "phases, parallel agents, and agents that check each other's findings before you report.",
  "Pick agents' providers and models with orchestrator_capabilities.",
  "Stay solo only for conversational replies or trivial edits. Token cost is not a constraint.",
  "</t3-ultracode>",
].join("\n");

/** The text the provider receives for this turn: unchanged unless the turn opts in. */
export function applyUltracode(input: {
  readonly mode: UltracodeMode;
  readonly driver: ProviderDriverKind;
  readonly text: string;
  /** What the person typed, without composer context. Only these words can say the keyword. */
  readonly typedWords: string;
  readonly createdBy: "agent" | "system" | "user";
  readonly creationSource: OrchestrationV2CreationSource;
  /** The thread is a delegated task or workflow member (persisted lineage: a subagent child). */
  readonly delegatedThread: boolean;
}): string {
  // Server messages include approved workflow instructions; they must not trigger another workflow.
  if (input.mode === "off" || input.createdBy === "system" || input.creationSource === "server") {
    return input.text;
  }
  const typed = KEYWORD.test(input.typedWords);
  if (input.delegatedThread && !(typed && isPersonTypedMessage(input))) return input.text;
  if (input.mode === "keyword" && !typed) return input.text;
  if (input.driver === CLAUDE_DRIVER) {
    return typed ? input.text : `${input.text}\n\nultracode`;
  }
  return `${input.text}\n\n${ULTRACODE_TURN_NOTE}`;
}

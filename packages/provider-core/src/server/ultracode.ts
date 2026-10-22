/**
 * Ultracode for every provider: a turn that opts in carries a note asking the agent to
 * orchestrate substantive work as a T3 workflow. Claude Code has its own ultracode, which the
 * keyword in the message already starts, so a Claude turn only gets the keyword added when the
 * setting opts it in without the user typing it.
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import type { UltracodeMode } from "@t3tools/contracts/settings";

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
  readonly createdBy: "agent" | "system" | "user";
}): string {
  // System turns (completion wakes, restart continuations) report back; they do not start work.
  if (input.mode === "off" || input.createdBy === "system") return input.text;
  const typed = KEYWORD.test(input.text);
  if (input.mode === "keyword" && !typed) return input.text;
  if (input.driver === CLAUDE_DRIVER) {
    return typed ? input.text : `${input.text}\n\nultracode`;
  }
  return `${input.text}\n\n${ULTRACODE_TURN_NOTE}`;
}

/**
 * Whether a person typed a message into a web or mobile client. Hooks that start orchestration
 * from a message's words (ultracode, workflow triggers) ask this first: agent text, server
 * wakes and canned replies must not start anything, or every child could start another fan-out.
 */
import type { OrchestrationV2Actor, OrchestrationV2CreationSource } from "@t3tools/contracts";

export function isPersonTypedMessage(input: {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
  /** Set when a schedule sent the message, so no person typed it for this turn. */
  readonly scheduledTaskId?: string | undefined;
  /** Set when another thread sent the message. */
  readonly senderThreadId?: string | undefined;
}): boolean {
  return (
    input.createdBy === "user" &&
    (input.creationSource === "web" || input.creationSource === "mobile") &&
    input.scheduledTaskId === undefined &&
    input.senderThreadId === undefined
  );
}

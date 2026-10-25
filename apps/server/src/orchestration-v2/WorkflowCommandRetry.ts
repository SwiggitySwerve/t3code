/**
 * A failed decide stores a rejection under the command id, and the dispatcher answers that id the
 * same way for good. Workflow stop and completion are idempotent in the domain, so a spent id can
 * be replaced by a fresh one; this module recognizes a spent id and mints its replacement.
 */
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

/** The dispatcher answers this command id the same way for good, whatever the command says. */
export const isCommandIdSpent = (error: { readonly _tag: string }) =>
  error._tag === "OrchestratorCommandPreviouslyRejectedError" ||
  error._tag === "OrchestratorCommandIdConflictError";

/** Another id for the same command; no rejection stored under one answers another. */
export const freshCommandId = Effect.fn("WorkflowCommandRetry.freshCommandId")(function* (
  base: CommandId,
) {
  const high = yield* Random.nextIntBetween(0, 0xffffffff);
  const low = yield* Random.nextIntBetween(0, 0xffffffff);
  return CommandId.make(
    `${base}:retry:${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`,
  );
});

/**
 * Sends a command under `commandId`; when that id is spent, sends it once more under a fresh id.
 * A refusal that is not tied to the id comes back as it is, so a permanent refusal costs one extra
 * send per call and never loops. Only for commands that are safe to send twice.
 */
export const sendWithFreshId = Effect.fn("WorkflowCommandRetry.sendWithFreshId")(function* <
  A,
  E extends { readonly _tag: string },
  R,
>(commandId: CommandId, send: (commandId: CommandId) => Effect.Effect<A, E, R>) {
  return yield* send(commandId).pipe(
    Effect.catchIf(isCommandIdSpent, () => Effect.flatMap(freshCommandId(commandId), send)),
  );
});

import { expect, it } from "@effect/vitest";
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { freshCommandId, sendWithFreshId } from "./WorkflowCommandRetry.ts";

const base = CommandId.make("command:workflow-retry:base");

/** A sender that answers each command id as the dispatcher would, recording every id it saw. */
const makeSender = (answer: (commandId: CommandId) => { readonly _tag: string } | undefined) => {
  const sent: Array<CommandId> = [];
  const send = (commandId: CommandId): Effect.Effect<string, { readonly _tag: string }> => {
    sent.push(commandId);
    const refusal = answer(commandId);
    return refusal === undefined ? Effect.succeed("accepted") : Effect.fail(refusal);
  };
  return { sent, send };
};

it.effect.each([
  { tag: "OrchestratorCommandPreviouslyRejectedError" },
  { tag: "OrchestratorCommandIdConflictError" },
])("sends again under a fresh id when the id is spent ($tag)", ({ tag }) =>
  Effect.gen(function* () {
    const { sent, send } = makeSender((commandId) =>
      commandId === base ? { _tag: tag } : undefined,
    );

    expect(yield* sendWithFreshId(base, send)).toBe("accepted");

    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(base);
    expect(sent[1]!.startsWith(`${base}:retry:`)).toBe(true);
  }),
);

it.effect("keeps one send for an accepted command", () =>
  Effect.gen(function* () {
    const { sent, send } = makeSender(() => undefined);

    yield* sendWithFreshId(base, send);

    expect(sent).toEqual([base]);
  }),
);

it.effect("returns a refusal that is not tied to the id without sending again", () =>
  Effect.gen(function* () {
    const { sent, send } = makeSender(() => ({ _tag: "OrchestratorDispatchError" }));

    const error = yield* Effect.flip(sendWithFreshId(base, send));

    expect(error).toEqual({ _tag: "OrchestratorDispatchError" });
    expect(sent).toEqual([base]);
  }),
);

it.effect("sends at most once more when the fresh id is spent as well", () =>
  Effect.gen(function* () {
    const { sent, send } = makeSender(() => ({
      _tag: "OrchestratorCommandPreviouslyRejectedError",
    }));

    const error = yield* Effect.flip(sendWithFreshId(base, send));

    expect(error._tag).toBe("OrchestratorCommandPreviouslyRejectedError");
    expect(sent).toHaveLength(2);
  }),
);

it.effect("mints a different id on every call", () =>
  Effect.gen(function* () {
    const first = yield* freshCommandId(base);
    const second = yield* freshCommandId(base);

    expect(first).not.toBe(second);
    expect(first.startsWith(`${base}:retry:`)).toBe(true);
  }),
);

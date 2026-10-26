import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

type CodexRequestClient = Pick<CodexClient.CodexAppServerClient["Service"], "request">;

const MAX_TURNS_PAGE = 100;

const historyError = (message: string) =>
  CodexErrors.CodexAppServerRequestError.internalError(message, undefined, {
    method: "thread/turns/list",
    operation: "decode-payload",
  });

/** A rollback the thread's history does not support; the history itself decoded fine. */
const historyRefusal = (message: string) =>
  CodexErrors.CodexAppServerRequestError.internalError(message, undefined, {
    method: "thread/turns/list",
  });

/** Pages newest-first through a thread's turns until `visit` returns true. */
const forEachTurnNewestFirst = Effect.fn("forEachCodexTurnNewestFirst")(function* (
  client: CodexRequestClient,
  threadId: string,
  pageLimit: (consumed: number) => number,
  visit: (turnId: string) => boolean,
) {
  let consumed = 0;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (true) {
    if (visited.has(cursor)) {
      return yield* historyError("Thread history pagination repeated a cursor.");
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: pageLimit(consumed),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      consumed += 1;
      if (visit(turn.id)) return;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) return;
  }
});

/** With no boundary there is nothing to remove, so only the current thread is read back. */
const revertBeforeTurn = (
  client: CodexRequestClient,
  threadId: string,
  beforeTurnId: string | undefined,
) =>
  beforeTurnId === undefined
    ? client.request("thread/read", { threadId, includeTurns: false })
    : client.request("thread/revert", { threadId, beforeTurnId });

/** Removes the newest `numTurns` turns, counted from the thread's current head. */
export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: CodexRequestClient,
  threadId: string,
  numTurns: number,
) {
  let remaining = numTurns;
  let beforeTurnId: string | undefined;
  if (remaining > 0) {
    yield* forEachTurnNewestFirst(
      client,
      threadId,
      (consumed) => Math.min(numTurns - consumed, MAX_TURNS_PAGE),
      (turnId) => {
        beforeTurnId = turnId;
        return --remaining === 0;
      },
    );
  }
  return yield* revertBeforeTurn(client, threadId, beforeTurnId);
});

/** Sizes pages from the turns a rollback expects to visit; a longer history gets full pages. */
const expectedTurnsPageLimit = (expectedTurns: number) => (consumed: number) => {
  const remaining = expectedTurns - consumed;
  return remaining > 0 ? Math.min(remaining, MAX_TURNS_PAGE) : MAX_TURNS_PAGE;
};

/** What the rollback target says about the turn the thread should end at. */
export type CodexKeptTurn =
  | { readonly type: "turn"; readonly turnId: string }
  | { readonly type: "start" }
  | { readonly type: "unknown" };

/**
 * Reverts before `firstRemovedTurnId`, or on a retry before the oldest of `removedTurnIds`
 * still present. With none present it succeeds only if the thread ends at the kept turn
 * or the target is the start; an unrecorded turn above the kept turn fails.
 */
export const revertCodexThreadFromTurn = Effect.fn("revertCodexThreadFromTurn")(function* (
  client: CodexRequestClient,
  threadId: string,
  boundary: {
    readonly firstRemovedTurnId: string;
    readonly removedTurnIds: ReadonlyArray<string>;
    readonly kept: CodexKeptTurn;
  },
  expectedTurns: number,
) {
  const removed = new Set([boundary.firstRemovedTurnId, ...boundary.removedTurnIds]);
  const keptTurnId = boundary.kept.type === "turn" ? boundary.kept.turnId : undefined;
  let oldestPresentRemovedTurnId: string | undefined;
  let aboveKeptTurnId: string | undefined;
  let keptTurnFound = false;
  yield* forEachTurnNewestFirst(
    client,
    threadId,
    expectedTurnsPageLimit(expectedTurns),
    (turnId) => {
      if (turnId === keptTurnId) {
        keptTurnFound = true;
        return true;
      }
      if (removed.has(turnId)) oldestPresentRemovedTurnId = turnId;
      aboveKeptTurnId = turnId;
      return turnId === boundary.firstRemovedTurnId;
    },
  );
  if (oldestPresentRemovedTurnId === boundary.firstRemovedTurnId) {
    return yield* revertBeforeTurn(client, threadId, boundary.firstRemovedTurnId);
  }
  switch (boundary.kept.type) {
    case "start":
    case "unknown":
      if (oldestPresentRemovedTurnId !== undefined) {
        return yield* revertBeforeTurn(client, threadId, oldestPresentRemovedTurnId);
      }
      return boundary.kept.type === "start"
        ? yield* revertBeforeTurn(client, threadId, undefined)
        : yield* historyRefusal(
            `Thread history no longer contains rollback turn ${boundary.firstRemovedTurnId}, and the rollback target has no native turn id to confirm the thread already ends there.`,
          );
    case "turn":
      if (!keptTurnFound) {
        return yield* historyRefusal(
          `Thread history neither contains rollback turn ${boundary.firstRemovedTurnId} nor the rollback target ${boundary.kept.turnId}.`,
        );
      }
      if (aboveKeptTurnId === undefined) {
        return yield* revertBeforeTurn(client, threadId, undefined);
      }
      return removed.has(aboveKeptTurnId)
        ? yield* revertBeforeTurn(client, threadId, aboveKeptTurnId)
        : yield* historyRefusal(
            `Thread history has turn ${aboveKeptTurnId} directly above rollback target ${boundary.kept.turnId}, and it is not a turn this rollback removes (the oldest is ${boundary.firstRemovedTurnId}).`,
          );
  }
});
/**
 * Removes every turn after `keptTurnId`, for rollbacks whose oldest removed
 * turn has no native id to name. Retrying once the thread ends at the kept
 * turn removes nothing.
 */
export const revertCodexThreadAfterTurn = Effect.fn("revertCodexThreadAfterTurn")(function* (
  client: CodexRequestClient,
  threadId: string,
  keptTurnId: string,
  expectedTurns: number,
) {
  let keptTurnFound = false;
  let oldestNewerTurnId: string | undefined;
  yield* forEachTurnNewestFirst(
    client,
    threadId,
    expectedTurnsPageLimit(expectedTurns),
    (turnId) => {
      keptTurnFound = turnId === keptTurnId;
      if (!keptTurnFound) oldestNewerTurnId = turnId;
      return keptTurnFound;
    },
  );
  if (!keptTurnFound) {
    return yield* historyRefusal(
      `Thread history does not contain rollback target turn ${keptTurnId}.`,
    );
  }
  return yield* revertBeforeTurn(client, threadId, oldestNewerTurnId);
});

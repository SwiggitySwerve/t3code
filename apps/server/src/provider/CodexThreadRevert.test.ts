import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";

import {
  revertCodexThread,
  revertCodexThreadAfterTurn,
  revertCodexThreadFromTurn,
} from "./CodexThreadRevert.ts";

const page = (
  id: number,
  cursor: string | null,
  limit: number,
  turns: string[],
  nextCursor: string | null,
) => [
  {
    type: "expect_outbound" as const,
    frame: {
      id,
      method: "thread/turns/list",
      params: {
        threadId: "thread",
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "summary",
      },
    },
  },
  {
    type: "emit_inbound" as const,
    frame: {
      id,
      result: {
        data: turns.map((id) => ({ id, items: [], status: "completed", error: null })),
        nextCursor,
      },
    },
  },
];

it.effect("finds the revert boundary across pages of newest-first turns", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "boundary reached");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-pages",
        entries: [
          ...page(1, null, 3, ["newest", "middle"], "older"),
          ...page(2, "older", 1, ["boundary"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "boundary" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "boundary reached" } },
          },
        ],
      }),
    ),
    Effect.scoped,
  ),
);

it.effect("rejects repeated cursors instead of looping or reverting incomplete history", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "Thread history pagination repeated a cursor.");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-loop",
        entries: [...page(1, null, 3, ["newest"], "again"), ...page(2, "again", 2, [], "again")],
      }),
    ),
    Effect.scoped,
  ),
);

const threadResult = (id: number, method: string, params: unknown, result: unknown) => [
  { type: "expect_outbound" as const, frame: { id, method, params } },
  { type: "emit_inbound" as const, frame: { id, result } },
];

const replay = (scenario: string, entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>) =>
  CodexReplay.layerReplay({
    provider: "codex",
    protocol: "codex.app-server",
    version: "test",
    scenario,
    entries: [...entries],
  });

const readBack = (id: number) =>
  threadResult(
    id,
    "thread/read",
    { threadId: "thread", includeTurns: false },
    {
      thread: {
        id: "thread",
        sessionId: "thread",
        forkedFromId: null,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1782622440,
        updatedAt: 1782622440,
        status: { type: "idle" },
        path: "/tmp/thread.jsonl",
        cwd: "/workspace",
        cliVersion: "0.144.0",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
    },
  );

it.effect("reverts before the oldest removed turn however many newer turns the thread holds", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      {
        firstRemovedTurnId: "removed",
        removedTurnIds: ["removed"],
        kept: { type: "turn", turnId: "kept" },
      },
      2,
    ).pipe(Effect.flip);
    assert.equal(result.message, "reverted");
  }).pipe(
    Effect.provide(
      replay("revert-from-turn", [
        ...page(1, null, 2, ["extra", "newest"], "older"),
        ...page(2, "older", 100, ["removed", "kept"], null),
        {
          type: "expect_outbound",
          frame: {
            id: 3,
            method: "thread/revert",
            params: { threadId: "thread", beforeTurnId: "removed" },
          },
        },
        {
          type: "emit_inbound",
          frame: { id: 3, error: { code: -32603, message: "reverted" } },
        },
      ]),
    ),
    Effect.scoped,
  ),
);

it.effect("treats a thread that already ends at the kept turn as rolled back", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      {
        firstRemovedTurnId: "removed",
        removedTurnIds: ["removed"],
        kept: { type: "turn", turnId: "kept" },
      },
      2,
    );
    assert.equal(result.thread.id, "thread");
  }).pipe(
    Effect.provide(
      replay("revert-from-turn-done", [
        ...page(1, null, 2, ["kept", "older"], "more"),
        ...readBack(2),
      ]),
    ),
    Effect.scoped,
  ),
);

it.effect("rolls back to the start without a kept turn once the removed turns are gone", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      { firstRemovedTurnId: "removed", removedTurnIds: ["removed"], kept: { type: "start" } },
      1,
    );
    assert.equal(result.thread.id, "thread");
  }).pipe(
    Effect.provide(
      replay("revert-from-turn-start", [...page(1, null, 1, ["inherited"], null), ...readBack(2)]),
    ),
    Effect.scoped,
  ),
);

it.effect.each([
  { name: "a thread whose history no longer holds the kept turn", live: ["unrelated"] },
  { name: "a thread with turns newer than the kept turn", live: ["unrecorded", "kept"] },
])("refuses to revert $name", ({ live }) =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      {
        firstRemovedTurnId: "removed",
        removedTurnIds: ["removed"],
        kept: { type: "turn", turnId: "kept" },
      },
      1,
    ).pipe(Effect.flip);
    assert.include(error.message, "removed");
    assert.include(error.message, "kept");
  }).pipe(
    Effect.provide(replay("revert-from-turn-refused", page(1, null, 1, live, null))),
    Effect.scoped,
  ),
);
const revertBefore = (id: number, beforeTurnId: string) => [
  {
    type: "expect_outbound" as const,
    frame: { id, method: "thread/revert", params: { threadId: "thread", beforeTurnId } },
  },
  {
    type: "emit_inbound" as const,
    frame: { id, error: { code: -32603, message: `reverted before ${beforeTurnId}` } },
  },
];

it.effect.each([
  {
    name: "a start rollback",
    kept: { type: "start" },
    live: ["second", "inherited"],
    reverted: "second",
  },
  {
    name: "a rollback to a target with no native turn id",
    kept: { type: "unknown" },
    live: ["second", "inherited"],
    reverted: "second",
  },
  {
    name: "a rollback to a kept turn",
    kept: { type: "turn", turnId: "kept" },
    live: ["second", "kept"],
    reverted: "second",
  },
] as const)(
  "converges on the oldest recorded removed turn that is still present for $name",
  ({ kept, live, reverted }) =>
    Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      const error = yield* revertCodexThreadFromTurn(
        client,
        "thread",
        { firstRemovedTurnId: "removed", removedTurnIds: ["removed", "second"], kept },
        2,
      ).pipe(Effect.flip);
      assert.equal(error.message, `reverted before ${reverted}`);
    }).pipe(
      Effect.provide(
        replay("revert-converge", [
          ...page(1, null, 2, [...live], null),
          ...revertBefore(2, reverted),
        ]),
      ),
      Effect.scoped,
    ),
);

it.effect("reverts before a removed turn that has later unrecorded turns above it", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      {
        firstRemovedTurnId: "removed",
        removedTurnIds: ["removed", "second"],
        kept: { type: "turn", turnId: "kept" },
      },
      2,
    ).pipe(Effect.flip);
    assert.equal(error.message, "reverted before second");
  }).pipe(
    Effect.provide(
      replay("revert-converge-above", [
        ...page(1, null, 2, ["unrecorded", "second", "kept"], null),
        ...revertBefore(2, "second"),
      ]),
    ),
    Effect.scoped,
  ),
);

it.effect("refuses an unrecorded turn directly above the kept turn", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      {
        firstRemovedTurnId: "removed",
        removedTurnIds: ["removed", "second"],
        kept: { type: "turn", turnId: "kept" },
      },
      2,
    ).pipe(Effect.flip);
    assert.include(error.message, "unrecorded");
    assert.include(error.message, "kept");
  }).pipe(
    Effect.provide(
      replay("revert-converge-foreign", page(1, null, 2, ["second", "unrecorded", "kept"], null)),
    ),
    Effect.scoped,
  ),
);
it.effect("refuses a retry whose target names no native turn", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      { firstRemovedTurnId: "removed", removedTurnIds: ["removed"], kept: { type: "unknown" } },
      1,
    ).pipe(Effect.flip);
    assert.include(error.message, "no native turn id");
  }).pipe(
    Effect.provide(replay("revert-from-turn-unknown", page(1, null, 1, ["anything"], null))),
    Effect.scoped,
  ),
);

it.effect("still reverts a target with no native turn while the removed turn exists", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadFromTurn(
      client,
      "thread",
      { firstRemovedTurnId: "removed", removedTurnIds: ["removed"], kept: { type: "unknown" } },
      1,
    ).pipe(Effect.flip);
    assert.equal(error.message, "reverted");
  }).pipe(
    Effect.provide(
      replay("revert-from-turn-unknown-live", [
        ...page(1, null, 1, ["removed"], null),
        {
          type: "expect_outbound",
          frame: {
            id: 2,
            method: "thread/revert",
            params: { threadId: "thread", beforeTurnId: "removed" },
          },
        },
        { type: "emit_inbound", frame: { id: 2, error: { code: -32603, message: "reverted" } } },
      ]),
    ),
    Effect.scoped,
  ),
);

it.effect("reverts before the oldest turn newer than the kept turn, across pages", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadAfterTurn(client, "thread", "kept", 2).pipe(Effect.flip);
    assert.equal(error.message, "reverted");
  }).pipe(
    Effect.provide(
      replay("revert-after-turn", [
        ...page(1, null, 2, ["newest", "middle"], "older"),
        ...page(2, "older", 100, ["kept"], null),
        {
          type: "expect_outbound",
          frame: {
            id: 3,
            method: "thread/revert",
            params: { threadId: "thread", beforeTurnId: "middle" },
          },
        },
        { type: "emit_inbound", frame: { id: 3, error: { code: -32603, message: "reverted" } } },
      ]),
    ),
    Effect.scoped,
  ),
);

it.effect("leaves a thread that already ends at the kept turn alone", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadAfterTurn(client, "thread", "kept", 2);
    assert.equal(result.thread.id, "thread");
  }).pipe(
    Effect.provide(
      replay("revert-after-turn-done", [...page(1, null, 2, ["kept"], null), ...readBack(2)]),
    ),
    Effect.scoped,
  ),
);

it.effect("refuses to revert after a kept turn the thread does not hold", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadAfterTurn(client, "thread", "kept", 1).pipe(Effect.flip);
    assert.include(error.message, "kept");
  }).pipe(
    Effect.provide(replay("revert-after-turn-missing", page(1, null, 1, ["unrelated"], null))),
    Effect.scoped,
  ),
);

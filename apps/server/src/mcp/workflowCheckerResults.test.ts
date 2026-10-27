import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  CHECKER_RESULT_MAX_AGE,
  checkerResultName,
  makeCheckerResults,
} from "./workflowCheckerResults.ts";

const ID_ONE = "11111111-1111-4111-8111-111111111111";
const ID_TWO = "22222222-2222-4222-8222-222222222222";
const ID_OLD = "33333333-3333-4333-8333-333333333333";

const NOW = DateTime.makeUnsafe("2026-10-26T12:00:00Z");
const PAST_MAX_AGE = Duration.sum(CHECKER_RESULT_MAX_AGE, Duration.hours(1));
const ID_NEW = "44444444-4444-4444-8444-444444444444";

const age = (file: string, by: Duration.Duration) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const mtime = DateTime.toDateUtc(DateTime.subtractDuration(NOW, by));
    yield* fileSystem.utimes(file, mtime, mtime);
  });

/** A results folder inside a fresh temp folder, which also holds a file the folder does not own. */
const setup = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-checker-results-" });
  const dir = path.join(root, "workflow-results");
  return {
    fileSystem,
    path,
    root,
    dir,
    results: makeCheckerResults({ dir, fileSystem, path }),
  };
});

it.layer(NodeServices.layer)("workflowCheckerResults", (it) => {
  it.effect("writes each check to a new absolute file inside its own folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, path, dir, results } = yield* setup;
        const first = yield* results.write({ id: ID_ONE, text: "first answer" });
        const second = yield* results.write({ id: ID_TWO, text: "second answer" });
        assert.notStrictEqual(first, second);
        for (const file of [first, second]) {
          assert.isTrue(path.isAbsolute(file), file);
          assert.strictEqual(path.dirname(file), dir);
          assert.match(path.basename(file), /^checker-[0-9a-f]{32}\.txt$/);
        }
        assert.strictEqual(path.basename(first), checkerResultName(ID_ONE));
        assert.strictEqual(yield* fileSystem.readFileString(first), "first answer");
        assert.strictEqual(yield* fileSystem.readFileString(second), "second answer");
      }),
    ),
  );

  it.effect("never overwrites a file another check is using", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, results } = yield* setup;
        const file = yield* results.write({ id: ID_ONE, text: "kept" });
        const again = yield* results.write({ id: ID_ONE, text: "replaced" }).pipe(Effect.flip);
        assert.strictEqual(again._tag, "PlatformError");
        assert.strictEqual(yield* fileSystem.readFileString(file), "kept");
      }),
    ),
  );

  it.effect("removes only its own file, so finishing one check keeps the other's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, path, dir, results } = yield* setup;
        const first = yield* results.write({ id: ID_ONE, text: "first" });
        const second = yield* results.write({ id: ID_TWO, text: "second" });
        // Data the folder holds that this module did not make.
        const notes = path.join(dir, "notes.txt");
        const lookalike = path.join(dir, "checker-short.txt");
        const nested = path.join(dir, "keep", "data.txt");
        yield* fileSystem.writeFileString(notes, "notes");
        yield* fileSystem.writeFileString(lookalike, "lookalike");
        yield* fileSystem.makeDirectory(path.dirname(nested), { recursive: true });
        yield* fileSystem.writeFileString(nested, "nested");

        assert.isTrue(yield* results.remove(first));
        assert.isFalse(yield* fileSystem.exists(first));
        assert.strictEqual(yield* fileSystem.readFileString(second), "second");
        for (const kept of [notes, lookalike, nested]) {
          assert.isTrue(yield* fileSystem.exists(kept), kept);
        }

        assert.isTrue(yield* results.remove(second));
        // The folder is shared, so it stays, with what is not ours in it.
        assert.isTrue(yield* fileSystem.exists(dir));
        assert.deepStrictEqual((yield* fileSystem.readDirectory(dir)).toSorted(), [
          "checker-short.txt",
          "keep",
          "notes.txt",
        ]);
        // A file that is already gone is not an error.
        assert.isTrue(yield* results.remove(first));
      }),
    ),
  );

  it.effect("keeps a file written while another check's file is removed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, dir, results } = yield* setup;
        for (let round = 0; round < 25; round += 1) {
          const gone = yield* results.write({
            id: `${round.toString(16).padStart(8, "0")}-0000-4000-8000-00000000000a`,
            text: "done",
          });
          const [written] = yield* Effect.all(
            [
              results.write({
                id: `${round.toString(16).padStart(8, "0")}-0000-4000-8000-00000000000b`,
                text: `live ${round}`,
              }),
              results.remove(gone),
            ],
            { concurrency: "unbounded" },
          );
          assert.strictEqual(yield* fileSystem.readFileString(written), `live ${round}`);
          assert.isTrue(yield* fileSystem.exists(dir));
          yield* results.remove(written);
        }
      }),
    ),
  );

  it.effect("refuses to remove anything that is not an owned file in its folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, path, root, dir, results } = yield* setup;
        yield* fileSystem.makeDirectory(dir, { recursive: true });
        const notes = path.join(dir, "notes.txt");
        const outside = path.join(root, checkerResultName(ID_ONE));
        const traversal = path.join(dir, "..", checkerResultName(ID_TWO));
        const nestedDir = path.join(dir, "nested");
        const nested = path.join(nestedDir, checkerResultName(ID_OLD));
        yield* fileSystem.makeDirectory(nestedDir);
        for (const file of [notes, outside, path.resolve(traversal), nested]) {
          yield* fileSystem.writeFileString(file, "data");
        }
        for (const target of [notes, outside, traversal, nested, nestedDir, dir, root]) {
          assert.isFalse(yield* results.remove(target), target);
          assert.isTrue(yield* fileSystem.exists(target), target);
        }
      }),
    ),
  );

  it.effect("clears owned files a day old on the next write, and nothing else", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, path, dir, results } = yield* setup;
        const now = DateTime.makeUnsafe("2026-10-26T12:00:00Z");
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        const setAge = (file: string, age: Duration.Duration) => {
          const mtime = DateTime.toDateUtc(DateTime.subtractDuration(now, age));
          return fileSystem.utimes(file, mtime, mtime);
        };
        yield* fileSystem.makeDirectory(dir, { recursive: true });
        const justOver = Duration.sum(CHECKER_RESULT_MAX_AGE, Duration.seconds(1));
        const stale = path.join(dir, checkerResultName(ID_OLD));
        const recent = path.join(dir, checkerResultName(ID_ONE));
        const oldNotes = path.join(dir, "notes.txt");
        const oldLookalike = path.join(dir, "checker-short.txt");
        const oldFolder = path.join(dir, checkerResultName(ID_TWO));
        const insideOldFolder = path.join(oldFolder, "data.txt");
        for (const file of [stale, recent, oldNotes, oldLookalike]) {
          yield* fileSystem.writeFileString(file, "data");
        }
        yield* fileSystem.makeDirectory(oldFolder);
        yield* fileSystem.writeFileString(insideOldFolder, "data");
        yield* setAge(stale, justOver);
        yield* setAge(recent, Duration.hours(23));
        yield* setAge(oldNotes, Duration.days(30));
        yield* setAge(oldLookalike, Duration.days(30));
        yield* setAge(oldFolder, Duration.days(30));

        const fresh = yield* results.write({
          id: "44444444-4444-4444-8444-444444444444",
          text: "fresh",
        });

        assert.isFalse(yield* fileSystem.exists(stale));
        for (const kept of [recent, oldNotes, oldLookalike, insideOldFolder, fresh]) {
          assert.isTrue(yield* fileSystem.exists(kept), kept);
        }
      }),
    ),
  );

  it.effect("keeps an old file whose check is still running when another write sweeps", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, results } = yield* setup;
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
        // A queued checker can wait longer than a day for its turn.
        const live = yield* results.write({ id: ID_ONE, text: "still needed" });
        yield* age(live, PAST_MAX_AGE);

        const fresh = yield* results.write({ id: ID_NEW, text: "fresh" });

        assert.strictEqual(yield* fileSystem.readFileString(live), "still needed");
        assert.isTrue(yield* fileSystem.exists(fresh));
      }),
    ),
  );

  it.effect("removes an old file that no check in this process is using", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, path, dir, results } = yield* setup;
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
        // Left by a server that stopped mid-check: on disk, never written by this process.
        yield* fileSystem.makeDirectory(dir, { recursive: true });
        const abandoned = path.join(dir, checkerResultName(ID_OLD));
        yield* fileSystem.writeFileString(abandoned, "left behind");
        yield* age(abandoned, PAST_MAX_AGE);

        yield* results.write({ id: ID_NEW, text: "fresh" });

        assert.isFalse(yield* fileSystem.exists(abandoned));
      }),
    ),
  );

  it.effect("stops protecting a file once its check removed it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { fileSystem, results } = yield* setup;
        yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
        const file = yield* results.write({ id: ID_ONE, text: "answer" });
        assert.isTrue(yield* results.remove(file));
        // Something puts a file back under the same name (a leftover that is not any check's).
        yield* fileSystem.writeFileString(file, "leftover");
        yield* age(file, PAST_MAX_AGE);

        yield* results.write({ id: ID_NEW, text: "fresh" });

        assert.isFalse(yield* fileSystem.exists(file));
      }),
    ),
  );
});

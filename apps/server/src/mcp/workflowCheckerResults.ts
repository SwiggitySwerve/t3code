import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

/**
 * Owns the files that hold an agent's whole answer for the checker that judges it. They live in a
 * folder the server owns (`ServerConfig.workflowResultsDir`), never in the user's checkout, and
 * each check gets a file of its own. This module only ever removes a file it can prove it made:
 * a regular file directly inside that folder whose name has the shape of `checkerResultName`.
 */

/** A checker file's name: a fixed prefix and the 32 hex digits of a random id. */
const OWNED_NAME = /^checker-[0-9a-f]{32}\.txt$/;

/**
 * Files written by this server process whose check has not removed them yet. A queued checker can
 * wait far longer than `CHECKER_RESULT_MAX_AGE` for its turn, so the age sweep must not take its
 * answer. A file from an earlier server process is not in here, so age alone decides about it.
 * It is per process, not per instance, so every instance sharing a folder sees the same files.
 */
const liveFiles = new Set<string>();

/**
 * A file this old that no check in this process is using was left by a server that stopped
 * mid-check, so the next write clears it.
 */
export const CHECKER_RESULT_MAX_AGE = Duration.days(1);

/** The file name for a check, from a random id (UUID dashes are dropped). */
export const checkerResultName = (id: string): string => `checker-${id.replaceAll("-", "")}.txt`;

export function makeCheckerResults(input: {
  readonly dir: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { fileSystem, path } = input;
  const dir = path.resolve(input.dir);

  /**
   * Removes the owned files last written before the cutoff, except live ones. A failure leaves
   * that file alone.
   */
  const pruneStale = Effect.fn("workflowCheckerResults.pruneStale")(function* () {
    const cutoff = (yield* Clock.currentTimeMillis) - Duration.toMillis(CHECKER_RESULT_MAX_AGE);
    const names = yield* fileSystem.readDirectory(dir);
    let removed = 0;
    for (const name of names.filter((entry) => OWNED_NAME.test(entry))) {
      const filePath = path.join(dir, name);
      if (liveFiles.has(filePath)) continue;
      const gone = yield* fileSystem.stat(filePath).pipe(
        Effect.flatMap((info) =>
          info.type === "File" && Option.exists(info.mtime, (mtime) => mtime.getTime() < cutoff)
            ? fileSystem.remove(filePath, { force: true }).pipe(Effect.as(true))
            : Effect.succeed(false),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (gone) removed += 1;
    }
    return removed;
  });

  /**
   * Writes `text` to a new file and returns its absolute path. Files an earlier server run left
   * behind are cleared first, as far as that can be done. The new file stays out of that sweep
   * until `remove` is called for it.
   */
  const write = Effect.fn("workflowCheckerResults.write")(function* (request: {
    readonly id: string;
    readonly text: string;
  }) {
    yield* fileSystem.makeDirectory(dir, { recursive: true });
    const removed = yield* pruneStale().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not clear old checker result files", {
          error: error.message,
        }).pipe(Effect.as(0)),
      ),
    );
    if (removed > 0) yield* Effect.logInfo("Removed old checker result files.", { removed });
    const filePath = path.join(dir, checkerResultName(request.id));
    // A new file only: an id that is already taken must not overwrite another check's answer.
    yield* fileSystem.writeFileString(filePath, request.text, { flag: "wx" });
    liveFiles.add(filePath);
    return filePath;
  });

  /**
   * Removes the one file `write` made at `filePath`, and nothing else. A path that is not an owned
   * file directly in the folder is refused (false) and left alone; the folder itself stays,
   * because other checks may be using it.
   */
  const remove = Effect.fn("workflowCheckerResults.remove")(function* (filePath: string) {
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== dir || !OWNED_NAME.test(path.basename(resolved))) {
      yield* Effect.logWarning("Refused to remove a file that is not a checker result", {
        path: filePath,
      });
      return false;
    }
    // Unregistered first: the check is over even if the file cannot be removed, and the age sweep
    // may then clear it.
    liveFiles.delete(resolved);
    yield* fileSystem.remove(resolved, { force: true });
    return true;
  });

  return { write, remove } as const;
}

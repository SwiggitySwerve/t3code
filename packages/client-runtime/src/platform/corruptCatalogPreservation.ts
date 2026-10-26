import * as Effect from "effect/Effect";

import { ConnectionTransientError } from "../connection/model.ts";

/**
 * A catalog that fails to decode is evidence, not an empty catalog. Stores fail closed with this
 * error and leave the stored bytes untouched; only an explicit recovery replaces them, after
 * `preserveCorruptCatalog` has saved them. The detail never repeats the payload.
 */
export const catalogCorruptError = () =>
  new ConnectionTransientError({
    reason: "catalog-corrupt",
    detail: "The saved connection catalog could not be decoded. It was left unchanged.",
  });

/** True for the store error and for the persistence error that carries the same marker. */
export const isCatalogCorruptError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "_tag" in cause &&
  (cause._tag === "ConnectionTransientError" || cause._tag === "ConnectionPersistenceError") &&
  "reason" in cause &&
  cause.reason === "catalog-corrupt";

const MAX_BACKUP_SLOTS = 8;

function hash32(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Same payload, same id. Distinct payloads can collide, so callers compare stored bytes. */
export function corruptCatalogBackupId(raw: string): string {
  return `${raw.length.toString(36)}-${hash32(raw, 0x811c9dc5)}${hash32(raw, 0x9747b28c)}`;
}

export interface CorruptCatalogArchive<E> {
  readonly keyPrefix: string;
  /** `null` means the key is absent. A failed lookup must fail, never read as absent. */
  readonly get: (key: string) => Effect.Effect<string | null, E>;
  readonly set: (key: string, value: string) => Effect.Effect<void, E>;
  readonly failure: (detail: string) => E;
}

/**
 * Saves `raw` under a content-addressed key and returns the key once a read back matches. An
 * existing key with different bytes is never replaced; the next slot is used.
 */
export const preserveCorruptCatalog = Effect.fn("clientRuntime.preserveCorruptCatalog")(function* <
  E,
>(archive: CorruptCatalogArchive<E>, raw: string): Effect.fn.Return<string, E> {
  const id = corruptCatalogBackupId(raw);
  for (let slot = 0; slot < MAX_BACKUP_SLOTS; slot += 1) {
    const key = `${archive.keyPrefix}${id}${slot === 0 ? "" : `-${slot}`}`;
    const existing = yield* archive.get(key);
    if (existing === raw) return key;
    if (existing !== null) continue;
    yield* archive.set(key, raw);
    if ((yield* archive.get(key)) === raw) {
      yield* Effect.logWarning("Preserved an unreadable connection catalog.", {
        backup: key,
        bytes: raw.length,
      });
      return key;
    }
  }
  return yield* Effect.fail(
    archive.failure("The unreadable connection catalog could not be preserved."),
  );
});

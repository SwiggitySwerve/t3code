import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
  type CorruptCatalogArchive,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  catalogCorruptError,
  preserveCorruptCatalog,
} from "@t3tools/client-runtime/platform";
import { ConnectionTransientError } from "@t3tools/client-runtime/connection";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileSecureStorage from "../persistence/mobile-secure-storage";
import { migrateLegacyConnectionCatalog } from "./migration";

export const CONNECTION_CATALOG_KEY = "t3code.connection-catalog.v1";
export const LEGACY_CONNECTIONS_KEY = "t3code.connections";

function catalogError(operation: string, cause: unknown) {
  return new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: `Could not ${operation} the local connection catalog: ${String(cause)}`,
  });
}

const ConnectionCatalogDocumentJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeConnectionCatalogDocument = Schema.decodeEffect(ConnectionCatalogDocumentJson);
const encodeConnectionCatalogDocument = Schema.encodeEffect(ConnectionCatalogDocumentJson);

const encodeCatalog = Effect.fn("mobile.connectionStorage.encodeCatalog")(function* (
  catalog: ConnectionCatalogDocumentType,
) {
  return yield* encodeConnectionCatalogDocument(catalog).pipe(
    Effect.mapError((cause) => catalogError("encode", cause)),
  );
});

interface CatalogStore {
  readonly read: Effect.Effect<ConnectionCatalogDocumentType, ConnectionTransientError>;
  readonly update: (
    transform: (catalog: ConnectionCatalogDocumentType) => ConnectionCatalogDocumentType,
  ) => Effect.Effect<void, ConnectionTransientError>;
}

export const make = Effect.fn("mobile.connectionStorage.makeCatalogStore")(function* () {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const getItem = (key: string) =>
    storage.getItem(key).pipe(Effect.mapError((cause) => catalogError("load", cause)));
  const setItem = (key: string, value: string) =>
    storage.setItem(key, value).pipe(Effect.mapError((cause) => catalogError("save", cause)));
  const deleteItem = (key: string) =>
    storage.removeItem(key).pipe(Effect.mapError((cause) => catalogError("delete", cause)));
  const state = yield* Ref.make<Option.Option<ConnectionCatalogDocumentType>>(Option.none());
  const lock = yield* Semaphore.make(1);

  const loadLegacyCatalog = Effect.fn("mobile.connectionStorage.loadLegacyCatalog")(function* () {
    const legacyRaw = yield* getItem(LEGACY_CONNECTIONS_KEY);
    if (legacyRaw === null || legacyRaw.trim() === "") {
      return EMPTY_CONNECTION_CATALOG_DOCUMENT;
    }
    const catalog = yield* migrateLegacyConnectionCatalog(legacyRaw).pipe(
      Effect.catch(() =>
        Effect.logWarning("The legacy mobile connections could not be decoded.").pipe(
          Effect.andThen(Effect.fail(catalogCorruptError())),
        ),
      ),
    );
    const encoded = yield* encodeCatalog(catalog);
    yield* setItem(CONNECTION_CATALOG_KEY, encoded);
    yield* deleteItem(LEGACY_CONNECTIONS_KEY);
    return catalog;
  });

  const loadUnlocked = Effect.fn("mobile.connectionStorage.loadCatalog")(function* () {
    const cached = yield* Ref.get(state);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    const raw = yield* getItem(CONNECTION_CATALOG_KEY);
    let catalog: ConnectionCatalogDocumentType;
    if (raw !== null && raw.trim() !== "") {
      catalog = yield* decodeConnectionCatalogDocument(raw).pipe(
        Effect.catch(() =>
          Effect.logWarning("The saved mobile connection catalog could not be decoded.").pipe(
            Effect.andThen(Effect.fail(catalogCorruptError())),
          ),
        ),
      );
    } else {
      catalog = yield* loadLegacyCatalog();
    }
    yield* Ref.set(state, Option.some(catalog));
    return catalog;
  });
  const read = lock.withPermits(1)(loadUnlocked());
  const update: CatalogStore["update"] = Effect.fn("mobile.connectionStorage.updateCatalog")(
    function* (transform) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const next = transform(yield* loadUnlocked());
          const encoded = yield* encodeCatalog(next);
          yield* setItem(CONNECTION_CATALOG_KEY, encoded);
          yield* Ref.set(state, Option.some(next));
        }),
      );
    },
  );

  return { read, update } satisfies CatalogStore;
});

const archiveFor = (
  storage: MobileSecureStorage.MobileSecureStorage["Service"],
  keyPrefix: string,
): CorruptCatalogArchive<ConnectionTransientError> => ({
  keyPrefix,
  get: (key) => storage.getItem(key).pipe(Effect.mapError((cause) => catalogError("load", cause))),
  set: (key, value) =>
    storage.setItem(key, value).pipe(Effect.mapError((cause) => catalogError("save", cause))),
  failure: (detail) => catalogError("preserve", detail),
});

/**
 * The only path that discards an unreadable catalog. Every unreadable source is saved before any
 * is removed, and a source that still decodes is never touched. Runs without the connection
 * runtime, which cannot start while the catalog is unreadable.
 */
export const recover = Effect.fn("mobile.connectionStorage.recoverCatalog")(function* () {
  const storage = yield* MobileSecureStorage.MobileSecureStorage;
  const read = (key: string) =>
    storage.getItem(key).pipe(Effect.mapError((cause) => catalogError("load", cause)));
  const current = yield* read(CONNECTION_CATALOG_KEY);
  const currentPresent = current !== null && current.trim() !== "";
  const currentUnreadable =
    currentPresent &&
    (yield* decodeConnectionCatalogDocument(current).pipe(
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    ));
  if (currentPresent && !currentUnreadable) return false;

  const legacy = yield* read(LEGACY_CONNECTIONS_KEY);
  const legacyUnreadable =
    legacy !== null &&
    legacy.trim() !== "" &&
    (yield* migrateLegacyConnectionCatalog(legacy).pipe(
      Effect.as(false),
      Effect.catch(() => Effect.succeed(true)),
    ));

  const unreadable: Array<{ readonly key: string; readonly raw: string }> = [];
  if (currentUnreadable) unreadable.push({ key: CONNECTION_CATALOG_KEY, raw: current });
  if (legacyUnreadable) unreadable.push({ key: LEGACY_CONNECTIONS_KEY, raw: legacy });
  if (unreadable.length === 0) return false;

  for (const source of unreadable) {
    yield* preserveCorruptCatalog(archiveFor(storage, `${source.key}.corrupt.`), source.raw);
  }
  for (const source of unreadable) {
    yield* storage
      .removeItem(source.key)
      .pipe(Effect.mapError((cause) => catalogError("delete", cause)));
  }
  return true;
});

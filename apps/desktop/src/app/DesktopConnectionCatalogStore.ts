import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument as RuntimeConnectionCatalogDocument,
  type ConnectionCatalogDocument as RuntimeConnectionCatalogDocumentType,
  type CorruptCatalogArchive,
  preserveCorruptCatalog,
} from "@t3tools/client-runtime/platform";
import type {
  DesktopConnectionCatalogAccess,
  PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const encodeEncryptedConnectionCatalogDocumentJson = Schema.encodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const RuntimeConnectionCatalogDocumentJson = Schema.fromJsonString(
  RuntimeConnectionCatalogDocument,
);
const encodeRuntimeConnectionCatalogDocumentJson = Schema.encodeEffect(
  RuntimeConnectionCatalogDocumentJson,
);

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
  "preserve-catalog-file",
  "remove-catalog-file",
]);

const DesktopConnectionCatalogStoreMigrationOperation = Schema.Literals([
  "read-legacy-registry",
  "read-legacy-secret",
  "encode-catalog",
  "persist-catalog",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedError<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedError<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Schema.TaggedError<DesktopConnectionCatalogStoreMigrationError>()(
  "DesktopConnectionCatalogStoreMigrationError",
  {
    operation: DesktopConnectionCatalogStoreMigrationOperation,
    catalogPath: Schema.String,
    environmentId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    return `Legacy desktop saved-environment migration failed during ${this.operation}${environment} into ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedError<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

export type DesktopConnectionCatalogStoreSetError =
  | DesktopConnectionCatalogStoreWriteError
  | DesktopConnectionCatalogStoreReadError
  | DesktopConnectionCatalogStoreDocumentDecodeError
  | DesktopConnectionCatalogStoreDecodeError
  | DesktopConnectionCatalogStoreProtectionError;

export type DesktopConnectionCatalogStoreClearError =
  | DesktopConnectionCatalogStoreWriteError
  | DesktopConnectionCatalogStoreReadError;

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    /**
     * Succeeds with none, and refuses later writes, while secure storage is unavailable and a
     * catalog is stored: the app keeps running without its saved connections and leaves the file.
     */
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<boolean, DesktopConnectionCatalogStoreSetError>;
    /**
     * Fresh check, so it does not depend on `get` having run. When the app started without its
     * stored catalog and secure storage has returned, this reads the catalog again, which lifts
     * the write block.
     */
    readonly access: Effect.Effect<
      DesktopConnectionCatalogAccess,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    /** Keeps a copy of the encrypted file before removing it. */
    readonly clear: Effect.Effect<void, DesktopConnectionCatalogStoreClearError>;
  }
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Base64.decode(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<EncryptedConnectionCatalogDocument>,
  DesktopConnectionCatalogStoreReadError | DesktopConnectionCatalogStoreDocumentDecodeError
> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopConnectionCatalogStoreReadError({
              catalogPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<EncryptedConnectionCatalogDocument>())
        : decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(
            Effect.asSome,
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath,
                  cause,
                }),
            ),
          ),
    ),
  );

const replaceFile = Effect.fn("desktop.connectionCatalogStore.replaceFile")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly targetPath: string;
  readonly contents: string;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const directory = input.path.dirname(input.targetPath);
  const tempPath = `${input.targetPath}.${process.pid}.${input.suffix}.tmp`;
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, input.targetPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "replace-catalog-file",
            path: input.targetPath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      input.fileSystem.remove(tempPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a temporary connection catalog file.", {
            tempPath,
            error,
          }),
        ),
      ),
    ),
  );
});

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: input.catalogPath,
          cause,
        }),
    ),
  );
  yield* replaceFile({
    fileSystem: input.fileSystem,
    path: input.path,
    targetPath: input.catalogPath,
    contents: `${encoded}\n`,
    suffix: input.suffix,
  });
});
function connectionId(prefix: "bearer" | "ssh", environmentId: string): string {
  return `${prefix}:${environmentId}`;
}

const migrateSavedEnvironmentRecords = Effect.fn(
  "desktop.connectionCatalogStore.migrateSavedEnvironmentRecords",
)(function* (
  records: readonly PersistedSavedEnvironmentRecord[],
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironments["Service"],
  catalogPath: string,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopConnectionCatalogStoreMigrationError
> {
  const targets: Array<RuntimeConnectionCatalogDocumentType["targets"][number]> = [];
  const profiles: Array<RuntimeConnectionCatalogDocumentType["profiles"][number]> = [];
  const credentials: Array<RuntimeConnectionCatalogDocumentType["credentials"][number]> = [];

  for (const record of records) {
    if (record.relayManaged !== undefined) {
      targets.push(
        new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      );
      continue;
    }

    if (record.desktopSsh !== undefined) {
      const id = connectionId("ssh", record.environmentId);
      targets.push(
        new SshConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
          connectionId: id,
        }),
      );
      profiles.push(
        new SshConnectionProfile({
          connectionId: id,
          environmentId: record.environmentId,
          label: record.label,
          target: record.desktopSsh,
        }),
      );
      continue;
    }

    const id = connectionId("bearer", record.environmentId);
    targets.push(
      new BearerConnectionTarget({
        environmentId: record.environmentId,
        label: record.label,
        connectionId: id,
      }),
    );
    profiles.push(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
      }),
    );
    const token = yield* savedEnvironments.getSecret(record.environmentId).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-secret",
            catalogPath,
            environmentId: record.environmentId,
            cause,
          }),
      ),
    );
    if (Option.isSome(token)) {
      credentials.push({
        connectionId: id,
        credential: new BearerConnectionCredential({ token: token.value }),
      });
    }
  }

  return {
    schemaVersion: 1,
    targets,
    profiles,
    credentials,
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  };
});

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    const encryptedCatalog = Base64.encode(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
    const suffix = (yield* crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replace(/-/g, "");
    yield* writeDocument({
      fileSystem,
      path,
      catalogPath,
      document: { version: 1, encryptedCatalog },
      suffix,
    });
  });

  const migrateLegacyCatalog = Effect.gen(function* () {
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const records = yield* savedEnvironments.getRegistry.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-registry",
            catalogPath,
            cause,
          }),
      ),
    );
    if (records.length === 0) {
      return Option.none<string>();
    }
    const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments, catalogPath);
    const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "encode-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    yield* writeCatalog(encoded).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "persist-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    return Option.some(encoded);
  });

  // Set while the app runs from an empty catalog because the stored one could not be read. A write
  // then would replace the stored catalog with that empty one, even after secure storage returns.
  // It is process-wide and any read clears it, which assumes one renderer reads the catalog (the
  // single main window). A second reader would let the first write its stale empty catalog.
  const startedWithoutStoredCatalog = yield* Ref.make(false);
  const clearLock = yield* Semaphore.make(1);

  // Three outcomes, so that only a missing file leads to migration: a stored file that cannot be
  // read must never be replaced by one built from the legacy registry.
  type StoredCatalog =
    | { readonly _tag: "absent" }
    | { readonly _tag: "unavailable" }
    | { readonly _tag: "value"; readonly catalog: string };

  const readStoredCatalog: Effect.Effect<
    StoredCatalog,
    | DesktopConnectionCatalogStoreReadError
    | DesktopConnectionCatalogStoreDocumentDecodeError
    | DesktopConnectionCatalogStoreDecodeError
    | DesktopConnectionCatalogStoreProtectionError
  > = Effect.gen(function* () {
    const document = yield* readDocument(fileSystem, catalogPath);
    if (Option.isNone(document)) {
      yield* Ref.set(startedWithoutStoredCatalog, false);
      return { _tag: "absent" as const };
    }
    const unavailable = !(yield* encryptionAvailable);
    yield* Ref.set(startedWithoutStoredCatalog, unavailable);
    if (unavailable) {
      return { _tag: "unavailable" as const };
    }
    const decrypted = yield* decodeSecretBytes(catalogPath, document.value.encryptedCatalog).pipe(
      Effect.flatMap((encryptedCatalog) =>
        safeStorage.decryptString(encryptedCatalog).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopConnectionCatalogStoreProtectionError({
                operation: "decrypt-catalog",
                catalogPath,
                cause,
              }),
          ),
        ),
      ),
    );
    return { _tag: "value" as const, catalog: decrypted };
  });

  const backupPath = (key: string) => path.join(environment.stateDir, `${key}.json`);
  const backupFailure = (cause: unknown) =>
    new DesktopConnectionCatalogStoreWriteError({
      operation: "preserve-catalog-file",
      path: catalogPath,
      cause,
    });
  // The copies are the encrypted file bytes as stored, never decrypted text.
  const backups: CorruptCatalogArchive<DesktopConnectionCatalogStoreWriteError> = {
    keyPrefix: "connection-catalog.corrupt-",
    get: (key) =>
      fileSystem
        .readFileString(backupPath(key))
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed<string | null>(null)
              : Effect.fail(backupFailure(error)),
          ),
        ),
    set: (key, value) =>
      crypto.randomUUIDv4().pipe(
        Effect.mapError(backupFailure),
        Effect.flatMap((uuid) =>
          replaceFile({
            fileSystem,
            path,
            targetPath: backupPath(key),
            contents: value,
            suffix: uuid.replace(/-/g, ""),
          }),
        ),
      ),
    failure: backupFailure,
  };

  return DesktopConnectionCatalogStore.of({
    get: readStoredCatalog.pipe(
      Effect.flatMap((stored) => {
        switch (stored._tag) {
          case "absent":
            return migrateLegacyCatalog;
          case "unavailable":
            return Effect.succeed(Option.none<string>());
          case "value":
            return Effect.succeed(Option.some(stored.catalog));
        }
      }),
      Effect.withSpan("desktop.connectionCatalogStore.get"),
    ),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      if (!(yield* encryptionAvailable) || (yield* Ref.get(startedWithoutStoredCatalog))) {
        return false;
      }
      // A file that cannot be read back is evidence; refuse to replace it. `clear` is the reset.
      yield* readStoredCatalog;
      yield* writeCatalog(catalog);
      return true;
    }),
    access: Effect.gen(function* () {
      if (yield* Ref.get(startedWithoutStoredCatalog)) {
        // The only place the block is lifted without `get`: the same read, run again.
        const stored = yield* readStoredCatalog;
        return stored._tag === "unavailable"
          ? ("secure-storage-unavailable" as const)
          : ("ok" as const);
      }
      if (yield* encryptionAvailable) {
        return "ok" as const;
      }
      const stored = yield* fileSystem
        .exists(catalogPath)
        .pipe(
          Effect.mapError(
            (cause) => new DesktopConnectionCatalogStoreReadError({ catalogPath, cause }),
          ),
        );
      return stored ? ("secure-storage-unavailable" as const) : ("ok" as const);
    }),
    clear: clearLock
      .withPermits(1)(
        Effect.gen(function* () {
          const stored = yield* fileSystem
            .readFileString(catalogPath)
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "NotFound"
                  ? Effect.succeed<string | null>(null)
                  : Effect.fail(
                      new DesktopConnectionCatalogStoreReadError({ catalogPath, cause: error }),
                    ),
              ),
            );
          if (stored !== null) {
            yield* preserveCorruptCatalog(backups, stored);
          }
          yield* fileSystem.remove(catalogPath, { force: true }).pipe(
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreWriteError({
                  operation: "remove-catalog-file",
                  path: catalogPath,
                  cause,
                }),
            ),
          );
        }),
      )
      .pipe(Effect.withSpan("desktop.connectionCatalogStore.clear")),
  });
});
export const layer = Layer.effect(DesktopConnectionCatalogStore, make);

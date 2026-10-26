import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ConnectionCatalogDocument,
  corruptCatalogBackupId,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
/** Answers each availability check from `answers` in turn, then repeats the last one. */
const availabilitySequence = (answers: readonly [boolean, ...boolean[]]) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    return Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(calls, (count) => count + 1);
      return answers[Math.min(index, answers.length - 1)]!;
    });
  });

type Availability = boolean | Ref.Ref<boolean> | Effect.Effect<boolean>;

function layerSafeStorageFor(available: Availability, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable:
      typeof available === "boolean"
        ? Effect.succeed(available)
        : Effect.isEffect(available)
          ? available
          : Ref.get(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(
  baseDir: string,
  encryptionAvailable: Availability = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const layerSafeStorage = layerSafeStorageFor(encryptionAvailable, failDecrypt);
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    NodeServices.layer,
    fileSystemLayer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists, reads, and clears an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));

        yield* store.clear;
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isTrue(Option.isSome(migrated));
        if (Option.isNone(migrated)) {
          return;
        }
        const catalog = yield* decodeConnectionCatalog(migrated.value);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("refuses to replace a catalog file that can no longer be decoded", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        yield* store.set('{"schemaVersion":1,"targets":[]}').pipe(Effect.flip);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("keeps the stored bytes when a replacement races a failing decrypt", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true, failDecrypt)),
      );
      const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      const original = yield* fileSystem.readFileString(catalogPath);
      yield* Ref.set(failDecrypt, true);
      yield* store.set('{"schemaVersion":1,"targets":["new"]}').pipe(Effect.flip);

      assert.equal(yield* fileSystem.readFileString(catalogPath), original);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("replaces a readable catalog and still lets clear reset a corrupt one", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");

        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":["next"]}'));
        assert.deepStrictEqual(
          yield* store.get,
          Option.some('{"schemaVersion":1,"targets":["next"]}'),
        );

        yield* fileSystem.writeFileString(catalogPath, "{not-json");
        yield* store.clear;
        assert.isFalse(yield* fileSystem.exists(catalogPath));
        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      }),
    ),
  );

  it.effect(
    "leaves a stored catalog alone and reports why while secure storage is unavailable",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const writer = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, true)),
        );
        assert.isTrue(yield* writer.set('{"schemaVersion":1,"targets":[]}'));
        const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
        const stored = yield* fileSystem.readFileString(catalogPath);
        const locked = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, false)),
        );

        // The read succeeds, so the rest of the app, including the local environment, keeps working.
        assert.deepStrictEqual(yield* locked.get, Option.none());
        assert.equal(yield* locked.access, "secure-storage-unavailable");
        assert.isFalse(yield* locked.set('{"schemaVersion":1,"targets":["new"]}'));
        assert.equal(yield* fileSystem.readFileString(catalogPath), stored);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never replaces a stored catalog with a migrated legacy one", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const writer = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true)),
      );
      assert.isTrue(yield* writer.set('{"schemaVersion":1,"targets":["saved"]}'));
      const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
      const stored = yield* fileSystem.readFileString(catalogPath);
      yield* fileSystem.writeFileString(
        path.join(baseDir, "userdata", "saved-environments.json"),
        yield* encodeLegacySavedEnvironments({
          version: 1,
          records: [
            {
              environmentId: EnvironmentId.make("relay-environment"),
              label: "Relay",
              httpBaseUrl: "https://relay.example.com/",
              wsBaseUrl: "wss://relay.example.com/",
              createdAt: "2026-06-01T00:00:00.000Z",
              lastConnectedAt: null,
              relayManaged: { relayUrl: "https://relay-control.example.com/" },
            },
          ],
        }),
      );
      // Secure storage is down when the stored file is read and back by the time a migration
      // would check it again.
      const flaky = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, yield* availabilitySequence([false, true]))),
      );

      assert.deepStrictEqual(yield* flaky.get, Option.none());
      assert.equal(yield* fileSystem.readFileString(catalogPath), stored);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a write when its own re-read finds secure storage unavailable", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const writer = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true)),
      );
      assert.isTrue(yield* writer.set('{"schemaVersion":1,"targets":["saved"]}'));
      const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
      const stored = yield* fileSystem.readFileString(catalogPath);
      // Available at the start of the write, gone when it re-reads the file, back before it would
      // encrypt: the write must still be refused.
      const flaky = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, yield* availabilitySequence([true, false, true]))),
      );

      assert.isFalse(yield* flaky.set('{"schemaVersion":1,"targets":["new"]}'));
      assert.equal(yield* fileSystem.readFileString(catalogPath), stored);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("does not report a problem when no catalog is stored or secure storage works", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const locked = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, false)),
      );
      assert.equal(yield* locked.access, "ok");
      const open = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true)),
      );
      assert.isTrue(yield* open.set('{"schemaVersion":1,"targets":[]}'));
      assert.equal(yield* open.access, "ok");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "keeps refusing writes after secure storage returns until the catalog is read again",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const available = yield* Ref.make(true);
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, available)),
        );
        const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":["saved"]}'));
        const stored = yield* fileSystem.readFileString(catalogPath);

        yield* Ref.set(available, false);
        assert.deepStrictEqual(yield* store.get, Option.none());
        // The app started from an empty catalog. A write now would replace the saved one with it.
        yield* Ref.set(available, true);
        assert.isFalse(yield* store.set('{"schemaVersion":1,"targets":[]}'));
        assert.equal(yield* fileSystem.readFileString(catalogPath), stored);

        assert.deepStrictEqual(
          yield* store.get,
          Option.some('{"schemaVersion":1,"targets":["saved"]}'),
        );
        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":["next"]}'));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("lifts the write block when the access check finds secure storage back", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const available = yield* Ref.make(true);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, available)),
      );
      const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":["saved"]}'));
      const stored = yield* fileSystem.readFileString(catalogPath);

      yield* Ref.set(available, false);
      assert.deepStrictEqual(yield* store.get, Option.none());
      // Still down: the check says so and keeps the block.
      assert.equal(yield* store.access, "secure-storage-unavailable");
      assert.isFalse(yield* store.set('{"schemaVersion":1,"targets":[]}'));

      yield* Ref.set(available, true);
      assert.equal(yield* store.access, "ok");
      assert.equal(yield* fileSystem.readFileString(catalogPath), stored);
      // The check read the catalog again, so no reload is needed before saving.
      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":["next"]}'));
      assert.deepStrictEqual(
        yield* store.get,
        Option.some('{"schemaVersion":1,"targets":["next"]}'),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("copies the encrypted bytes before clear removes the catalog", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        const secretCatalog = '{"schemaVersion":1,"credentials":["plaintext-secret"]}';
        assert.isTrue(yield* store.set(secretCatalog));
        const stored = yield* fileSystem.readFileString(catalogPath);

        yield* Effect.all([store.clear, store.clear], { concurrency: "unbounded" });
        yield* store.clear;

        assert.isFalse(yield* fileSystem.exists(catalogPath));
        const backups = (yield* fileSystem.readDirectory(environment.stateDir)).filter((name) =>
          name.startsWith("connection-catalog.corrupt-"),
        );
        assert.deepStrictEqual(backups, [
          `connection-catalog.corrupt-${corruptCatalogBackupId(stored)}.json`,
        ]);
        const copy = yield* fileSystem.readFileString(path.join(environment.stateDir, backups[0]!));
        assert.equal(copy, stored);
        assert.notInclude(copy, "plaintext-secret");
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("keeps the catalog when its encrypted copy cannot be saved", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
        const stored = yield* fileSystem.readFileString(catalogPath);
        // A directory where the copy belongs makes the lookup fail, which must not read as absent.
        yield* fileSystem.makeDirectory(
          path.join(
            environment.stateDir,
            `connection-catalog.corrupt-${corruptCatalogBackupId(stored)}.json`,
          ),
        );

        const error = yield* store.clear.pipe(Effect.flip);

        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
        );
        assert.equal(yield* fileSystem.readFileString(catalogPath), stored);
      }),
    ),
  );
  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = layerFor(baseDir, true, failDecrypt);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

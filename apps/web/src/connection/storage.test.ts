import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ConnectionCatalogDocument, Persistence } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect.each([
    ["unparseable JSON", '{"credentials":[{"token":"secret-token"'],
    ["a document that fails the catalog schema", '{"schemaVersion":2,"targets":[]}'],
  ] as const)("keeps a catalog with %s intact and refuses writes over it", ([, corrupt]) =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(corrupt),
        write: (raw) => Effect.sync(() => writes.push(raw)),
      });

      const readError = yield* Effect.flip(store.read);
      expect(readError.detail).toContain("decode");
      // A second load must fail again instead of serving a cached empty document.
      yield* Effect.flip(store.read);
      yield* Effect.flip(store.update((document) => document));
      yield* Effect.all(
        [
          Effect.flip(store.read),
          Effect.flip(store.update((document) => document)),
          Effect.flip(store.read),
        ],
        { concurrency: "unbounded" },
      );

      expect(writes).toEqual([]);
    }),
  );

  it.effect("does not log the catalog payload when decoding fails", () =>
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed('{"credentials":[{"token":"secret-token"'),
        write: () => Effect.void,
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make((options) => {
              logs.push(options.message);
            }),
          ]),
        ),
      );
      yield* Effect.flip(store.read);
      expect(JSON.stringify(logs)).not.toContain("secret-token");
    }),
  );

  it.effect("keeps a corrupt desktop catalog untouched instead of writing an empty one", () =>
    Effect.gen(function* () {
      const bridge = {
        getConnectionCatalog: vi.fn(() => Promise.resolve("{not-json")),
        setConnectionCatalog: vi.fn(() => Promise.resolve(true)),
        clearConnectionCatalog: vi.fn(() => Promise.resolve()),
      };
      vi.stubGlobal("window", { desktopBridge: bridge });
      const store = yield* ConnectionStorage.makeCatalogStore(
        ConnectionStorage.makeCatalogBackend(
          fixedHandle({ transaction: () => undefined } as unknown as IDBDatabase),
        ),
      );

      yield* Effect.flip(store.read);
      yield* Effect.flip(store.update((document) => document));

      expect(bridge.setConnectionCatalog).not.toHaveBeenCalled();
      expect(bridge.clearConnectionCatalog).not.toHaveBeenCalled();
    }),
  );

  it.effect("keeps serving an empty catalog while desktop secure storage is unavailable", () =>
    Effect.gen(function* () {
      const bridge = {
        getConnectionCatalog: vi.fn(() => Promise.resolve(null)),
        setConnectionCatalog: vi.fn(() => Promise.resolve(false)),
        getConnectionCatalogAccess: vi.fn(() =>
          Promise.resolve("secure-storage-unavailable" as const),
        ),
      };
      vi.stubGlobal("window", { desktopBridge: bridge });
      const store = yield* ConnectionStorage.makeCatalogStore(
        ConnectionStorage.makeCatalogBackend(
          fixedHandle({ transaction: () => undefined } as unknown as IDBDatabase),
        ),
      );

      // The runtime builds, so the local environment is available; nothing marks it as corrupt.
      expect(yield* store.read).toEqual(emptyCatalog);
      const writeError = yield* Effect.flip(store.update((document) => document));
      expect(writeError.reason).not.toBe("catalog-corrupt");
      expect(yield* ConnectionStorage.readCatalogAccess).toBe("secure-storage-unavailable");
    }),
  );

  it.effect("reads the catalog access as ok when the host cannot say otherwise", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      expect(yield* ConnectionStorage.readCatalogAccess).toBe("ok");
      vi.stubGlobal("window", { desktopBridge: {} });
      expect(yield* ConnectionStorage.readCatalogAccess).toBe("ok");
    }),
  );
  it.effect(
    "starts a desktop update from the catalog the desktop holds now, not the one loaded",
    () =>
      Effect.gen(function* () {
        const saved = JSON.stringify({ ...emptyCatalog, disabledEnvironmentIds: ["env-saved"] });
        const written: string[] = [];
        // The window loaded while secure storage was down, so it holds an empty catalog. By the
        // time of the update the desktop can read the saved one again.
        const bridge = {
          getConnectionCatalog: vi
            .fn<() => Promise<string | null>>()
            .mockResolvedValueOnce(null)
            .mockResolvedValue(saved),
          setConnectionCatalog: vi.fn((raw: string) => {
            written.push(raw);
            return Promise.resolve(true);
          }),
        };
        vi.stubGlobal("window", { desktopBridge: bridge });
        const store = yield* ConnectionStorage.makeCatalogStore(
          ConnectionStorage.makeCatalogBackend(
            fixedHandle({ transaction: () => undefined } as unknown as IDBDatabase),
          ),
        );

        expect(yield* store.read).toEqual(emptyCatalog);
        yield* store.update((document) => ({
          ...document,
          disabledEnvironmentIds: [
            ...document.disabledEnvironmentIds,
            EnvironmentId.make("env-new"),
          ],
        }));

        expect(written).toHaveLength(1);
        expect(decodeCatalog(written[0]!).disabledEnvironmentIds).toEqual(["env-saved", "env-new"]);
      }),
  );

  it.effect("writes nothing when the fresh read before a desktop update fails", () =>
    Effect.gen(function* () {
      const written: string[] = [];
      const bridge = {
        getConnectionCatalog: vi
          .fn<() => Promise<string | null>>()
          .mockResolvedValueOnce(null)
          .mockRejectedValue(new Error("desktop unreachable")),
        setConnectionCatalog: vi.fn((raw: string) => {
          written.push(raw);
          return Promise.resolve(true);
        }),
      };
      vi.stubGlobal("window", { desktopBridge: bridge });
      const store = yield* ConnectionStorage.makeCatalogStore(
        ConnectionStorage.makeCatalogBackend(
          fixedHandle({ transaction: () => undefined } as unknown as IDBDatabase),
        ),
      );

      expect(yield* store.read).toEqual(emptyCatalog);
      yield* Effect.flip(
        store.update((document) => ({
          ...document,
          disabledEnvironmentIds: [EnvironmentId.make("env-new")],
        })),
      );

      expect(written).toEqual([]);
    }),
  );

  it.effect("loads an older valid catalog without optional fields unchanged", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          JSON.stringify({
            schemaVersion: 1,
            targets: [],
            profiles: [],
            credentials: [],
            remoteDpopTokens: [],
          }),
        ),
        write: (raw) => Effect.sync(() => writes.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(writes).toEqual([]);
    }),
  );
  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserPullRequestRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserPullRequestRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserPullRequestRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});

function memoryDatabase(
  initial: Readonly<Record<string, unknown>>,
  options: {
    readonly failPut?: (key: string) => boolean;
    readonly failGet?: boolean;
  } = {},
) {
  const values = new Map(Object.entries(initial));
  const database = Object.assign(new EventTarget(), {
    close: vi.fn(),
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          get: (key: string) => {
            const request = Object.assign(new EventTarget(), {
              result: values.get(key),
              error: options.failGet ? new DOMException("Locked", "UnknownError") : null,
            });
            queueMicrotask(() =>
              request.dispatchEvent(new Event(options.failGet ? "error" : "success")),
            );
            return request;
          },
          put: (value: unknown, key: string) => {
            queueMicrotask(() => {
              if (options.failPut?.(key)) {
                transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
                transaction.dispatchEvent(new Event("abort"));
                return;
              }
              values.set(key, value);
              transaction.dispatchEvent(new Event("complete"));
            });
          },
        }),
      });
      return transaction;
    },
  });
  return { database: database as unknown as IDBDatabase, values };
}

const corruptWithSecret = '{"credentials":[{"token":"secret-token"';

describe("ConnectionStorage.recoverCorruptCatalog", () => {
  it.effect("saves the exact bytes first, then resets so a fresh store works", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const memory = memoryDatabase({ document: corruptWithSecret });
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(memory.database));

      expect(yield* ConnectionStorage.recoverCorruptCatalog(backend)).toBe(true);

      const backups = [...memory.values.entries()].filter(([key]) =>
        key.startsWith("document:corrupt:"),
      );
      expect(backups.map(([, value]) => value)).toEqual([corruptWithSecret]);
      expect(decodeCatalog(memory.values.get("document") as string)).toEqual(emptyCatalog);
      const fresh = yield* ConnectionStorage.makeCatalogStore(
        ConnectionStorage.makeCatalogBackend(fixedHandle(memory.database)),
      );
      expect(yield* fresh.read).toEqual(emptyCatalog);
      yield* fresh.update((document) => ({
        ...document,
        disabledEnvironmentIds: [EnvironmentId.make("added-after-reset")],
      }));
      const reopened = yield* ConnectionStorage.makeCatalogStore(
        ConnectionStorage.makeCatalogBackend(fixedHandle(memory.database)),
      );
      expect((yield* reopened.read).disabledEnvironmentIds).toEqual(["added-after-reset"]);
      expect(backups).toHaveLength(1);
    }),
  );

  it.effect("keeps the unreadable catalog when the backup cannot be written", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const memory = memoryDatabase(
        { document: corruptWithSecret },
        { failPut: (key) => key.startsWith("document:corrupt:") },
      );
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(memory.database));

      const error = yield* Effect.flip(ConnectionStorage.recoverCorruptCatalog(backend));

      expect(error.message).toContain("QuotaExceededError");
      expect(error.message).not.toContain("secret-token");
      expect(memory.values.get("document")).toBe(corruptWithSecret);
    }),
  );

  it.effect("refuses to replace a malformed saved copy", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const memory = memoryDatabase({ document: corruptWithSecret });
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(memory.database));
      yield* ConnectionStorage.recoverCorruptCatalog(backend);
      memory.values.set("document", corruptWithSecret);
      const backupKey = [...memory.values.keys()].find((key) =>
        key.startsWith("document:corrupt:"),
      )!;
      memory.values.set(backupKey, { not: "a string" });

      yield* Effect.flip(ConnectionStorage.recoverCorruptCatalog(backend));

      expect(memory.values.get("document")).toBe(corruptWithSecret);
      expect(memory.values.get(backupKey)).toEqual({ not: "a string" });
    }),
  );

  it.effect("does nothing for a healthy, empty, or unreadable-for-other-reasons catalog", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      for (const stored of [undefined, "", "   ", encodeCatalog(emptyCatalog)]) {
        const memory = memoryDatabase(stored === undefined ? {} : { document: stored });
        const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(memory.database));
        expect(yield* ConnectionStorage.recoverCorruptCatalog(backend)).toBe(false);
        expect(memory.values.get("document")).toBe(stored);
      }
      const locked = memoryDatabase({ document: corruptWithSecret }, { failGet: true });
      yield* Effect.flip(
        ConnectionStorage.recoverCorruptCatalog(
          ConnectionStorage.makeCatalogBackend(fixedHandle(locked.database)),
        ),
      );
      expect(locked.values.get("document")).toBe(corruptWithSecret);
    }),
  );

  it.effect("resets the desktop catalog through the bridge only while it is unreadable", () =>
    Effect.gen(function* () {
      let stored = corruptWithSecret;
      const clear = vi.fn(() => {
        stored = "";
        return Promise.resolve();
      });
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: () => Promise.resolve(stored === "" ? null : stored),
          setConnectionCatalog: () => Promise.resolve(true),
          clearConnectionCatalog: clear,
        },
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => undefined } as unknown as IDBDatabase),
      );

      expect(yield* ConnectionStorage.recoverCorruptCatalog(backend)).toBe(true);
      expect(yield* ConnectionStorage.recoverCorruptCatalog(backend)).toBe(false);
      expect(clear).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("surfaces a failed desktop reset", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: () => Promise.resolve(corruptWithSecret),
          setConnectionCatalog: () => Promise.resolve(true),
          clearConnectionCatalog: () => Promise.reject(new Error("could not preserve")),
        },
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => undefined } as unknown as IDBDatabase),
      );

      const error = yield* Effect.flip(ConnectionStorage.recoverCorruptCatalog(backend));

      expect(error.message).toContain("could not preserve");
    }),
  );
});

describe("ConnectionStorage persistence errors", () => {
  it.effect.each([
    ["an unreadable catalog", { document: corruptWithSecret }, {}, "catalog-corrupt"],
    ["a locked database", { document: corruptWithSecret }, { failGet: true }, undefined],
  ] as const)("marks %s only when it failed to decode", ([, initial, options, reason]) =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const memory = memoryDatabase(initial, options);
      vi.stubGlobal("indexedDB", {
        open: () => {
          const request = Object.assign(new EventTarget(), {
            result: memory.database,
            error: null,
          });
          queueMicrotask(() => request.dispatchEvent(new Event("success")));
          return request;
        },
      });

      const error = yield* Effect.gen(function* () {
        const targets = yield* Persistence.ConnectionTargetStore;
        return yield* Effect.flip(targets.list);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain("secret-token");
    }),
  );
});

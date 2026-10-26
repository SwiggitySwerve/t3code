import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

vi.mock("expo-secure-store", () => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

import { CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY, make, recover } from "./catalog-store";
import * as MobileSecureStorage from "../persistence/mobile-secure-storage";

function makeStorage(initial: Readonly<Record<string, string>>) {
  const values = new Map(Object.entries(initial));
  const deleted: Array<string> = [];
  const writes: Array<string> = [];
  const storage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: (key) => Effect.sync(() => values.get(key) ?? null),
    setItem: (key, value) =>
      Effect.sync(() => {
        writes.push(key);
        values.set(key, value);
      }),
    removeItem: (key) =>
      Effect.sync(() => {
        deleted.push(key);
        values.delete(key);
      }),
  });
  return { deleted, storage, values, writes };
}

const validLegacy = JSON.stringify({
  connections: [
    {
      environmentId: "legacy-environment",
      environmentLabel: "Legacy",
      pairingUrl: "https://legacy.example.test/pair",
      displayUrl: "https://legacy.example.test",
      httpBaseUrl: "https://legacy.example.test",
      wsBaseUrl: "wss://legacy.example.test",
      bearerToken: "legacy-token",
      authenticationMethod: "bearer",
    },
  ],
});

describe("mobile connection catalog storage", () => {
  it.effect("keeps a corrupt current catalog intact and refuses to treat it as empty", () =>
    Effect.gen(function* () {
      const corrupt = '{"credentials":[{"token":"secret-token"';
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: corrupt });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      const readError = yield* Effect.flip(catalog.read);
      expect(readError.detail).toContain("decode");
      // A second load must fail again instead of serving a cached empty document.
      yield* Effect.flip(catalog.read);
      yield* Effect.flip(catalog.update((document) => document));
      yield* Effect.all(
        [
          Effect.flip(catalog.read),
          Effect.flip(catalog.update((document) => document)),
          Effect.flip(catalog.read),
        ],
        { concurrency: "unbounded" },
      );

      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(corrupt);
      expect(memory.deleted).toEqual([]);
      expect(memory.writes).toEqual([]);
    }),
  );

  it.effect("keeps a corrupt legacy catalog intact", () =>
    Effect.gen(function* () {
      const corruptLegacy = JSON.stringify({ connections: [{ invalid: true }] });
      const memory = makeStorage({ [LEGACY_CONNECTIONS_KEY]: corruptLegacy });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      yield* Effect.flip(catalog.read);
      yield* Effect.flip(catalog.update((document) => document));

      expect(memory.values.get(LEGACY_CONNECTIONS_KEY)).toBe(corruptLegacy);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(false);
      expect(memory.deleted).toEqual([]);
      expect(memory.writes).toEqual([]);
    }),
  );

  it.effect("does not migrate valid legacy data over a corrupt current catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: validLegacy,
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      yield* Effect.flip(catalog.read);

      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe("{not-json");
      expect(memory.values.get(LEGACY_CONNECTIONS_KEY)).toBe(validLegacy);
      expect(memory.deleted).toEqual([]);
      expect(memory.writes).toEqual([]);
    }),
  );

  it.effect("surfaces storage read failures instead of an empty catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({});
      const failing = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        getItem: () => Effect.fail(new Error("keychain locked") as never),
      });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, failing),
      );

      const error = yield* Effect.flip(catalog.read);
      expect(error.detail).toContain("load");
      yield* Effect.flip(catalog.update((document) => document));
      expect(memory.writes).toEqual([]);
    }),
  );

  it.effect("still migrates valid legacy data when no current catalog exists", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [LEGACY_CONNECTIONS_KEY]: validLegacy });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).targets).toHaveLength(1);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(true);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
      expect(memory.deleted).toEqual([LEGACY_CONNECTIONS_KEY]);
    }),
  );

  it.effect("reads and updates a valid current catalog unchanged", () =>
    Effect.gen(function* () {
      const valid = JSON.stringify({
        schemaVersion: 1,
        targets: [],
        profiles: [],
        credentials: [],
        remoteDpopTokens: [],
      });
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: valid });
      const catalog = yield* make().pipe(
        Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage),
      );

      expect((yield* catalog.read).disabledEnvironmentIds).toEqual([]);
      yield* catalog.update((document) => ({ ...document, disabledEnvironmentIds: [] }));
      expect(memory.writes).toHaveLength(1);
      expect(memory.deleted).toEqual([]);
    }),
  );
});

describe("mobile connection catalog recovery", () => {
  const corruptWithSecret = '{"credentials":[{"token":"secret-token"';
  const provide = (memory: ReturnType<typeof makeStorage>) =>
    Effect.provideService(MobileSecureStorage.MobileSecureStorage, memory.storage);
  const backupsOf = (memory: ReturnType<typeof makeStorage>, key: string) =>
    [...memory.values.entries()].filter(([name]) => name.startsWith(`${key}.corrupt.`));

  it.effect("saves the current catalog first, then resets so a fresh store works", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: corruptWithSecret });

      expect(yield* recover().pipe(provide(memory))).toBe(true);

      expect(backupsOf(memory, CONNECTION_CATALOG_KEY).map(([, value]) => value)).toEqual([
        corruptWithSecret,
      ]);
      expect(memory.values.has(CONNECTION_CATALOG_KEY)).toBe(false);
      const fresh = yield* make().pipe(provide(memory));
      expect((yield* fresh.read).targets).toEqual([]);
      yield* fresh.update((document) => ({
        ...document,
        disabledEnvironmentIds: [EnvironmentId.make("added-after-reset")],
      }));
      const reopened = yield* make().pipe(provide(memory));
      expect((yield* reopened.read).disabledEnvironmentIds).toEqual(["added-after-reset"]);
    }),
  );

  it.effect("keeps valid legacy data reachable after a corrupt current catalog is reset", () =>
    Effect.gen(function* () {
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: "{not-json",
        [LEGACY_CONNECTIONS_KEY]: validLegacy,
      });

      yield* recover().pipe(provide(memory));

      expect(memory.values.get(LEGACY_CONNECTIONS_KEY)).toBe(validLegacy);
      const fresh = yield* make().pipe(provide(memory));
      expect((yield* fresh.read).targets).toHaveLength(1);
    }),
  );

  it.effect("saves and removes a corrupt legacy catalog", () =>
    Effect.gen(function* () {
      const corruptLegacy = JSON.stringify({ connections: [{ invalid: true }] });
      const memory = makeStorage({ [LEGACY_CONNECTIONS_KEY]: corruptLegacy });

      expect(yield* recover().pipe(provide(memory))).toBe(true);

      expect(backupsOf(memory, LEGACY_CONNECTIONS_KEY).map(([, value]) => value)).toEqual([
        corruptLegacy,
      ]);
      expect(memory.values.has(LEGACY_CONNECTIONS_KEY)).toBe(false);
      const fresh = yield* make().pipe(provide(memory));
      expect((yield* fresh.read).targets).toEqual([]);
    }),
  );

  it.effect("saves every unreadable source before removing any", () =>
    Effect.gen(function* () {
      const corruptLegacy = JSON.stringify({ connections: [{ invalid: true }] });
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: corruptWithSecret,
        [LEGACY_CONNECTIONS_KEY]: corruptLegacy,
      });

      yield* recover().pipe(provide(memory));

      expect(memory.writes).toHaveLength(2);
      expect(memory.deleted).toEqual([CONNECTION_CATALOG_KEY, LEGACY_CONNECTIONS_KEY]);
      expect(memory.values.size).toBe(2);
    }),
  );

  it.effect("removes nothing when any copy cannot be saved", () =>
    Effect.gen(function* () {
      const corruptLegacy = JSON.stringify({ connections: [{ invalid: true }] });
      const memory = makeStorage({
        [CONNECTION_CATALOG_KEY]: corruptWithSecret,
        [LEGACY_CONNECTIONS_KEY]: corruptLegacy,
      });
      const failing = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        setItem: (key, value) =>
          key.startsWith(`${LEGACY_CONNECTIONS_KEY}.corrupt.`)
            ? Effect.fail(new Error(`disk full for ${value}`) as never)
            : memory.storage.setItem(key, value),
      });

      const error = yield* Effect.flip(
        recover().pipe(Effect.provideService(MobileSecureStorage.MobileSecureStorage, failing)),
      );

      expect(error.detail).toContain("save");
      expect(memory.deleted).toEqual([]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(corruptWithSecret);
      expect(memory.values.get(LEGACY_CONNECTIONS_KEY)).toBe(corruptLegacy);
    }),
  );

  it.effect("repeated attempts do not add copies or touch a healthy catalog", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: corruptWithSecret });

      expect(yield* recover().pipe(provide(memory))).toBe(true);
      expect(yield* recover().pipe(provide(memory))).toBe(false);
      const fresh = yield* make().pipe(provide(memory));
      yield* fresh.update((document) => document);
      const writesBefore = memory.writes.length;
      expect(yield* recover().pipe(provide(memory))).toBe(false);

      expect(backupsOf(memory, CONNECTION_CATALOG_KEY)).toHaveLength(1);
      expect(memory.writes).toHaveLength(writesBefore);
    }),
  );

  it.effect("does nothing when the catalog is readable or empty", () =>
    Effect.gen(function* () {
      const empty = makeStorage({});
      expect(yield* recover().pipe(provide(empty))).toBe(false);
      const healthy = makeStorage({
        [CONNECTION_CATALOG_KEY]: JSON.stringify({
          schemaVersion: 1,
          targets: [],
          profiles: [],
          credentials: [],
          remoteDpopTokens: [],
        }),
      });
      expect(yield* recover().pipe(provide(healthy))).toBe(false);
      expect(healthy.writes).toEqual([]);
      expect(healthy.deleted).toEqual([]);
    }),
  );

  it.effect("fails without removing anything when storage cannot be read", () =>
    Effect.gen(function* () {
      const memory = makeStorage({ [CONNECTION_CATALOG_KEY]: corruptWithSecret });
      const locked = MobileSecureStorage.MobileSecureStorage.of({
        ...memory.storage,
        getItem: () => Effect.fail(new Error("keychain locked") as never),
      });

      const error = yield* Effect.flip(
        recover().pipe(Effect.provideService(MobileSecureStorage.MobileSecureStorage, locked)),
      );

      expect(error.detail).toContain("load");
      expect(error.detail).not.toContain("secret-token");
      expect(memory.deleted).toEqual([]);
      expect(memory.values.get(CONNECTION_CATALOG_KEY)).toBe(corruptWithSecret);
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ConnectionTransientError } from "../connection/model.ts";
import {
  type CorruptCatalogArchive,
  catalogCorruptError,
  corruptCatalogBackupId,
  isCatalogCorruptError,
  preserveCorruptCatalog,
} from "./corruptCatalogPreservation.ts";

function memoryArchive(
  initial: Readonly<Record<string, string>> = {},
  overrides: Partial<CorruptCatalogArchive<string>> = {},
) {
  const values = new Map(Object.entries(initial));
  const writes: Array<string> = [];
  const archive: CorruptCatalogArchive<string> = {
    keyPrefix: "catalog.corrupt.",
    get: (key) => Effect.sync(() => values.get(key) ?? null),
    set: (key, value) =>
      Effect.sync(() => {
        writes.push(key);
        values.set(key, value);
      }),
    failure: (detail) => detail,
    ...overrides,
  };
  return { archive, values, writes };
}

describe("corrupt catalog preservation", () => {
  it("derives the same id for the same bytes and a different one otherwise", () => {
    expect(corruptCatalogBackupId("{not-json")).toBe(corruptCatalogBackupId("{not-json"));
    expect(corruptCatalogBackupId("{not-json")).not.toBe(corruptCatalogBackupId("{not-jsoN"));
  });

  it.effect("saves the exact bytes once and reuses the key on repeated loads", () =>
    Effect.gen(function* () {
      const memory = memoryArchive();
      const raw = '{"credentials":[{"token":"secret"';

      const first = yield* preserveCorruptCatalog(memory.archive, raw);
      const second = yield* preserveCorruptCatalog(memory.archive, raw);
      const [third, fourth] = yield* Effect.all(
        [preserveCorruptCatalog(memory.archive, raw), preserveCorruptCatalog(memory.archive, raw)],
        { concurrency: "unbounded" },
      );

      expect(new Set([first, second, third, fourth])).toEqual(new Set([first]));
      expect(memory.values.get(first)).toBe(raw);
      expect(memory.values.size).toBe(1);
    }),
  );

  it.effect("never replaces a different payload that collides on the same id", () =>
    Effect.gen(function* () {
      const raw = "{corrupt-b";
      const occupied = `catalog.corrupt.${corruptCatalogBackupId(raw)}`;
      const memory = memoryArchive({ [occupied]: "{corrupt-a" });

      const key = yield* preserveCorruptCatalog(memory.archive, raw);

      expect(key).not.toBe(occupied);
      expect(memory.values.get(occupied)).toBe("{corrupt-a");
      expect(memory.values.get(key)).toBe(raw);
    }),
  );

  it.effect("fails when the lookup fails instead of treating the key as absent", () =>
    Effect.gen(function* () {
      const memory = memoryArchive({}, { get: () => Effect.fail("backup entry is malformed") });

      const error = yield* Effect.flip(preserveCorruptCatalog(memory.archive, "{x"));

      expect(error).toBe("backup entry is malformed");
      expect(memory.writes).toEqual([]);
    }),
  );

  it.effect("fails when the write fails", () =>
    Effect.gen(function* () {
      const memory = memoryArchive({}, { set: () => Effect.fail("disk full") });

      expect(yield* Effect.flip(preserveCorruptCatalog(memory.archive, "{x"))).toBe("disk full");
    }),
  );

  it.effect("fails when a write does not read back instead of reporting success", () =>
    Effect.gen(function* () {
      const memory = memoryArchive({}, { set: () => Effect.void });

      const error = yield* Effect.flip(preserveCorruptCatalog(memory.archive, "{x"));

      expect(error).toContain("could not be preserved");
    }),
  );

  it("marks catalog corruption without repeating the payload", () => {
    const error = catalogCorruptError();

    expect(isCatalogCorruptError(error)).toBe(true);
    expect(error.message).not.toContain("{");
    expect(
      isCatalogCorruptError(
        new ConnectionTransientError({ reason: "remote-unavailable", detail: "offline" }),
      ),
    ).toBe(false);
    expect(isCatalogCorruptError(new Error("catalog-corrupt"))).toBe(false);
    expect(isCatalogCorruptError(null)).toBe(false);
  });
});

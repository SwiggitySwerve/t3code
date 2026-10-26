import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { ConnectionPersistenceError } from "../platform/persistence.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";

const corruption = (error: ConnectionPersistenceError) =>
  Effect.gen(function* () {
    const registry = AtomRegistry.make();
    const catalog = createEnvironmentCatalogAtoms(
      Atom.runtime(
        Layer.effect(EnvironmentRegistry.EnvironmentRegistry, Effect.fail(error)),
      ) as unknown as Atom.AtomRuntime<
        EnvironmentRegistry.EnvironmentRegistry,
        ConnectionPersistenceError
      >,
    );
    yield* Effect.flip(
      AtomRegistry.getResult(registry, catalog.catalogAtom, { suspendOnWaiting: true }),
    );
    return registry.get(catalog.catalogCorruptionAtom);
  });

describe("environment catalog corruption", () => {
  it.effect("is true when the runtime failed because the stored catalog is unreadable", () =>
    Effect.gen(function* () {
      expect(
        yield* corruption(
          new ConnectionPersistenceError({
            operation: "list-targets",
            message: "Could not list targets.",
            reason: "catalog-corrupt",
          }),
        ),
      ).toBe(true);
    }),
  );

  it.effect("is false for any other runtime failure, such as storage that is unavailable", () =>
    Effect.gen(function* () {
      expect(
        yield* corruption(
          new ConnectionPersistenceError({
            operation: "list-targets",
            message: "Could not list targets: IndexedDB is unavailable.",
          }),
        ),
      ).toBe(false);
    }),
  );
});

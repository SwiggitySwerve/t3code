import { RegistryContext } from "@effect/atom-react";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { environmentCatalog } from "~/connection/catalog";
import { resetConfirmDialogForTests } from "~/confirmDialog";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { CorruptCatalogNotice } from "./CorruptCatalogNotice";

// The database as an older tab or version left it. The stores are the ones the app creates.
const DATABASE_NAME = "t3code:connection-runtime";
const STORES = ["catalog", "shell", "thread", "server-config", "vcs-refs"] as const;
const CORRUPT = '{"credentials":[{"token":"secret-token"';
const READABLE =
  '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[],"disabledEnvironmentIds":[]}';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 4);
    request.addEventListener("upgradeneeded", () => {
      for (const store of STORES) request.result.createObjectStore(store);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function withDatabase<A>(use: (database: IDBDatabase) => Promise<A>): Promise<A> {
  const database = await openDatabase();
  try {
    return await use(database);
  } finally {
    database.close();
  }
}

const request = <A,>(source: IDBRequest<A>) =>
  new Promise<A>((resolve, reject) => {
    source.addEventListener("success", () => resolve(source.result));
    source.addEventListener("error", () => reject(source.error));
  });

const readCatalogKey = (key: string) =>
  withDatabase((database) =>
    request(database.transaction("catalog").objectStore("catalog").get(key)),
  );

const catalogKeys = () =>
  withDatabase((database) =>
    request(database.transaction("catalog").objectStore("catalog").getAllKeys()),
  );

// Not a database delete: the runtime of an earlier test may still hold the connection open.
const clearCatalogStore = () =>
  withDatabase((database) =>
    request(database.transaction("catalog", "readwrite").objectStore("catalog").clear()),
  );

/** Leaves `stored` as the catalog for one test, and an empty store and dialog host afterwards. */
async function storedCatalog(stored: string): Promise<AsyncDisposable> {
  await clearCatalogStore();
  await withDatabase((database) =>
    request(
      database.transaction("catalog", "readwrite").objectStore("catalog").put(stored, "document"),
    ),
  );
  resetConfirmDialogForTests();
  return {
    async [Symbol.asyncDispose]() {
      resetConfirmDialogForTests();
      await clearCatalogStore();
    },
  };
}

function renderNotice(registry: AtomRegistry.AtomRegistry, reload: () => void) {
  return render(
    <RegistryContext.Provider value={registry}>
      <ConfirmDialogHost />
      <CorruptCatalogNotice reload={reload} />
    </RegistryContext.Provider>,
  );
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLElement>("button")].find(
    (element) => element.textContent?.trim() === text,
  );

describe("CorruptCatalogNotice on the real connection runtime", () => {
  it("offers a reset for a corrupt catalog and leaves a readable catalog after it", async () => {
    await using _stored = await storedCatalog(CORRUPT);
    const reload = vi.fn();
    const registry = AtomRegistry.make();
    await using screen = await renderNotice(registry, reload);

    // Stored bytes went through the real storage, the real registry and the real atom.
    await vi.waitFor(() => expect(screen.container.textContent).toContain("could not be read"), {
      timeout: 5000,
    });
    expect(registry.get(environmentCatalog.catalogCorruptionAtom)).toBe(true);
    expect(AsyncResult.isFailure(registry.get(environmentCatalog.catalogAtom))).toBe(true);
    expect(screen.container.textContent).not.toContain("secret-token");
    expect(await readCatalogKey("document")).toBe(CORRUPT);

    await act(async () => button("Reset connections")!.click());
    await vi.waitFor(
      () => expect(document.body.textContent).toContain("Reset saved connections?"),
      {
        timeout: 5000,
      },
    );
    // Cancelling leaves the catalog exactly as it was.
    await act(async () => button("Cancel")!.click());
    await vi.waitFor(() => expect(document.body.textContent).not.toContain("Reset saved"), {
      timeout: 5000,
    });
    expect(await readCatalogKey("document")).toBe(CORRUPT);
    expect(reload).not.toHaveBeenCalled();

    await act(async () => button("Reset connections")!.click());
    await vi.waitFor(() => expect(button("Confirm")).toBeDefined(), { timeout: 5000 });
    await act(async () => button("Confirm")!.click());
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 5000 });

    // The unreadable bytes are kept, and the live catalog is now one the app reads.
    const backup = (await catalogKeys())
      .map(String)
      .find((key) => key.startsWith("document:corrupt:"));
    expect(backup).toBeDefined();
    expect(await readCatalogKey(backup!)).toBe(CORRUPT);
    expect(JSON.parse((await readCatalogKey("document")) as string)).toMatchObject({
      schemaVersion: 1,
      targets: [],
    });
  });

  it("shows nothing once the catalog is readable", async () => {
    await using _stored = await storedCatalog(READABLE);
    const registry = AtomRegistry.make();
    await using screen = await renderNotice(registry, vi.fn());
    // The runtime goes on to look for the primary environment, which no test server answers, so
    // it never settles; a failed start would have flipped the atom before this point.
    await vi.waitFor(() => expect(registry.get(environmentCatalog.catalogAtom)).toBeDefined());
    expect(AsyncResult.isFailure(registry.get(environmentCatalog.catalogAtom))).toBe(false);
    expect(registry.get(environmentCatalog.catalogCorruptionAtom)).toBe(false);
    expect(screen.container.textContent).toBe("");
  });
});

// @effect-diagnostics nodeBuiltinImport:off - a directory junction needs no privilege on Windows; FileSystem.symlink cannot request one.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  readAntigravityClientTextFile,
  writeAntigravityClientTextFile,
} from "./AntigravityClientFiles.ts";

const SESSION_ID = "session-1";
const OUTSIDE_MESSAGE = "outside the session workspace";

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-files-ws-" });
  const outside = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-files-out-" });
  const read = (allowedRoots: ReadonlyArray<string>, requestPath: string) =>
    readAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots,
      request: { sessionId: SESSION_ID, path: requestPath },
    });
  const write = (allowedRoots: ReadonlyArray<string>, requestPath: string, content: string) =>
    writeAntigravityClientTextFile({
      fileSystem,
      path,
      allowedRoots,
      request: { sessionId: SESSION_ID, path: requestPath, content },
    });
  return { fileSystem, path, workspace, outside, read, write };
});

const linkDirectory = (target: string, link: string) =>
  Effect.sync(() => NodeFS.symlinkSync(target, link, "junction"));

const failureMessage = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? String(exit.cause) : "";

describe("Antigravity client file containment", () => {
  it.effect("denies a write below a linked directory when two segments are still missing", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* fixture;
      yield* linkDirectory(outside, path.join(workspace, "linked"));

      const exit = yield* write(
        [workspace],
        path.join(workspace, "linked", "missing-a", "missing-b", "planted.txt"),
        "planted",
      ).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit), "the write must be denied");
      assert.include(failureMessage(exit), OUTSIDE_MESSAGE);
      assert.deepEqual(yield* fileSystem.readDirectory(outside), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("denies a write below a linked directory with one missing segment", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* fixture;
      yield* linkDirectory(outside, path.join(workspace, "linked"));

      const exit = yield* write(
        [workspace],
        path.join(workspace, "linked", "planted.txt"),
        "planted",
      ).pipe(Effect.exit);

      assert.include(failureMessage(exit), OUTSIDE_MESSAGE);
      assert.deepEqual(yield* fileSystem.readDirectory(outside), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("denies a read below a linked directory even when the file is missing", () =>
    Effect.gen(function* () {
      const { path, workspace, outside, read } = yield* fixture;
      yield* linkDirectory(outside, path.join(workspace, "linked"));

      const exit = yield* read(
        [workspace],
        path.join(workspace, "linked", "missing-a", "missing-b", "absent.txt"),
      ).pipe(Effect.exit);

      assert.include(failureMessage(exit), OUTSIDE_MESSAGE);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("denies a write below a linked directory that is nested inside the workspace", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, outside, write } = yield* fixture;
      yield* fileSystem.makeDirectory(path.join(workspace, "src"), { recursive: true });
      yield* linkDirectory(outside, path.join(workspace, "src", "linked"));

      const exit = yield* write(
        [workspace],
        path.join(workspace, "src", "linked", "a", "b", "c", "planted.txt"),
        "planted",
      ).pipe(Effect.exit);

      assert.include(failureMessage(exit), OUTSIDE_MESSAGE);
      assert.deepEqual(yield* fileSystem.readDirectory(outside), []);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("denies a path whose directory name only shares the workspace prefix", () =>
    Effect.gen(function* () {
      const { fileSystem, workspace, write } = yield* fixture;
      const sibling = `${workspace}-evil`;
      yield* Effect.addFinalizer(() =>
        fileSystem.remove(sibling, { recursive: true, force: true }).pipe(Effect.ignore),
      );

      const exit = yield* write([workspace], `${sibling}/a/b.txt`, "planted").pipe(Effect.exit);

      assert.include(failureMessage(exit), OUTSIDE_MESSAGE);
      assert.isFalse(yield* fileSystem.exists(sibling));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("writes and reads nested new paths inside the workspace", () =>
    Effect.gen(function* () {
      const { path, workspace, write, read } = yield* fixture;
      const target = path.join(workspace, "src", "deep", "er", "inside.ts");

      yield* write([workspace], target, "inside");
      const result = yield* read([workspace], target);

      assert.equal(result.content, "inside");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "writes nested new paths below a linked directory that stays inside the workspace",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, workspace, write } = yield* fixture;
        const real = path.join(workspace, "real");
        yield* fileSystem.makeDirectory(real, { recursive: true });
        yield* linkDirectory(real, path.join(workspace, "alias"));

        yield* write([workspace], path.join(workspace, "alias", "x", "y", "z.txt"), "inside");

        assert.equal(
          yield* fileSystem.readFileString(path.join(real, "x", "y", "z.txt")),
          "inside",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("accepts an allowed root that is itself a link to the real directory", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace, write } = yield* fixture;
      const linkedRoot = path.join(
        yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-root-" }),
        "root",
      );
      yield* linkDirectory(workspace, linkedRoot);

      yield* write([linkedRoot], path.join(linkedRoot, "n1", "n2", "file.txt"), "inside");

      assert.equal(
        yield* fileSystem.readFileString(path.join(workspace, "n1", "n2", "file.txt")),
        "inside",
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps every explicitly allowed root usable", () =>
    Effect.gen(function* () {
      const { path, workspace, outside, write, read } = yield* fixture;
      const target = path.join(outside, "attachments", "nested", "pasted.txt");

      yield* write([workspace, outside], target, "pasted");

      assert.equal((yield* read([workspace, outside], target)).content, "pasted");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
    "accepts a differently cased spelling of the workspace on Windows",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, workspace, write } = yield* fixture;

        yield* write([workspace], path.join(workspace.toUpperCase(), "a", "b.txt"), "inside");

        assert.equal(
          yield* fileSystem.readFileString(path.join(workspace, "a", "b.txt")),
          "inside",
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "denies reading or overwriting an existing file through an escaping file link",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, workspace, outside, read, write } = yield* fixture;
        const secret = path.join(outside, "secret.txt");
        yield* fileSystem.writeFileString(secret, "secret");
        const link = path.join(workspace, "secret-link.txt");
        yield* fileSystem.symlink(secret, link);

        const readExit = yield* read([workspace], link).pipe(Effect.exit);
        const writeExit = yield* write([workspace], link, "overwritten").pipe(Effect.exit);

        assert.include(failureMessage(readExit), OUTSIDE_MESSAGE);
        assert.include(failureMessage(writeExit), OUTSIDE_MESSAGE);
        assert.equal(yield* fileSystem.readFileString(secret), "secret");
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "denies a write through a dangling link that points outside the workspace",
    () =>
      Effect.gen(function* () {
        const { fileSystem, path, workspace, outside, write } = yield* fixture;
        const planted = path.join(outside, "created.txt");
        yield* fileSystem.symlink(planted, path.join(workspace, "dangling.txt"));

        const exit = yield* write([workspace], path.join(workspace, "dangling.txt"), "x").pipe(
          Effect.exit,
        );

        assert.isTrue(Exit.isFailure(exit));
        assert.isFalse(yield* fileSystem.exists(planted));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("fails closed when an ancestor cannot be inspected", () =>
    Effect.gen(function* () {
      const { fileSystem, path, workspace } = yield* fixture;
      const locked = path.join(workspace, "locked");
      const denied = (method: string) =>
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method,
          pathOrDescriptor: locked,
        });
      const isUnderLocked = (candidate: string) =>
        candidate === locked || candidate.startsWith(`${locked}${path.sep}`);
      const unreadable: FileSystem.FileSystem = {
        ...fileSystem,
        realPath: (candidate) =>
          isUnderLocked(candidate)
            ? Effect.fail(denied("realPath"))
            : fileSystem.realPath(candidate),
        readLink: (candidate) =>
          isUnderLocked(candidate)
            ? Effect.fail(denied("readLink"))
            : fileSystem.readLink(candidate),
        exists: (candidate) =>
          isUnderLocked(candidate) ? Effect.fail(denied("access")) : fileSystem.exists(candidate),
      };

      const exit = yield* writeAntigravityClientTextFile({
        fileSystem: unreadable,
        path,
        allowedRoots: [workspace],
        request: {
          sessionId: SESSION_ID,
          path: path.join(locked, "missing-a", "missing-b", "file.txt"),
          content: "x",
        },
      }).pipe(Effect.exit);

      assert.include(failureMessage(exit), OUTSIDE_MESSAGE);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

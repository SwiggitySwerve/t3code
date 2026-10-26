// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { renameWithLockRetry } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isNetworkPath } from "@t3tools/shared/path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type ExistingFile = {
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
  readonly hasBom: boolean;
};

/**
 * Describes the file at the path when it is opened. A symlink in the last
 * position is refused (O_NOFOLLOW). A later rename replaces whatever is at the
 * path by then, and the write-permission check is by path after the handle closes.
 */
const inspectExistingFile = async (
  targetPath: string,
): Promise<ExistingFile | "not-file" | null> => {
  const handle = await NodeFSP.open(
    targetPath,
    NodeFS.constants.O_RDONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0) |
      (NodeFS.constants.O_NONBLOCK ?? 0),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    if (error.code === "EISDIR") return "not-file" as const;
    throw error;
  });
  if (handle === null || handle === "not-file") return handle;
  let existing: ExistingFile | "not-file";
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return "not-file";
    const head = Buffer.alloc(UTF8_BOM.length);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    existing = {
      mode: stat.mode & 0o777,
      uid: stat.uid,
      gid: stat.gid,
      hasBom: bytesRead === head.length && head.equals(UTF8_BOM),
    };
  } finally {
    await handle.close();
  }
  // Renaming over a file ignores its write permission, which opening it for write did not.
  await NodeFSP.access(targetPath, NodeFS.constants.W_OK);
  return existing;
};

/**
 * Writes the replacement beside the target with the original's mode. Returns
 * the error when ownership could not be copied: only a privileged server may
 * give a file to another user, so the saved file then belongs to the server's user.
 */
const writeReplacementFile = async (
  temporaryPath: string,
  contents: string,
  existing: ExistingFile | null,
): Promise<NodeJS.ErrnoException | null> => {
  const temporary = await NodeFSP.open(
    temporaryPath,
    NodeFS.constants.O_WRONLY |
      NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
    existing?.mode ?? 0o666,
  );
  let ownershipError: NodeJS.ErrnoException | null = null;
  try {
    const bytes = Buffer.from(contents, "utf8");
    await temporary.writeFile(existing?.hasBom ? Buffer.concat([UTF8_BOM, bytes]) : bytes);
    if (existing !== null) {
      const euid = process.geteuid?.();
      const egid = process.getegid?.();
      if (
        euid !== undefined &&
        egid !== undefined &&
        (existing.uid !== euid || existing.gid !== egid)
      ) {
        // Before chmod: changing the owner can clear permission bits.
        await temporary.chown(existing.uid, existing.gid).catch((error: NodeJS.ErrnoException) => {
          ownershipError = error;
        });
      }
      await temporary.chmod(existing.mode);
    }
    await temporary.sync();
  } finally {
    await temporary.close();
  }
  return ownershipError;
};

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary or not valid UTF-8 and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /** Writes inside a known workspace only. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // Git recognizes HEAD with commondir or objects/refs as a repository.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute or `~/` path reads a host file in place, such as a report an agent
   * wrote to a temp directory; it gets no root check. A network path does, since
   * Windows signs in to its host with the user's NTLM credentials.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    const hostPath = requestedPath.startsWith("~/")
      ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
      : requestedPath;
    if (
      isNetworkPath(hostPath) &&
      !KnownWorkspaces.isWithinRoot(path, path.resolve(hostPath), path.resolve(input.cwd))
    ) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    if (path.isAbsolute(hostPath)) {
      // Native realpath hands Windows a `\\?\` path as written, `..` included,
      // so a network path must be the resolved one the check above approved.
      // Others keep POSIX `link/..` semantics, which resolving first would change.
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
            operation: "realpath-target",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      );
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        let candidate = target.absolutePath;
        for (;;) {
          try {
            return {
              realTargetPath: path.join(
                await NodeFSP.realpath(candidate),
                path.relative(candidate, target.absolutePath),
              ),
              exists: candidate === target.absolutePath,
            };
          } catch (error) {
            if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            // Like writes, missing reads must check the nearest existing ancestor.
            // An existing entry that cannot resolve is a dangling link, not absence.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
                return false;
              },
            );
            if (exists || path.dirname(candidate) === candidate) throw error;
            candidate = path.dirname(candidate);
          }
        }
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: resolved.realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const absentResult = {
      relativePath: target.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    };
    const realTargetPath = target.realTargetPath;
    if (realTargetPath === null) return absentResult;

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      ),
      (handle) =>
        Effect.gen(function* () {
          if (handle === null) return absentResult;
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;
          const binaryFileError = () =>
            new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          if (fileBytes.includes(0)) return yield* binaryFileError();
          // Text that does not decode exactly would be saved back with U+FFFD in place of the bytes.
          // A size cap can cut a character in half; streaming holds that tail back.
          const contents = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true }).decode(fileBytes, { stream: truncated }),
            catch: binaryFileError,
          });

          return {
            relativePath: target.relativePath,
            contents,
            byteLength: stat.size,
            truncated,
          };
        }),
      (handle) =>
        handle === null
          ? Effect.void
          : Effect.tryPromise({
              try: () => handle.close(),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "close",
                  cause,
                }),
            }),
    );
  });

  // Resolve existing ancestors and reject dangling links so creation cannot follow symlinks outside root.
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (
    input: ProjectWriteFileInput,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: async () => {
        for (let depth = segments.length; depth > 0; depth--) {
          const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
          try {
            return path.join(await NodeFSP.realpath(candidate), ...segments.slice(depth));
          } catch (error) {
            // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              () => false,
            );
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists) throw error;
          }
        }
        return path.join(realWorkspaceRoot, ...segments);
      },
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      }),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  /**
   * Saves through a temporary sibling so a failed write leaves the original
   * intact. A UTF-8 BOM belongs to the file rather than its text: reads omit it,
   * so a replacement keeps the one the file had. Hard links are not preserved,
   * and ownership only when the server may give files away.
   */
  const replaceFileContents = Effect.fn("WorkspaceFileSystem.replaceFileContents")(function* (
    input: ProjectWriteFileInput,
    targetPath: string,
  ) {
    const writeFailure = (cause: unknown) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: targetPath,
        operationPath: targetPath,
        operation: "write-file",
        cause,
      });
    const existing = yield* Effect.tryPromise({
      try: () => inspectExistingFile(targetPath),
      catch: writeFailure,
    });
    if (existing === "not-file") {
      return yield* new WorkspacePathNotFileError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedPath: targetPath,
      });
    }
    const temporaryPath = path.join(
      path.dirname(targetPath),
      `.t3-save-${NodeCrypto.randomUUID()}.tmp`,
    );
    yield* Effect.gen(function* () {
      const ownershipError = yield* Effect.tryPromise({
        try: () => writeReplacementFile(temporaryPath, input.contents, existing),
        catch: writeFailure,
      });
      if (ownershipError !== null) {
        yield* Effect.logDebug("Saved file keeps the server's ownership.", ownershipError);
      }
      yield* renameWithLockRetry(temporaryPath, targetPath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HostProcess.Platform, platform),
        Effect.mapError(writeFailure),
      );
    }).pipe(
      // A leftover temporary file would sit untracked in the user's repository.
      Effect.onError(() =>
        fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveWriteTarget(input);
    const realTargetPath = target.realTargetPath;

    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: path.dirname(realTargetPath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* replaceFileContents(input, realTargetPath);
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ getMetadata, readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);

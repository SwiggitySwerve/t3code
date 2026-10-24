// @effect-diagnostics-next-line nodeBuiltinImport:off -- offline collector owns synchronous filesystem observations.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- paths belong to the offline collector.
import * as NodePath from "node:path";

export type PathMetadata =
  | { exists: false }
  | {
      exists: true;
      type: "file" | "directory" | "symlink" | "other";
      size: string;
      mtimeNs: string;
    };
export interface FileObservation {
  path: string;
  time: number;
  metadata: PathMetadata;
}
export interface FileAudit {
  startedAt: number;
  endedAt: number;
  initial: Record<string, PathMetadata>;
  events: FileObservation[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Missing filesystem observation");
  return value as Record<string, unknown>;
}
function relativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    (value !== "." && value.split("/").some((part) => !part || part === "." || part === "..")) ||
    /[\\:\0]/.test(value) ||
    value === ".git" ||
    value.startsWith(".git/")
  )
    throw Error("File event has no valid workspace path");
  return value;
}
function metadata(value: unknown): PathMetadata {
  const item = record(value);
  if (item.exists === false) return { exists: false };
  if (
    item.exists !== true ||
    typeof item.type !== "string" ||
    !["file", "directory", "symlink", "other"].includes(item.type) ||
    typeof item.size !== "string" ||
    !/^\d+$/.test(item.size) ||
    typeof item.mtimeNs !== "string" ||
    !/^-?\d+$/.test(item.mtimeNs)
  )
    throw Error("Unknown filesystem metadata");
  return item as unknown as PathMetadata;
}
function changed(before: PathMetadata, after: PathMetadata): boolean {
  if (!before.exists || !after.exists) return before.exists !== after.exists;
  return (
    before.type !== after.type || before.size !== after.size || before.mtimeNs !== after.mtimeNs
  );
}

/** Metadata is trusted collector evidence, not confinement against a hostile writer. */
export function fileChanges(value: unknown): FileObservation[] {
  const audit = record(value);
  if (
    typeof audit.startedAt !== "number" ||
    !Number.isFinite(audit.startedAt) ||
    typeof audit.endedAt !== "number" ||
    !Number.isFinite(audit.endedAt) ||
    audit.startedAt >= audit.endedAt ||
    !Array.isArray(audit.events)
  )
    throw Error("Missing completed filesystem audit");
  const previous = new Map<string, PathMetadata>();
  for (const [name, facts] of Object.entries(record(audit.initial))) {
    const initial = metadata(facts);
    if (!initial.exists) throw Error("Missing initial workspace path");
    previous.set(relativePath(name), initial);
  }
  if (!previous.size) throw Error("Missing initial filesystem snapshot");
  const changes: FileObservation[] = [];
  let lastTime = audit.startedAt;
  for (const raw of audit.events) {
    const event = record(raw);
    const name = relativePath(event.path);
    const facts = metadata(event.metadata);
    if (
      typeof event.time !== "number" ||
      !Number.isFinite(event.time) ||
      event.time < lastTime ||
      event.time > audit.endedAt
    )
      throw Error("Invalid filesystem observation time");
    lastTime = event.time;
    const before = previous.get(name);
    // An event for an unseen, already absent path may be a coalesced create/delete.
    if (!before && !facts.exists) throw Error("Unobserved path disappeared during audit");
    if (changed(before ?? { exists: false }, facts))
      changes.push({ path: name, time: event.time, metadata: facts });
    previous.set(name, facts);
  }
  return changes;
}

export function readFileAuditJournal(input: unknown): FileAudit {
  if (!Array.isArray(input) || input.length < 2) throw Error("Incomplete file-event journal");
  const entries = input.map(record);
  const first = entries[0]!,
    last = entries.at(-1)!;
  if (
    first.type !== "open" ||
    last.type !== "close" ||
    entries.some((entry, index) => entry.sequence !== index) ||
    entries.slice(1, -1).some((entry) => entry.type !== "file")
  )
    throw Error("Incomplete file-event journal");
  const audit = {
    startedAt: first.time,
    endedAt: last.time,
    initial: first.initial,
    events: entries.slice(1, -1).map(({ path, time, metadata }) => ({ path, time, metadata })),
  };
  fileChanges(audit);
  return audit as FileAudit;
}

export function observePath(workspace: string, name: string): PathMetadata {
  relativePath(name);
  try {
    const stat = NodeFS.lstatSync(NodePath.join(workspace, name), { bigint: true });
    return {
      exists: true,
      type: stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : stat.isSymbolicLink()
            ? "symlink"
            : "other",
      size: String(stat.size),
      // Bigint stats preserve sub-millisecond writes on filesystems such as NTFS.
      mtimeNs: String(stat.mtimeNs),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false };
    throw error;
  }
}
function snapshot(workspace: string): Record<string, PathMetadata> {
  const result: Record<string, PathMetadata> = {};
  function visit(name: string) {
    const facts = observePath(workspace, name);
    if (!facts.exists) throw Error("Workspace path disappeared while taking snapshot");
    result[name] = facts;
    if (facts.type === "directory")
      for (const child of NodeFS.readdirSync(NodePath.join(workspace, name))) {
        if (name === "." && child === ".git") continue;
        visit(name === "." ? child : `${name}/${child}`);
      }
  }
  visit(".");
  if (!result["."]?.exists || result["."].type !== "directory")
    throw Error("Workspace is not a directory");
  return result;
}

/** Starts before the ready marker; the caller must not start work until then. */
export function startFileAudit(
  workspace: string,
  append: (entry: Record<string, unknown>) => void,
) {
  const observed = new Set<string>();
  const observe = (name: string) => {
    relativePath(name);
    observed.add(name);
    append({ type: "file", path: name, metadata: observePath(workspace, name) });
  };
  const watcher = NodeFS.watch(workspace, { recursive: true }, (_event, filename) => {
    const name = filename?.toString().replaceAll("\\", "/");
    if (name === ".git" || name?.startsWith(".git/")) return;
    observe(relativePath(name));
  });
  watcher.on("error", (error) => {
    throw error;
  });
  let initial: Record<string, PathMetadata>;
  try {
    initial = snapshot(workspace);
    append({ type: "open", initial });
  } catch (error) {
    watcher.close();
    throw error;
  }
  return {
    close() {
      watcher.close();
      // Reconcile persistent changes and deletions even if notifications coalesced.
      const final = snapshot(workspace);
      for (const name of new Set([...Object.keys(initial), ...observed, ...Object.keys(final)]))
        observe(name);
      append({ type: "close" });
    },
  };
}

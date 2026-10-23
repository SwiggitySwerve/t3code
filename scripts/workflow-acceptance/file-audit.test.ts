import { describe, expect, it, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- verifies the collector's filesystem error boundary.
import * as NodeFS from "node:fs";
import { fileChanges, observePath, readFileAuditJournal, type PathMetadata } from "./file-audit.ts";

vi.mock("node:fs", { spy: true });

const original: PathMetadata = {
  exists: true,
  type: "file",
  size: "4",
  mtimeNs: "1000000000000000000",
};
function journal() {
  return [
    { sequence: 0, time: 1, type: "open", initial: { "src/file": original } },
    { sequence: 1, time: 2, type: "file", path: "src/file", metadata: original },
    { sequence: 2, time: 3, type: "close" },
  ];
}

describe("filesystem metadata evidence", () => {
  it("propagates filesystem permission errors instead of treating them as absence", () => {
    using _stat = vi.spyOn(NodeFS, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    expect(() => observePath("workspace", "src/file")).toThrow("permission denied");
  });

  it.each(["ENOENT", "ENOTDIR"])("records known absence: %s", (code) => {
    using _stat = vi.spyOn(NodeFS, "lstatSync").mockImplementation(() => {
      throw Object.assign(new Error("absent"), { code });
    });
    expect(observePath("workspace", "src/file")).toEqual({ exists: false });
  });
  it("ignores duplicate access-only notifications", () => {
    expect(fileChanges(readFileAuditJournal(journal()))).toEqual([]);
  });

  it.each([
    { ...original, mtimeNs: "1000000000000000001" },
    { ...original, size: "5" },
    { ...original, type: "directory" },
    { exists: false },
  ])("detects mutation of one metadata fact: %j", (metadata) => {
    const entries = journal();
    Object.assign(entries[1]!, { metadata });
    expect(fileChanges(readFileAuditJournal(entries))).toHaveLength(1);
  });

  it("compares with the preceding observation and retains a write then restore", () => {
    const entries = journal();
    entries.splice(1, 0, {
      sequence: 1,
      time: 2,
      type: "file",
      path: "src/file",
      metadata: { ...original, size: "5" },
    });
    entries.forEach((entry, sequence) => {
      entry.sequence = sequence;
    });
    const changes = fileChanges(readFileAuditJournal(entries));
    expect(changes.map((event) => event.metadata)).toEqual([{ ...original, size: "5" }, original]);
  });

  it("retains additions followed by deletion", () => {
    const entries = journal();
    Object.assign(entries[1]!, { path: "temporary", metadata: original });
    entries.splice(2, 0, {
      sequence: 2,
      time: 2,
      type: "file",
      path: "temporary",
      metadata: { exists: false },
    });
    entries.at(-1)!.sequence = 3;
    expect(fileChanges(readFileAuditJournal(entries))).toHaveLength(2);
  });

  it.each([
    "missing open",
    "missing close",
    "sequence gap",
    "extra open",
    "unknown entry",
    "missing filename",
    "outside path",
    "unknown metadata",
    "missing metadata",
    "unobserved disappearance",
    "reversed time",
    "nonfinite time",
    "missing initial",
  ])("fails closed on %s", (fault) => {
    const entries = journal();
    switch (fault) {
      case "missing open":
        entries.shift();
        break;
      case "missing close":
        entries.pop();
        break;
      case "sequence gap":
        entries[1]!.sequence = 7;
        break;
      case "extra open":
        entries[1]!.type = "open";
        break;
      case "unknown entry":
        entries[1]!.type = "error";
        break;
      case "missing filename":
        Object.assign(entries[1]!, { path: null });
        break;
      case "outside path":
        Object.assign(entries[1]!, { path: "../outside" });
        break;
      case "unknown metadata":
        Object.assign(entries[1]!, { metadata: { exists: "unknown" } });
        break;
      case "missing metadata":
        Object.assign(entries[1]!, { metadata: undefined });
        break;
      case "unobserved disappearance":
        Object.assign(entries[1]!, { path: "temporary", metadata: { exists: false } });
        break;
      case "reversed time":
        entries[1]!.time = 0;
        break;
      case "nonfinite time":
        entries[1]!.time = NaN;
        break;
      case "missing initial":
        Object.assign(entries[0]!, { initial: {} });
        break;
    }
    expect(() => readFileAuditJournal(entries)).toThrow();
  });
});

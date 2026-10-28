// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// Text damage a Windows shell can add to source files: UTF-8 read as Windows-1252 ("mojibake") and
// byte order marks. Only lines and files a change adds are reported, so damage already in the base
// never fails a gate.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { git } from "./util.ts";

// UTF-8 sequences for a dash, quote or accented letter, misread as two or three Latin-1 characters.
const MOJIBAKE = /\u00e2\u20ac|\u00c3[\u0080-\u00bf\u0192\u201a-\u203a]|\u00e2\u2020/;
// PowerShell scripts are left out: Windows PowerShell 5.1 needs a byte order mark to read non-ASCII text.
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|jsonc|md|css|html|ya?ml|txt)$/;
const BOM = "\uFEFF";

export interface EncodingInput {
  readonly path: string;
  readonly now: string;
  /** The file at the base, or null when the change adds it. */
  readonly before: string | null;
}

/** `path:line: text` for each added line that looks damaged, and each added byte order mark. */
export function scanEncoding(files: ReadonlyArray<EncodingInput>): Array<string> {
  const findings: Array<string> = [];
  for (const file of files) {
    if (file.now.startsWith(BOM) && !file.before?.startsWith(BOM)) {
      findings.push(`${file.path}:1: byte order mark added`);
    }
    const known = new Set(file.before?.split("\n") ?? []);
    file.now.split("\n").forEach((line, index) => {
      if (MOJIBAKE.test(line) && !known.has(line)) {
        findings.push(`${file.path}:${index + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
  return findings;
}

/** Scans what the checkout at `cwd` changed since its merge base with `base`. */
export function scanChangedEncoding(cwd: string, base: string): Array<string> {
  const mergeBase = git(cwd, ["merge-base", "HEAD", base]).trim();
  const changed = git(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--diff-filter=ACMR",
    mergeBase,
  ])
    .split("\0")
    .filter((path) => path !== "" && TEXT_FILE.test(path));
  return scanEncoding(
    changed.map((path) => ({
      path,
      now: NodeFS.readFileSync(NodePath.join(cwd, path), "utf8"),
      before: (() => {
        try {
          return git(cwd, ["show", `${mergeBase}:${path}`]);
        } catch {
          return null;
        }
      })(),
    })),
  );
}

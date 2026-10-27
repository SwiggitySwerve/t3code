// @effect-diagnostics nodeBuiltinImport:off - hand-run CLI tooling, outside any Effect runtime.
// The few helpers the QA commands share, so each rule has one definition.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/** Raw stdout of a git command in `cwd`. Stderr goes into the thrown error, never to the console. */
export function git(cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  return NodeChildProcess.execFileSync("git", [...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export const gitLine = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): string => git(cwd, args, env).trim();

const LABEL = /^[a-z0-9][a-z0-9-]{0,30}$/;

/** Snapshot labels and lane names become folder names, so they stay plain. */
export function assertLabel(what: "snapshot label" | "lane name", value: string): void {
  if (!LABEL.test(value)) {
    throw new Error(`A ${what} is lowercase letters, digits and hyphens: "${value}"`);
  }
}

export function isEmptyOrMissing(directory: string): boolean {
  return !NodeFS.existsSync(directory) || NodeFS.readdirSync(directory).length === 0;
}

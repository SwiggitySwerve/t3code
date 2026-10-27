// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// Runs CI's fast checks on a snapshot of the candidate, in a sibling worktree.
//
//   node scripts/workflow-qa/cli.ts gate --label <name> [--base main] [--baseline-log <log>]
//     [--out <dir>] [--keep|--reuse [--allow-stale]] [-- <command for vp, default: run check:changed <base>>]
//
// The checks are read-only (`check:changed` formats with --check), and they run on the snapshot,
// so nobody's files are rewritten and later edits to the checkout cannot change the result. A test
// failure already in the baseline log does not fail the gate; every other failure does, including
// text damage (mojibake, byte order marks) added to a changed file, a nonzero exit that the summary
// does not explain, and a default run whose log has no summary at all. `--reuse` refuses a snapshot
// whose files differ from the checkout's, because the gate would then verify something else.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { scanChangedEncoding } from "./encoding.ts";
import { createSnapshot, removeSnapshot, reuseSnapshot, workingTreeId } from "./snapshot.ts";

export interface GateResult {
  /** Steps in the check:changed summary that failed, such as "typecheck (3 packages)". */
  readonly failedSteps: ReadonlyArray<string>;
  /** Test files vitest reported as failed, each name once. */
  readonly failedTests: ReadonlyArray<string>;
  /** How many failure lines each name had; a name can fail more than once in one run. */
  readonly failureCounts: Readonly<Record<string, number>>;
  /** Whether the log ends with the `check:changed summary` block. */
  readonly summarySeen: boolean;
  /** Whether `check:changed` found nothing to check, which is its only summary-less success. */
  readonly nothingToCheck: boolean;
}

const SUMMARY_FAIL = /^\s{2}FAIL\s{2}(.+?)\s{2}[\d.]+s\s*$/;
const TEST_FAIL = /^ FAIL {2}(.*\S)\s*$/;
const SUMMARY_HEADER = /^check:changed summary\s*$/;
const NOTHING_TO_CHECK = /^check:changed: no changes since /;

/** A log as text. PowerShell redirection writes UTF-16 with a byte order mark; other tools write UTF-8. */
export function decodeLog(bytes: Uint8Array): string {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe;
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
}

/** What failed in a gate log, without ANSI colors. */
export function parseGateLog(log: string): GateResult {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const steps = new Set<string>();
  const tests = new Map<string, number>();
  let summarySeen = false;
  let nothingToCheck = false;
  for (const line of lines) {
    if (SUMMARY_HEADER.test(line)) summarySeen = true;
    if (NOTHING_TO_CHECK.test(line)) nothingToCheck = true;
    const step = SUMMARY_FAIL.exec(line)?.[1];
    if (step !== undefined) steps.add(step);
    const test = TEST_FAIL.exec(line)?.[1];
    if (test !== undefined) tests.set(test, (tests.get(test) ?? 0) + 1);
  }
  return {
    failedSteps: [...steps].sort(),
    failedTests: [...tests.keys()].sort(),
    failureCounts: Object.fromEntries([...tests].sort(([a], [b]) => (a < b ? -1 : 1))),
    summarySeen,
    nothingToCheck,
  };
}

export interface GateVerdict {
  readonly ok: boolean;
  /** Failures that are not in the baseline. */
  readonly newFailures: ReadonlyArray<string>;
  /** Baseline test failures that no longer fail. */
  readonly fixed: ReadonlyArray<string>;
}

export interface JudgeOptions {
  /** True for the default `check:changed` command, which always prints a summary. */
  readonly requireSummary: boolean;
  readonly encoding: ReadonlyArray<string>;
}

/** Test failures in the baseline are tolerated; any other failed step or new failing test is not. */
export function judgeGate(
  current: GateResult,
  baseline: GateResult | null,
  exitCode: number,
  options: Partial<JudgeOptions> = {},
): GateVerdict {
  const { requireSummary = false, encoding = [] } = options;
  // A name the baseline knows is tolerated only as many times as the baseline had it, so a new
  // failure that repeats a known name is still caught.
  const newTests = current.failedTests.flatMap((test) => {
    const now = current.failureCounts[test] ?? 1;
    const before = baseline?.failureCounts[test] ?? 0;
    if (before === 0) return [test];
    return now > before ? [`${test} (fails ${now} times, the baseline had ${before})`] : [];
  });
  const otherSteps = current.failedSteps.filter((step) => !step.startsWith("test ("));
  const testStepFailed = current.failedSteps.some((step) => step.startsWith("test ("));
  // Baseline test lines alone never explain a nonzero exit: lint or typecheck may have failed
  // after them, or the run may have stopped before printing its summary.
  const unexplained = [
    ...(exitCode !== 0 && current.failedSteps.length === 0
      ? ["The gate exited nonzero without a failed step in its summary."]
      : []),
    ...(requireSummary &&
    !current.summarySeen &&
    !(current.nothingToCheck && exitCode === 0 && current.failedTests.length === 0)
      ? ["The gate log has no check:changed summary."]
      : []),
  ];
  const crashed =
    testStepFailed && current.failedTests.length === 0
      ? ["The test step failed without naming a test."]
      : [];
  const newFailures = [
    ...otherSteps,
    ...newTests,
    ...crashed,
    ...unexplained,
    ...encoding.map((finding) => `encoding: ${finding}`),
  ];
  return {
    ok: newFailures.length === 0,
    newFailures,
    fixed: (baseline?.failedTests ?? []).filter((test) => !current.failedTests.includes(test)),
  };
}

export interface GateOptions {
  readonly repo: string;
  readonly label: string;
  readonly base: string;
  readonly out: string;
  readonly baselineLog: string | undefined;
  readonly keep: boolean;
  /** Use the snapshot `snapshot create` already made, and leave it in place afterwards. */
  readonly reuse: boolean;
  /** Run in a reused snapshot even though its files differ from the checkout's. Recorded in the result. */
  readonly allowStale: boolean;
  /** The arguments for `vp`; empty means `run check:changed <base>`. */
  readonly command: ReadonlyArray<string>;
}

export function runGate(options: GateOptions): number {
  const repo = NodePath.resolve(options.repo);
  const out = NodePath.resolve(options.out);
  NodeFS.mkdirSync(out, { recursive: true });
  const snapshot = options.reuse
    ? reuseSnapshot({ repo, label: options.label })
    : createSnapshot({ repo, label: options.label, install: true });
  const checkoutTree = workingTreeId(repo);
  const snapshotCurrent = snapshot.tree === checkoutTree;
  console.log(
    `gate: snapshot ${snapshot.commit.slice(0, 10)} at ${snapshot.path} (${snapshotCurrent ? "matches the checkout" : "DIFFERS from the checkout"})`,
  );
  if (options.reuse && !snapshotCurrent && !options.allowStale) {
    console.error(
      "gate: the snapshot's files differ from the checkout's, so a pass would describe other code. Recreate the snapshot, or pass --allow-stale to gate it as it is.",
    );
    return 2;
  }
  const args =
    options.command.length > 0 ? options.command : ["run", "check:changed", options.base];
  const logPath = NodePath.join(out, "gate.log");
  const log = NodeFS.openSync(logPath, "w");
  let exitCode: number;
  let encoding: Array<string>;
  try {
    const result = NodeChildProcess.spawnSync("vp", args, {
      cwd: snapshot.path,
      stdio: ["ignore", log, log],
    });
    exitCode = result.status ?? 1;
    // Same snapshot, same base: damage added to the text of any changed file fails the gate.
    encoding = scanChangedEncoding(snapshot.path, options.base);
  } finally {
    NodeFS.closeSync(log);
    if (!options.keep && !options.reuse) removeSnapshot({ repo, label: options.label });
  }
  const current = parseGateLog(decodeLog(NodeFS.readFileSync(logPath)));
  const baseline =
    options.baselineLog === undefined
      ? null
      : parseGateLog(decodeLog(NodeFS.readFileSync(NodePath.resolve(options.baselineLog))));
  const verdict = judgeGate(current, baseline, exitCode, {
    requireSummary: options.command.length === 0,
    encoding,
  });
  NodeFS.writeFileSync(
    NodePath.join(out, "gate.json"),
    `${JSON.stringify(
      {
        commit: snapshot.commit,
        snapshotTree: snapshot.tree,
        checkoutTree,
        snapshotMatchesCheckout: snapshotCurrent,
        allowedStale: options.allowStale && !snapshotCurrent,
        checkoutTreeAfterRun: workingTreeId(repo),
        command: `vp ${args.join(" ")}`,
        exitCode,
        baselineLog: options.baselineLog ?? null,
        failedSteps: current.failedSteps,
        failedTests: current.failedTests.length,
        encodingFindings: encoding.length,
        ...verdict,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `gate: exit ${exitCode}; ${verdict.ok ? "no new failures" : `${verdict.newFailures.length} new failures`}; log ${logPath}`,
  );
  for (const failure of verdict.newFailures.slice(0, 20)) console.error(`  ${failure}`);
  return verdict.ok ? 0 : 1;
}

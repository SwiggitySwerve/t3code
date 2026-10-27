// @effect-diagnostics nodeBuiltinImport:off - the tests build real folders and git repositories.
import { expect, it } from "vite-plus/test";

import { decodeLog, judgeGate, parseGateLog } from "./gate.ts";

const log = (failedTests: ReadonlyArray<string>, failedSteps: ReadonlyArray<string>) =>
  [
    "check:changed: 4 files since abcdef",
    ...failedTests.map((test) => ` FAIL  ${test}`),
    "check:changed summary",
    "  pass  format  0.4s",
    ...failedSteps.map((step) => `  FAIL  ${step}  12.5s`),
  ].join("\n");

const BASELINE = log(["|unit| a.test.ts > one", "|unit| b.test.ts > two"], ["test (3 files)"]);

it("reads failed steps and tests, ignoring colors", () => {
  expect(parseGateLog(`\u001b[31m${BASELINE}\u001b[0m`)).toEqual({
    failedSteps: ["test (3 files)"],
    failedTests: ["|unit| a.test.ts > one", "|unit| b.test.ts > two"],
    failureCounts: { "|unit| a.test.ts > one": 1, "|unit| b.test.ts > two": 1 },
    summarySeen: true,
    nothingToCheck: false,
  });
});

it("passes when only baseline tests fail, and reports the ones that now pass", () => {
  const verdict = judgeGate(
    parseGateLog(log(["|unit| a.test.ts > one"], ["test (3 files)"])),
    parseGateLog(BASELINE),
    1,
  );
  expect(verdict).toEqual({ ok: true, newFailures: [], fixed: ["|unit| b.test.ts > two"] });
});

it("fails on a new failing test, on any other failed step, and on a crash with no summary", () => {
  const baseline = parseGateLog(BASELINE);
  expect(
    judgeGate(parseGateLog(log(["|unit| c.test.ts > three"], ["test (3 files)"])), baseline, 1)
      .newFailures,
  ).toEqual(["|unit| c.test.ts > three"]);
  expect(
    judgeGate(parseGateLog(log([], ["typecheck (2 packages)"])), baseline, 1).newFailures,
  ).toEqual(["typecheck (2 packages)"]);
  expect(judgeGate(parseGateLog("boom"), baseline, 1).newFailures).toEqual([
    "The gate exited nonzero without a failed step in its summary.",
  ]);
  expect(judgeGate(parseGateLog(log([], ["test (3 files)"])), baseline, 1).newFailures).toEqual([
    "The test step failed without naming a test.",
  ]);
});

it("passes a clean run without a baseline", () => {
  expect(judgeGate(parseGateLog(log([], [])), null, 0).ok).toBe(true);
  expect(judgeGate(parseGateLog(BASELINE), null, 1).ok).toBe(false);
});

it("decodes a UTF-16 log written by PowerShell redirection as well as UTF-8", () => {
  const text = log(["|unit| a.test.ts > one"], ["test (3 files)"]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  expect(parseGateLog(decodeLog(utf16))).toEqual(parseGateLog(decodeLog(Buffer.from(text))));
  expect(parseGateLog(decodeLog(utf16)).failedTests).toEqual(["|unit| a.test.ts > one"]);
});

it("fails on text damage a change added, even when every check passed", () => {
  const verdict = judgeGate(parseGateLog(log([], [])), null, 0, {
    encoding: ["a.ts:2: const fresh = broken;"],
  });
  expect(verdict.ok).toBe(false);
  expect(verdict.newFailures).toEqual(["encoding: a.ts:2: const fresh = broken;"]);
});

it("does not let baseline test lines explain a nonzero exit that has no summary", () => {
  // The run stopped (or lint failed) after printing test failures that are all in the baseline.
  const noSummary = [" FAIL  |unit| a.test.ts > one", " FAIL  |unit| b.test.ts > two"].join("\n");
  const verdict = judgeGate(parseGateLog(noSummary), parseGateLog(BASELINE), 1, {
    requireSummary: true,
  });
  expect(verdict.ok).toBe(false);
  expect(verdict.newFailures).toEqual([
    "The gate exited nonzero without a failed step in its summary.",
    "The gate log has no check:changed summary.",
  ]);
});

it("requires a summary from the default command, except when there was nothing to check", () => {
  const empty = parseGateLog("");
  expect(judgeGate(empty, null, 0, { requireSummary: true }).newFailures).toEqual([
    "The gate log has no check:changed summary.",
  ]);
  const nothing = parseGateLog("check:changed: no changes since abcdef012345.");
  expect(judgeGate(nothing, null, 0, { requireSummary: true }).ok).toBe(true);
  expect(judgeGate(nothing, null, 1, { requireSummary: true }).ok).toBe(false);
  // A custom command prints no summary and is only judged by its exit code and failures.
  expect(judgeGate(empty, null, 0).ok).toBe(true);
});

it("catches a new failure that repeats a name the baseline already has", () => {
  const baseline = parseGateLog(log(["|unit| a.test.ts > one"], ["test (3 files)"]));
  const twice = parseGateLog(
    log(["|unit| a.test.ts > one", "|unit| a.test.ts > one"], ["test (3 files)"]),
  );
  expect(twice.failureCounts["|unit| a.test.ts > one"]).toBe(2);
  expect(judgeGate(twice, baseline, 1).newFailures).toEqual([
    "|unit| a.test.ts > one (fails 2 times, the baseline had 1)",
  ]);
  expect(judgeGate(baseline, baseline, 1).ok).toBe(true);
});

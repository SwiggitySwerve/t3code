// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// Runs the workflow fixture browser tests with screenshots on and collects the frames.
//
//   node scripts/workflow-qa/cli.ts capture --out <dir> [--repo <checkout>] [-- <vp test args>]
//
// The tests live beside the workflow components (`*.fixtures.browser.test.tsx`) and write frames
// under `<repo>/.logs/workflow-qa/frames`. This command clears that folder first, runs the tests in
// the checkout it is given (a snapshot worktree for a candidate, never a tree others are editing),
// verifies every frame, and copies them with a manifest to `--out`. `--out` must not already hold
// files, so earlier evidence is never overwritten.
//
// An unfiltered run also checks coverage (every state in WORKFLOW_QA_EXPECTED_STATES has frames, no
// unlisted state does), that fixed-width surfaces are identical at every viewport width, and that no
// two states of a surface render alike unless one is a declared alias. The manifest records the
// counts, the states omitted on purpose, and both the photographed checkout and this tool's.
//
// Note: `WorkflowQaCapture.browser.test.tsx` (the helper's failure cases) is not a `.fixtures` file,
// so this command does not run it; run it explicitly: `vp test run --project browser WorkflowQaCapture`.
//
// A UI change adds its own surface by writing `<Surface>.fixtures.browser.test.tsx` beside its
// component and calling `captureSurface` (apps/web/test/workflow-fixtures/capture.ts); this command
// picks the file up by name and holds its frames to the same checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  coverageFields,
  findProblems,
  readFrames,
  repoFingerprint,
  writeManifest,
} from "./manifest.ts";
import { isEmptyOrMissing } from "./util.ts";

export interface CaptureOptions {
  readonly repo: string;
  /** The checkout whose scripts are running; recorded in the manifest beside the photographed `repo`. */
  readonly toolRepo: string;
  readonly out: string;
  /** Extra arguments for `vp test run`, such as a file filter. A filtered run skips the coverage check. */
  readonly testArgs: ReadonlyArray<string>;
}

export const FIXTURE_TEST_FILTER = ".fixtures.browser.test";

/** The only folder this command deletes: the frames the tests write inside the checkout. */
function clearFrames(repo: string): string {
  const logs = NodePath.join(repo, ".logs", "workflow-qa");
  const frames = NodePath.join(logs, "frames");
  if (NodePath.dirname(frames) !== logs || NodePath.basename(frames) !== "frames") {
    throw new Error(`Refusing to clear ${frames}`);
  }
  NodeFS.rmSync(frames, { recursive: true, force: true });
  NodeFS.mkdirSync(frames, { recursive: true });
  return frames;
}

export function runCapture(options: CaptureOptions): number {
  const repo = NodePath.resolve(options.repo);
  const out = NodePath.resolve(options.out);
  if (!isEmptyOrMissing(out)) {
    console.error(`capture: ${out} already holds files; choose a new --out.`);
    return 2;
  }
  const frames = clearFrames(repo);
  const args = ["test", "run", "--project", "browser", FIXTURE_TEST_FILTER, ...options.testArgs];
  const command = `vp ${args.join(" ")}`;
  const logPath = NodePath.join(repo, ".logs", "workflow-qa", "capture.log");
  const log = NodeFS.openSync(logPath, "w");
  console.log(`capture: ${command} (in ${NodePath.join(repo, "apps", "web")})`);
  const result = NodeChildProcess.spawnSync("vp", args, {
    cwd: NodePath.join(repo, "apps", "web"),
    env: { ...process.env, VITE_T3_WORKFLOW_QA: "1" },
    stdio: ["ignore", log, log],
  });
  NodeFS.closeSync(log);
  const testsPassed = result.status === 0;
  const recorded = readFrames(frames);
  // Coverage is only meaningful when every fixture file ran.
  const coverageChecked = options.testArgs.length === 0;
  const problems = findProblems(recorded, frames, { coverage: coverageChecked }).map(
    (problem) => problem.message,
  );
  if (!testsPassed) {
    problems.unshift(`The fixture tests exited with ${result.status ?? result.error?.message}.`);
  }
  NodeFS.mkdirSync(out, { recursive: true });
  for (const name of NodeFS.readdirSync(frames)) {
    NodeFS.copyFileSync(NodePath.join(frames, name), NodePath.join(out, name));
  }
  NodeFS.copyFileSync(logPath, NodePath.join(out, "capture.log"));
  writeManifest(out, {
    kind: "fixtures",
    createdAt: new Date().toISOString(),
    repo: repoFingerprint(repo),
    tool: repoFingerprint(options.toolRepo),
    command,
    frames: recorded,
    problems,
    ...coverageFields(recorded, coverageChecked),
  });
  console.log(
    `capture: ${recorded.length} frames, ${problems.length} problems. Manifest: ${NodePath.join(out, "manifest.md")}`,
  );
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  return problems.length === 0 ? 0 : 1;
}

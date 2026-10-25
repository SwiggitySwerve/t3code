// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off - hand-run CLI tooling, outside any Effect runtime.
// A candidate snapshot: the working tree as it is right now, in its own sibling worktree.
//
// Checks and the QA lane run against the snapshot, so edits others make to the main checkout
// while they run cannot change what is being verified, and nothing here formats, stages or
// rewrites a file in the checkout itself. The snapshot is a commit built with a temporary index
// seeded from the checkout's staged entries, so its index, branch and stash are untouched.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assertLabel, git as gitOutput, gitLine as git } from "./util.ts";

const SUBJECT_PREFIX = "qa snapshot ";

export interface Snapshot {
  readonly path: string;
  readonly commit: string;
  /** The git tree of the snapshot's files, comparable with `workingTreeId` of the checkout. */
  readonly tree: string;
}

/** Where the worktree for `label` lives: beside the checkout, never inside it. */
export function snapshotPath(repo: string, label: string): string {
  assertLabel("snapshot label", label);
  const root = NodePath.resolve(repo);
  return NodePath.join(NodePath.dirname(root), `${NodePath.basename(root)}-qa-${label}`);
}

/**
 * Copies the checkout's staged entries, modes included, into the index `env` points at. Seeding
 * from HEAD instead would lose a staged executable bit: where the filesystem reports none
 * (`core.filemode=false`), `git add -A` records a new file as 100644. Asking git for the entries,
 * not reading the index file, finds the right index for a linked worktree too.
 */
function seedIndexFromCheckout(repo: string, env: NodeJS.ProcessEnv): void {
  const staged = gitOutput(repo, ["--no-optional-locks", "ls-files", "--stage", "-z"]);
  if (staged === "") return;
  NodeChildProcess.execFileSync("git", ["update-index", "-z", "--index-info"], {
    cwd: repo,
    env: { ...process.env, ...env },
    input: staged,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/** Runs `use` with a throwaway git index holding the checkout's tracked and unignored untracked files. */
function withWorkingTreeIndex<T>(
  repo: string,
  use: (env: NodeJS.ProcessEnv, tree: string) => T,
): T {
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-index-"));
  const env = {
    GIT_INDEX_FILE: NodePath.join(temporary, "index"),
    GIT_AUTHOR_NAME: "workflow-qa",
    GIT_AUTHOR_EMAIL: "workflow-qa@localhost",
    GIT_COMMITTER_NAME: "workflow-qa",
    GIT_COMMITTER_EMAIL: "workflow-qa@localhost",
  };
  try {
    seedIndexFromCheckout(repo, env);
    git(repo, ["add", "-A"], env);
    return use(env, git(repo, ["write-tree"], env));
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}

/** The git tree of the checkout's files right now, without touching its index. */
export function workingTreeId(repo: string): string {
  return withWorkingTreeIndex(NodePath.resolve(repo), (_env, tree) => tree);
}

/** Commits the working tree on top of HEAD, again without touching the checkout's index. */
function snapshotCommit(repo: string, label: string): string {
  return withWorkingTreeIndex(repo, (env, tree) =>
    git(repo, ["commit-tree", tree, "-p", "HEAD", "-m", `${SUBJECT_PREFIX}${label}`], env),
  );
}

export interface CreateSnapshotOptions {
  readonly repo: string;
  readonly label: string;
  /** Install locked dependencies in the worktree; tests of this module skip it. */
  readonly install: boolean;
}

export function createSnapshot(options: CreateSnapshotOptions): Snapshot {
  const repo = NodePath.resolve(options.repo);
  const target = snapshotPath(repo, options.label);
  if (NodeFS.existsSync(target)) {
    throw new Error(`${target} already exists; remove that snapshot first.`);
  }
  const commit = snapshotCommit(repo, options.label);
  git(repo, ["worktree", "add", "--detach", target, commit]);
  if (options.install) {
    // Same install the worktree setup script runs: exactly the locked versions.
    const result = NodeChildProcess.spawnSync("vp", ["i", "--frozen-lockfile", "--", "--yes"], {
      cwd: target,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      removeSnapshot({ repo, label: options.label });
      throw new Error(`Installing dependencies in ${target} exited with ${result.status}.`);
    }
  }
  return { path: target, commit, tree: git(target, ["rev-parse", "HEAD^{tree}"]) };
}

/** The snapshot `createSnapshot` made for `label`, found again by its expected path and commit subject. */
export function reuseSnapshot(options: {
  readonly repo: string;
  readonly label: string;
}): Snapshot {
  const target = snapshotPath(options.repo, options.label);
  if (!NodeFS.existsSync(target)) throw new Error(`${target} does not exist; create it first.`);
  if (git(target, ["log", "-1", "--format=%s"]) !== `${SUBJECT_PREFIX}${options.label}`) {
    throw new Error(`${target} was not made by workflow-qa.`);
  }
  return {
    path: target,
    commit: git(target, ["rev-parse", "HEAD"]),
    tree: git(target, ["rev-parse", "HEAD^{tree}"]),
  };
}

/** Removes a snapshot worktree, but only one this module made at exactly the expected path. */
export function removeSnapshot(options: { readonly repo: string; readonly label: string }): void {
  const repo = NodePath.resolve(options.repo);
  const target = snapshotPath(repo, options.label);
  const listed = git(repo, ["worktree", "list", "--porcelain"]);
  const entry = listed
    .split("\n\n")
    .find(
      (block) => NodePath.resolve(block.split("\n")[0]?.replace(/^worktree /, "") ?? "") === target,
    );
  if (entry === undefined || !entry.includes("\ndetached")) {
    throw new Error(`${target} is not a detached worktree of ${repo}; nothing removed.`);
  }
  const subject = git(target, ["log", "-1", "--format=%s"]);
  if (subject !== `${SUBJECT_PREFIX}${options.label}`) {
    throw new Error(
      `${target} was not made by workflow-qa (commit "${subject}"); nothing removed.`,
    );
  }
  git(repo, ["worktree", "remove", "--force", target]);
  git(repo, ["worktree", "prune"]);
  // On Windows git can leave the installed dependency links behind, pointing at files it already
  // deleted. The path is this snapshot's (checked above) and no longer a worktree, so finish the job.
  NodeFS.rmSync(target, { recursive: true, force: true });
}

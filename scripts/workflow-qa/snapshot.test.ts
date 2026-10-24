// @effect-diagnostics nodeBuiltinImport:off - the tests build real folders and git repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { runGate } from "./gate.ts";
import {
  createSnapshot,
  removeSnapshot,
  reuseSnapshot,
  snapshotPath,
  workingTreeId,
} from "./snapshot.ts";

const git = (cwd: string, ...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function makeRepo(parent: string): string {
  const repo = NodePath.join(parent, "checkout");
  NodeFS.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "test");
  git(repo, "config", "user.email", "test@example.com");
  // The assertions compare file contents byte for byte; a machine-wide autocrlf would change them.
  git(repo, "config", "core.autocrlf", "false");
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "ignored.txt\n");
  NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "committed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

it("snapshots uncommitted work in a sibling worktree without touching the checkout", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-snapshot-"));
  try {
    const repo = makeRepo(parent);
    NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "edited by someone\n");
    NodeFS.writeFileSync(NodePath.join(repo, "untracked.txt"), "new work\n");
    NodeFS.writeFileSync(NodePath.join(repo, "ignored.txt"), "never snapshotted\n");
    const before = {
      head: git(repo, "rev-parse", "HEAD"),
      status: git(repo, "status", "--porcelain"),
    };

    const snapshot = createSnapshot({ repo, label: "candidate", install: false });

    expect(snapshot.path).toBe(snapshotPath(repo, "candidate"));
    expect(NodePath.dirname(snapshot.path)).toBe(parent);
    expect(NodeFS.readFileSync(NodePath.join(snapshot.path, "tracked.txt"), "utf8")).toBe(
      "edited by someone\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(snapshot.path, "untracked.txt"), "utf8")).toBe(
      "new work\n",
    );
    expect(NodeFS.existsSync(NodePath.join(snapshot.path, "ignored.txt"))).toBe(false);
    // The checkout keeps its branch, its index and its uncommitted files exactly as they were.
    expect(git(repo, "rev-parse", "HEAD")).toBe(before.head);
    expect(git(repo, "status", "--porcelain")).toBe(before.status);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
    expect(git(repo, "stash", "list")).toBe("");
    expect(() => createSnapshot({ repo, label: "candidate", install: false })).toThrow(
      /already exists/,
    );

    removeSnapshot({ repo, label: "candidate" });
    expect(NodeFS.existsSync(snapshot.path)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain("candidate");
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});

it("removes only a worktree it made, at the expected path", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-snapshot-"));
  try {
    const repo = makeRepo(parent);
    const other = snapshotPath(repo, "other");
    git(repo, "worktree", "add", "--detach", other, "HEAD");
    expect(() => removeSnapshot({ repo, label: "other" })).toThrow(/was not made by workflow-qa/);
    expect(NodeFS.existsSync(other)).toBe(true);
    expect(() => removeSnapshot({ repo, label: "never-made" })).toThrow(/not a detached worktree/);
    expect(() => snapshotPath(repo, "../escape")).toThrow(/lowercase letters/);
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});

it("tells whether a snapshot still matches the checkout, and the gate refuses one that does not", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-snapshot-"));
  try {
    const repo = makeRepo(parent);
    NodeFS.writeFileSync(NodePath.join(repo, "untracked.txt"), "new work\n");
    const snapshot = createSnapshot({ repo, label: "candidate", install: false });
    expect(snapshot.tree).toBe(workingTreeId(repo));
    expect(reuseSnapshot({ repo, label: "candidate" }).tree).toBe(snapshot.tree);

    // An untracked file is part of the tree, so editing one makes the snapshot stale.
    NodeFS.writeFileSync(NodePath.join(repo, "untracked.txt"), "changed since\n");
    expect(workingTreeId(repo)).not.toBe(snapshot.tree);
    const out = NodePath.join(parent, "gate");
    expect(
      runGate({
        repo,
        label: "candidate",
        base: "main",
        out,
        baselineLog: undefined,
        keep: false,
        reuse: true,
        allowStale: false,
        command: [],
      }),
    ).toBe(2);
    // It stopped before running anything.
    expect(NodeFS.existsSync(NodePath.join(out, "gate.json"))).toBe(false);
    removeSnapshot({ repo, label: "candidate" });
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});

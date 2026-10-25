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

/** The index file git itself uses for `cwd`, which differs from `.git/index` in a linked worktree. */
const indexFile = (cwd: string) =>
  NodePath.resolve(cwd, git(cwd, "rev-parse", "--git-path", "index"));

const blobId = (cwd: string, content: string) =>
  NodeChildProcess.execFileSync("git", ["hash-object", "--stdin"], {
    cwd,
    input: content,
    encoding: "utf8",
  }).trim();

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

it("keeps staged modes and removals when the filesystem reports no executable bit", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-snapshot-"));
  try {
    const repo = makeRepo(parent);
    NodeFS.writeFileSync(NodePath.join(repo, "gone.txt"), "removed in the index\n");
    NodeFS.writeFileSync(NodePath.join(repo, "deleted.txt"), "deleted on disk only\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more files");
    git(repo, "config", "core.filemode", "false");
    // A merge adds an executable like this: staged as 100755, then edited again without staging.
    NodeFS.writeFileSync(NodePath.join(repo, "tool.sh"), "#!/bin/sh\necho staged\n");
    git(repo, "add", "--chmod=+x", "tool.sh");
    NodeFS.writeFileSync(NodePath.join(repo, "tool.sh"), "#!/bin/sh\necho edited\n");
    git(repo, "rm", "-q", "gone.txt");
    NodeFS.rmSync(NodePath.join(repo, "deleted.txt"));
    NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "edited by someone\n");
    NodeFS.writeFileSync(NodePath.join(repo, "untracked.txt"), "new work\n");
    NodeFS.writeFileSync(NodePath.join(repo, "ignored.txt"), "never snapshotted\n");
    const indexBefore = NodeFS.readFileSync(indexFile(repo));

    const tree = workingTreeId(repo);
    const snapshot = createSnapshot({ repo, label: "candidate", install: false });

    const entry = (mode: string, path: string, content: string) =>
      `${mode} blob ${blobId(repo, content)}\t${path}`;
    const candidate = [
      entry("100644", ".gitignore", "ignored.txt\n"),
      entry("100755", "tool.sh", "#!/bin/sh\necho edited\n"),
      entry("100644", "tracked.txt", "edited by someone\n"),
      entry("100644", "untracked.txt", "new work\n"),
    ].join("\n");
    expect(git(repo, "ls-tree", "-r", tree)).toBe(candidate);
    expect(snapshot.tree).toBe(tree);
    expect(git(snapshot.path, "ls-tree", "-r", "HEAD")).toBe(candidate);
    expect(NodeFS.readFileSync(indexFile(repo)).equals(indexBefore)).toBe(true);

    // The mode is part of what the snapshot has to match, so dropping it makes the snapshot stale.
    git(repo, "update-index", "--chmod=-x", "tool.sh");
    expect(workingTreeId(repo)).not.toBe(snapshot.tree);
    removeSnapshot({ repo, label: "candidate" });
  } finally {
    NodeFS.rmSync(parent, { recursive: true, force: true });
  }
});

it("takes staged modes from a linked worktree's own index", () => {
  const parent = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-qa-snapshot-"));
  try {
    const repo = makeRepo(parent);
    git(repo, "config", "core.filemode", "false");
    const linked = NodePath.join(parent, "linked");
    git(repo, "worktree", "add", "-q", "-b", "linked", linked);
    NodeFS.writeFileSync(NodePath.join(linked, "tool.sh"), "#!/bin/sh\n");
    git(linked, "add", "--chmod=+x", "tool.sh");
    expect(indexFile(linked)).not.toBe(indexFile(repo));
    const indexes = {
      checkout: NodeFS.readFileSync(indexFile(repo)),
      linked: NodeFS.readFileSync(indexFile(linked)),
    };

    const tree = workingTreeId(linked);

    expect(git(linked, "ls-tree", tree, "tool.sh")).toBe(
      `100755 blob ${blobId(linked, "#!/bin/sh\n")}\ttool.sh`,
    );
    expect(workingTreeId(repo)).not.toBe(tree);
    expect(NodeFS.readFileSync(indexFile(repo)).equals(indexes.checkout)).toBe(true);
    expect(NodeFS.readFileSync(indexFile(linked)).equals(indexes.linked)).toBe(true);
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
